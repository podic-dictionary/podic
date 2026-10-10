use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, Core};
use axum::extract::{Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json};
use podic_core::ai::{prompt, AnyClient, ChatRequest, Msg};
use podic_core::settings::{Protocol, ProviderConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio_stream::wrappers::{ReceiverStream, UnboundedReceiverStream};

fn langs_of(core: &Core, langs: Option<String>) -> Vec<String> {
    match langs {
        Some(s) if !s.is_empty() => s.split(',').map(|x| x.trim().to_string()).collect(),
        // 默认查注册语言（含无包语言——它们靠 user_dict/LLM 补全），不再只看已装包
        _ => core.settings.languages.iter().map(|l| l.code.clone()).collect(),
    }
}

pub(crate) fn lock(state: &AppState) -> std::sync::MutexGuard<'_, Core> {
    state.core.lock().unwrap()
}

// ---------------- 词典包 ----------------

pub async fn list_packs(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    Ok(Json(json!({ "packs": core.packs.list() })))
}

pub async fn import_pack(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let mut bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?
    {
        if field.name() == Some("file") {
            bytes = Some(
                field
                    .bytes()
                    .await
                    .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?
                    .to_vec(),
            );
            break;
        }
    }
    let bytes = bytes.ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "缺少 file 字段".into()))?;
    let mut core = lock(&state);
    let Core { conn, packs, .. } = &mut *core;
    let info = packs.import(conn, &bytes)?;
    core.invalidate_vocab(&info.lang);
    Ok(Json(json!(info)))
}

pub async fn remove_pack(
    State(state): State<AppState>,
    Path(lang): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut core = lock(&state);
    let Core { conn, packs, .. } = &mut *core;
    packs.remove(conn, &lang)?;
    core.invalidate_vocab(&lang);
    Ok(Json(json!({ "ok": true })))
}

// ---------------- 在线更新 ----------------

#[derive(Deserialize)]
pub struct UpdateParams {
    #[serde(default)]
    manifest: Option<String>,
}

pub async fn check_updates(
    State(state): State<AppState>,
    Query(p): Query<UpdateParams>,
) -> ApiResult<Json<Value>> {
    let (url, installed) = {
        let core = lock(&state);
        let configured = core.settings.manifest_url.trim();
        (
            p.manifest
                .clone()
                .unwrap_or_else(|| {
                    if configured.is_empty() {
                        podic_core::settings::DEFAULT_MANIFEST_URL.to_string()
                    } else {
                        configured.to_string()
                    }
                }),
            core.packs.list(),
        )
    };
    let updates = podic_core::update::check_updates(&url, &installed).await?;
    Ok(Json(json!({ "updates": updates })))
}

#[derive(Deserialize)]
pub struct InstallReq {
    lang: String,
    url: String,
    #[serde(default)]
    sha256: String,
}

/// GET /api/packs/speed-test?url=<更新源基地址>：拉一次 manifest.json 测延迟（帮用户选源）
pub async fn speed_test(
    Query(p): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let Some(base) = p.get("url") else {
        return Err(bad_req("缺少 url 参数"));
    };
    let base = base.trim().trim_end_matches('/');
    let full = if base.ends_with(".json") {
        base.to_string()
    } else {
        format!("{base}/manifest.json")
    };
    let t0 = std::time::Instant::now();
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| ApiError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match http.get(&full).send().await {
        Ok(r) if r.status().is_success() => {
            let _ = r.bytes().await;
            Ok(Json(json!({ "ms": t0.elapsed().as_millis() as u64 })))
        }
        Ok(r) => Err(ApiError(
            axum::http::StatusCode::BAD_GATEWAY,
            format!("源不可用: HTTP {}", r.status()),
        )),
        Err(e) => Err(ApiError(axum::http::StatusCode::BAD_GATEWAY, format!("连接失败: {e}"))),
    }
}
/// metainfo 基地址模式拉 {base}/manifest.json（发布脚本保证与各语言 metainfo 同步），
/// 旧式 manifest 直链原样使用
pub async fn packs_catalog(
    State(state): State<AppState>,
    Query(p): Query<UpdateParams>,
) -> ApiResult<Json<Value>> {
    let (url, installed) = {
        let core = lock(&state);
        let configured = core.settings.manifest_url.trim();
        (
            p.manifest.clone().unwrap_or_else(|| {
                if configured.is_empty() {
                    podic_core::settings::DEFAULT_MANIFEST_URL.to_string()
                } else {
                    configured.to_string()
                }
            }),
            core.packs.list(),
        )
    };
    let full = if url.ends_with(".json") {
        url
    } else {
        format!("{}/manifest.json", url.trim_end_matches('/'))
    };
    let http = reqwest::Client::new();
    let resp = http.get(&full).send().await.map_err(|e| {
        ApiError(axum::http::StatusCode::BAD_GATEWAY, format!("获取词典目录失败: {e}"))
    })?;
    if !resp.status().is_success() {
        return Err(ApiError(
            axum::http::StatusCode::BAD_GATEWAY,
            format!("获取词典目录失败: {}", resp.status()),
        ));
    }
    let body = resp.text().await.map_err(|e| {
        ApiError(axum::http::StatusCode::BAD_GATEWAY, format!("获取词典目录失败: {e}"))
    })?;
    let manifest: Value = serde_json::from_str(&body)
        .map_err(|e| ApiError(axum::http::StatusCode::BAD_GATEWAY, format!("词典目录解析失败: {e}")))?;

    let base = match full.rsplit_once('/') {
        Some((b, _)) => format!("{b}/"),
        None => String::new(),
    };
    let mut out = vec![];
    if let Some(packs) = manifest["packs"].as_array() {
        for p in packs {
            let lang = p["lang"].as_str().unwrap_or_default().to_string();
            let installed_version = installed
                .iter()
                .find(|i| i.lang == lang)
                .map(|i| i.version.clone());
            let mut item = p.clone();
            item["installed_version"] = match &installed_version {
                Some(v) => json!(v),
                None => Value::Null,
            };
            // 下载直链：无显式 url 时按清单所在目录拼
            if item.get("url").and_then(|u| u.as_str()).unwrap_or("").is_empty() {
                if let Some(file) = p["file"].as_str() {
                    item["url"] = json!(format!("{base}{file}"));
                }
            }
            out.push(item);
        }
    }
    Ok(Json(json!({ "catalog": out })))
}

/// 同语言并发安装互斥表：两个任务共用 update-{lang}.db.part 临时文件，
/// 先完成的会把它 rename 走，后完成的在校验时报 ENOENT（实测复现）。
/// Vec::new 是 const fn，HashSet 不是，static 里只能用 Vec
static INSTALLING: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

struct InstallGuard(String);
impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.lock().unwrap().retain(|l| l != &self.0);
    }
}

/// POST /api/packs/install：SSE 返回进度 {type: progress|done|error}
pub async fn install_pack(
    State(state): State<AppState>,
    Json(req): Json<InstallReq>,
) -> Sse<tokio_stream::wrappers::UnboundedReceiverStream<Result<Event, std::io::Error>>> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, std::io::Error>>();
    let sse_event = |v: Value| Ok(Event::default().data(v.to_string()));
    let tx2 = tx.clone();

    tokio::spawn(async move {
        {
            let mut g = INSTALLING.lock().unwrap();
            if g.contains(&req.lang) {
                let _ = tx.send(sse_event(json!({
                    "type": "error",
                    "message": format!("「{}」的安装任务正在进行中，请等待完成", req.lang),
                })));
                return;
            }
            g.push(req.lang.clone());
        }
        let _guard = InstallGuard(req.lang.clone());

        let packs_dir = {
            let core = lock(&state);
            core.packs.packs_dir().to_path_buf()
        };
        let tmp = packs_dir.join(format!("update-{}.db.part", req.lang));
        let stop = Arc::new(AtomicBool::new(false));

        let r = podic_core::update::download_and_verify(&req.url, &req.sha256, &tmp, stop, move |p| {
            let _ = tx2.send(sse_event(json!({
                "type": "progress",
                "phase": p.phase,
                "downloaded": p.downloaded,
                "total": p.total,
            })));
        })
        .await;

        match r {
            Ok(_) => {
                let mut core = lock(&state);
                let Core { conn, packs, .. } = &mut *core;
                match podic_core::packs::validate(&tmp) {
                    Ok((info, _lang)) => {
                        let dest = packs_dir.join(format!("{}-{}.db", info.pack_id, info.version));
                        let renamed = std::fs::rename(&tmp, &dest).map_err(podic_core::Error::Io);
                        match renamed.and_then(|_| packs.attach(conn, &dest)) {
                            Ok(info) => {
                                core.invalidate_vocab(&info.lang);
                                let _ = tx.send(sse_event(json!({ "type": "done", "pack": info })));
                            }
                            Err(e) => {
                                let _ = std::fs::remove_file(&dest);
                                let _ = tx.send(sse_event(json!({ "type": "error", "message": e.to_string() })));
                            }
                        }
                    }
                    Err(e) => {
                        let _ = std::fs::remove_file(&tmp);
                        let _ = tx.send(sse_event(json!({ "type": "error", "message": e.to_string() })));
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(sse_event(json!({ "type": "error", "message": e.to_string() })));
            }
        }
    });

    Sse::new(tokio_stream::wrappers::UnboundedReceiverStream::new(rx))
}

// ---------------- 查询 ----------------

#[derive(Deserialize)]
pub struct QueryParams {
    q: String,
    #[serde(default)]
    langs: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

pub async fn lookup(
    State(state): State<AppState>,
    Query(p): Query<QueryParams>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let langs = langs_of(&core, p.langs);
    let installed = core.packs.langs();
    let items = podic_core::lookup::lookup(&core.conn, &installed, &langs, &p.q, p.limit.unwrap_or(20))?;
    Ok(Json(json!({ "items": items })))
}

pub async fn suggest(
    State(state): State<AppState>,
    Query(p): Query<QueryParams>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let langs = langs_of(&core, p.langs);
    let installed = core.packs.langs();
    let items = podic_core::lookup::suggest(&core.conn, &installed, &langs, &p.q, p.limit.unwrap_or(8))?;
    Ok(Json(json!({ "items": items })))
}

pub async fn reverse(
    State(state): State<AppState>,
    Query(p): Query<QueryParams>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let langs = langs_of(&core, p.langs);
    let installed = core.packs.langs();
    let items = podic_core::lookup::reverse(&core.conn, &installed, &langs, &p.q, p.limit.unwrap_or(20))?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct ExampleParams {
    lang: String,
    id: i64,
    #[serde(default)]
    limit: Option<usize>,
}

pub async fn examples(
    State(state): State<AppState>,
    Query(p): Query<ExampleParams>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let installed = core.packs.langs();
    let items = podic_core::lookup::examples(&core.conn, &installed, &p.lang, p.id, p.limit.unwrap_or(5))?;
    Ok(Json(json!({ "items": items })))
}

pub async fn attributions(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let mut sources: Vec<(String, Value)> = vec![];
    for pack in core.packs.list() {
        if let Ok(list) = serde_json::from_value::<Vec<HashMap<String, Value>>>(pack.sources.clone()) {
            for s in list {
                let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                sources.push((name, json!(s)));
            }
        }
    }
    sources.sort_by(|a, b| a.0.cmp(&b.0));
    sources.dedup_by(|a, b| a.0 == b.0);
    Ok(Json(
        json!({ "sources": sources.into_iter().map(|(_, s)| s).collect::<Vec<_>>() }),
    ))
}

pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    // 诊断端点：try_lock 探测全局锁是否被长期持有（持锁方卡死时这里能立刻看出来，
    // 而不是跟着一起挂）。锁空闲 = 正常返回 langs
    match state.core.try_lock() {
        Ok(core) => Json(json!({ "ok": true, "langs": core.packs.langs() })),
        Err(_) => Json(json!({ "ok": true, "core_locked": true })),
    }
}

// ---------------- 设置（api_key 不回传浏览器） ----------------

#[derive(Serialize)]
struct ProviderView {
    id: String,
    name: String,
    protocol: String,
    base_url: String,
    models: Vec<String>,
    active_model: String,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    labels: std::collections::BTreeMap<String, String>,
    has_key: bool,
}

pub async fn get_settings(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let providers = core
        .settings
        .providers
        .iter()
        .map(|p| {
            ProviderView {
                id: p.id.clone(),
                name: p.name.clone(),
                protocol: serde_json::to_value(p.protocol)
                    .unwrap_or(json!("openai"))
                    .as_str()
                    .unwrap_or("openai")
                    .to_string(),
                base_url: p.base_url.clone(),
                models: p.models.clone(),
                active_model: p.active_model.clone(),
                labels: p.labels.clone(),
                has_key: !p.api_key.is_empty(),
            }
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "providers": providers,
        "manifest_url": core.settings.manifest_url,
        "languages": core.settings.languages,
    })))
}

#[derive(Deserialize)]
pub struct ProviderIn {
    id: String,
    name: String,
    protocol: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    models: Vec<String>,
    #[serde(default)]
    active_model: String,
    #[serde(default)]
    labels: std::collections::BTreeMap<String, String>,
}

#[derive(Deserialize)]
pub struct LanguageIn {
    code: String,
    name: String,
    #[serde(default)]
    short: Option<String>,
}

#[derive(Deserialize)]
pub struct SettingsIn {
    /// 三组字段互相独立：None = 保留现值。按字段提交避免「保存语言把另一端
    /// 刚保存的 Provider 恢复成旧快照」的跨端覆盖
    #[serde(default)]
    providers: Option<Vec<ProviderIn>>,
    #[serde(default)]
    manifest_url: Option<String>,
    #[serde(default)]
    languages: Option<Vec<LanguageIn>>,
}

fn bad_req(msg: &str) -> ApiError {
    ApiError(axum::http::StatusCode::BAD_REQUEST, msg.to_string())
}

/// languages 替换校验：非空（至少一种语言）、码合法唯一、禁 SQL 保留名与 UI 特殊值、名称非空
fn validate_languages(langs: &[LanguageIn]) -> Result<Vec<podic_core::settings::LanguageConfig>, ApiError> {
    if langs.is_empty() {
        return Err(bad_req("至少保留一种语言"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(langs.len());
    for l in langs {
        let code = l.code.trim().to_string();
        let name = l.name.trim().to_string();
        if !podic_core::settings::valid_lang_code(&code) {
            return Err(bad_req(&format!("语言码 {code:?} 不合法（2-4 位小写字母）")));
        }
        // schema 名加引号可支持 SQL 关键字码（如 is），但 main/temp 是 SQLite 保留库名，auto 与翻译视图冲突
        if matches!(code.as_str(), "main" | "temp" | "auto") {
            return Err(bad_req(&format!("语言码 {code:?} 是保留名")));
        }
        if name.is_empty() {
            return Err(bad_req(&format!("语言 {code:?} 缺少显示名")));
        }
        if !seen.insert(code.clone()) {
            return Err(bad_req(&format!("语言码 {code:?} 重复")));
        }
        let short = l.short.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        out.push(podic_core::settings::LanguageConfig { code, name, short });
    }
    Ok(out)
}

pub async fn save_settings(
    State(state): State<AppState>,
    Json(input): Json<SettingsIn>,
) -> ApiResult<Json<Value>> {
    let mut core = lock(&state);
    // 先构造并校验完整候选：非法 languages 返回 400 时内存不能已被改了一半
    let mut candidate = core.settings.clone();
    if let Some(pins) = &input.providers {
        let mut providers = vec![];
        for p in pins {
            let protocol = match p.protocol.as_str() {
                "anthropic" => podic_core::settings::Protocol::Anthropic,
                _ => podic_core::settings::Protocol::OpenAi,
            };
            // api_key 为空/掩码时保留旧 key
            let old_key = core
                .settings
                .providers
                .iter()
                .find(|o| o.id == p.id)
                .map(|o| o.api_key.clone())
                .unwrap_or_default();
            let api_key = if p.api_key.is_empty() || p.api_key.contains('•') {
                old_key
            } else {
                p.api_key.clone()
            };
            providers.push(ProviderConfig {
                id: p.id.clone(),
                name: p.name.clone(),
                protocol,
                base_url: p.base_url.clone(),
                api_key,
                models: p.models.clone(),
                active_model: p.active_model.clone(),
                labels: p.labels.clone(),
            });
        }
        candidate.providers = providers;
    }
    if let Some(u) = &input.manifest_url {
        candidate.manifest_url = u.clone();
    }
    if let Some(langs) = &input.languages {
        candidate.languages = validate_languages(langs)?;
    }
    core.settings = candidate;
    core.save_settings()?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------- 生词本 ----------------

pub async fn list_favorites(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let items = podic_core::store::list_favorites(&core.conn)?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct FavoriteIn {
    lang: String,
    headword: String,
    norm: String,
    #[serde(default)]
    snapshot: Option<Value>,
}

pub async fn add_favorite(
    State(state): State<AppState>,
    Json(f): Json<FavoriteIn>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let snapshot = f.snapshot.and_then(|v| serde_json::to_string(&v).ok());
    let id = podic_core::store::add_favorite(&core.conn, &f.lang, &f.headword, &f.norm, snapshot.as_deref())?;
    Ok(Json(json!({ "id": id })))
}

pub async fn remove_favorite(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    podic_core::store::remove_favorite(&core.conn, id)?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------- AI ----------------

#[derive(Deserialize)]
pub struct AiRunReq {
    /// explain | examples | translate | fallback | complete | analyze
    pub task: String,
    pub text: String,
    #[serde(default)]
    pub context: Option<Value>,
    pub provider_id: String,
    #[serde(default)]
    pub model: Option<String>,
    /// 显式重新生成：绕过缓存，生成后覆盖旧缓存
    #[serde(default)]
    pub fresh: bool,
}

pub async fn ai_run(
    State(state): State<AppState>,
    Json(req): Json<AiRunReq>,
) -> ApiResult<Sse<UnboundedReceiverStream<Result<Event, std::io::Error>>>> {
    // 取 provider 配置（clone 出锁外使用）
    let (provider, task_id) = {
        let core = lock(&state);
        let p = core
            .settings
            .providers
            .iter()
            .find(|p| p.id == req.provider_id)
            .cloned()
            .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, format!("找不到 Provider {}", req.provider_id)))?;
        let seq = state
            .task_seq
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let task_id = format!("ai-{}-{}", std::process::id(), seq);
        (p, task_id)
    };

    let model = req
        .model
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| provider.active_model.clone());
    if model.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "该 Provider 未配置模型".into()));
    }

    let p = prompt::build(&req.task, &req.text, req.context.as_ref());
    let chat = ChatRequest {
        model: model.clone(),
        system: Some(p.system),
        messages: vec![Msg { role: "user".into(), content: p.user }],
        max_tokens: p.max_tokens,
        temperature: p.temperature,
    };

    // 缓存键（含词条上下文）
    let mut hasher = Sha256::new();
    hasher.update(req.task.as_bytes());
    hasher.update([0]);
    hasher.update(model.as_bytes());
    hasher.update([0]);
    hasher.update(req.text.as_bytes());
    hasher.update([0]);
    hasher.update(req.context.as_ref().map(|c| c.to_string()).unwrap_or_default().as_bytes());
    let cache_key = format!("{:x}", hasher.finalize());

    let cached = if req.fresh {
        None
    } else {
        let core = lock(&state);
        podic_core::store::ai_cache_get(&core.conn, &cache_key)
    };

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, std::io::Error>>();
    let stop = Arc::new(AtomicBool::new(false));
    state
        .ai_tasks
        .lock()
        .unwrap()
        .insert(task_id.clone(), stop.clone());

    let sse_event = |v: Value| Ok(Event::default().data(v.to_string()));

    tokio::spawn(async move {
        let _ = tx.send(sse_event(json!({ "type": "start", "task_id": task_id })));

        if let Some(content) = cached {
            let _ = tx.send(sse_event(json!({ "type": "delta", "text": content })));
            // cache_key 随 done 下发：入库类任务（AI 词典）存下来，删词条时连带清缓存
            let _ = tx.send(sse_event(json!({ "type": "done", "cached": true, "cache_key": cache_key })));
            return;
        }

        let client = match AnyClient::new(&provider) {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(sse_event(json!({ "type": "error", "message": e.to_string() })));
                return;
            }
        };

        let mut full = String::new();
        let tx2 = tx.clone();
        let mut on_delta = |delta: &str| {
            full.push_str(delta);
            let _ = tx2.send(sse_event(json!({ "type": "delta", "text": delta })));
        };

        match client.stream(&chat, stop, &mut on_delta).await {
            Ok(outcome) => {
                // 空结果不进缓存（如被 thinking 吃掉 token 的失败响应）
                if !full.trim().is_empty() {
                    let core = lock(&state);
                    let _ = podic_core::store::ai_cache_put(&core.conn, &cache_key, &req.task, &model, &full);
                }
                let _ = tx.send(sse_event(json!({
                        "type": "done",
                        "usage": { "input": outcome.usage.input, "output": outcome.usage.output },
                        "cache_key": cache_key
                    })));
            }
            Err(e) => {
                // 取消不算错误，静默结束
                let msg = e.to_string();
                if !msg.contains("已取消") {
                    let _ = tx.send(sse_event(json!({ "type": "error", "message": msg })));
                } else {
                    let _ = tx.send(sse_event(json!({ "type": "done", "cancelled": true })));
                }
            }
        }
        state.ai_tasks.lock().unwrap().remove(&task_id);
    });

    Ok(Sse::new(UnboundedReceiverStream::new(rx)))
}

#[derive(Deserialize)]
pub struct AiCancelReq {
    pub task_id: String,
}

pub async fn ai_cancel(
    State(state): State<AppState>,
    Json(req): Json<AiCancelReq>,
) -> ApiResult<Json<Value>> {
    if let Some(stop) = state.ai_tasks.lock().unwrap().get(&req.task_id) {
        stop.store(true, Ordering::Relaxed);
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct TestProviderReq {
    pub provider_id: String,
    #[serde(default)]
    pub model: Option<String>,
    /// 表单草稿覆盖（测试用当前输入值，不必先保存）：非空时覆盖已存配置。
    /// api_key 为掩码/空时不覆盖——用已存 key 测
    #[serde(default)]
    pub draft: Option<TestDraft>,
}

#[derive(Deserialize)]
pub struct TestDraft {
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

pub async fn test_provider(
    State(state): State<AppState>,
    Json(req): Json<TestProviderReq>,
) -> ApiResult<Json<Value>> {
    let (mut provider, model) = {
        let core = lock(&state);
        let p = core
            .settings
            .providers
            .iter()
            .find(|p| p.id == req.provider_id)
            .cloned()
            .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, "找不到 Provider".into()))?;
        let m = req
            .model
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| p.active_model.clone());
        (p, m)
    };
    // 表单草稿优先（未保存的修改也能测）；key 只在明确重输时覆盖（掩码/空=用已存的）
    if let Some(d) = &req.draft {
        if let Some(proto) = &d.protocol {
            // serde 枚举小写字符串解析（"openai"/"anthropic"）
            if let Ok(p) = serde_json::from_str::<Protocol>(&serde_json::to_string(proto).unwrap_or_default()) {
                provider.protocol = p;
            }
        }
        if let Some(u) = &d.base_url {
            if !u.is_empty() { provider.base_url = u.clone(); }
        }
        if let Some(k) = &d.api_key {
            if !k.is_empty() && !k.contains('•') { provider.api_key = k.clone(); }
        }
    }
    let chat = ChatRequest {
        model,
        system: None,
        messages: vec![Msg { role: "user".into(), content: "ping".into() }],
        max_tokens: 8,
        temperature: 0.0,
    };
    let start = std::time::Instant::now();
    let client = match AnyClient::new(&provider) {
        Ok(c) => c,
        Err(e) => return Ok(Json(json!({ "ok": false, "error": e.to_string() }))),
    };
    let stop = Arc::new(AtomicBool::new(false));
    match client.stream(&chat, stop, &mut |_| {}).await {
        Ok(_) => Ok(Json(json!({ "ok": true, "latency_ms": start.elapsed().as_millis() }))),
        Err(e) => Ok(Json(json!({ "ok": false, "error": e.to_string() }))),
    }
}

// ---------------- AI 生成内容叠加（按词条持久化） ----------------

#[derive(Deserialize)]
pub struct OverlayQuery {
    pub lang: String,
    pub headword: String,
}

#[derive(Deserialize)]
pub struct OverlaySaveReq {
    pub lang: String,
    pub headword: String,
    /// explain | examples | fallback
    pub kind: String,
    pub content: String,
    #[serde(default)]
    pub model: String,
}

pub async fn get_overlay(
    State(state): State<AppState>,
    Query(p): Query<OverlayQuery>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let rows = podic_core::store::overlay_get_all(&core.conn, &p.lang, &p.headword)?;
    let mut overlays = serde_json::Map::new();
    for (kind, content, created_at) in rows {
        overlays.insert(
            kind,
            json!({ "content": content, "created_at": created_at }),
        );
    }
    Ok(Json(json!({ "overlays": overlays })))
}

#[derive(Deserialize)]
pub struct OverlayDeleteReq {
    pub lang: String,
    pub headword: String,
    pub kind: String,
}

pub async fn delete_overlay(
    State(state): State<AppState>,
    Query(req): Query<OverlayDeleteReq>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    podic_core::store::overlay_delete(&core.conn, &req.lang, &req.headword, &req.kind)?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn save_overlay(
    State(state): State<AppState>,
    Json(req): Json<OverlaySaveReq>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    podic_core::store::overlay_put(
        &core.conn,
        &req.lang,
        &req.headword,
        &req.kind,
        &req.model,
        &req.content,
    )?;
    Ok(Json(json!({ "ok": true })))
}
