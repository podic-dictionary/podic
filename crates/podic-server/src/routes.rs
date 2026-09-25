use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, Core};
use axum::extract::{Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json};
use podic_core::ai::{prompt, AnyClient, ChatRequest, Msg};
use podic_core::settings::ProviderConfig;
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
        _ => core.packs.langs(),
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
        (
            p.manifest
                .clone()
                .unwrap_or_else(|| core.settings.manifest_url.clone()),
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

/// POST /api/packs/install：SSE 返回进度 {type: progress|done|error}
pub async fn install_pack(
    State(state): State<AppState>,
    Json(req): Json<InstallReq>,
) -> Sse<tokio_stream::wrappers::UnboundedReceiverStream<Result<Event, std::io::Error>>> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, std::io::Error>>();
    let sse_event = |v: Value| Ok(Event::default().data(v.to_string()));
    let tx2 = tx.clone();

    tokio::spawn(async move {
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
    let items = podic_core::lookup::lookup(&core.conn, &langs, &p.q, p.limit.unwrap_or(20))?;
    Ok(Json(json!({ "items": items })))
}

pub async fn suggest(
    State(state): State<AppState>,
    Query(p): Query<QueryParams>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let langs = langs_of(&core, p.langs);
    let items = podic_core::lookup::suggest(&core.conn, &langs, &p.q, p.limit.unwrap_or(8))?;
    Ok(Json(json!({ "items": items })))
}

pub async fn reverse(
    State(state): State<AppState>,
    Query(p): Query<QueryParams>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let langs = langs_of(&core, p.langs);
    let items = podic_core::lookup::reverse(&core.conn, &langs, &p.q, p.limit.unwrap_or(20))?;
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
    let items = podic_core::lookup::examples(&core.conn, &p.lang, p.id, p.limit.unwrap_or(5))?;
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
    let core = lock(&state);
    Json(json!({ "ok": true, "langs": core.packs.langs() }))
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
pub struct SettingsIn {
    providers: Vec<ProviderIn>,
    #[serde(default)]
    manifest_url: String,
}

pub async fn save_settings(
    State(state): State<AppState>,
    Json(input): Json<SettingsIn>,
) -> ApiResult<Json<Value>> {
    let mut core = lock(&state);
    let mut providers = vec![];
    for p in input.providers {
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
            p.api_key
        };
        providers.push(ProviderConfig {
            id: p.id,
            name: p.name,
            protocol,
            base_url: p.base_url,
            api_key,
            models: p.models,
            active_model: p.active_model,
            labels: p.labels,
        });
    }
    core.settings.providers = providers;
    core.settings.manifest_url = input.manifest_url;
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
}

pub async fn test_provider(
    State(state): State<AppState>,
    Json(req): Json<TestProviderReq>,
) -> ApiResult<Json<Value>> {
    let (provider, model) = {
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
