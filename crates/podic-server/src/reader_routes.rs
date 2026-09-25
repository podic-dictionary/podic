//! 阅读视图路由：分词 / 文章 CRUD / 用户词典（AI 补录）/ 生词标记。
//! handler 里不得逐 token 查 SQL（N+1 长持锁）；分词一次完成，词表走 Core 缓存。

use crate::error::{ApiError, ApiResult};
use crate::routes::lock;
use crate::state::{AppState, Core};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use podic_core::store;
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_TEXT_CHARS: usize = 200_000;

fn bad(msg: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.to_string())
}

fn ensure_lang(core: &Core, lang: &str) -> Result<(), ApiError> {
    if core.packs.langs().iter().any(|l| l == lang) {
        Ok(())
    } else {
        Err(bad(&format!("语种 {lang} 未安装词典包")))
    }
}

fn check_size(text: &str) -> Result<(), ApiError> {
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(bad("文章过长（上限 20 万字符）"));
    }
    Ok(())
}

/// 分词 + 语种校验（ja 走词表缓存；en/fr 不需要词表）
fn tokenize_text(core: &mut Core, lang: &str, text: &str) -> Result<Vec<Vec<podic_core::reader::Token>>, ApiError> {
    ensure_lang(core, lang)?;
    let paragraphs = {
        let vocab = if lang == "ja" { Some(core.vocab_for(lang)) } else { None };
        podic_core::reader::tokenize(lang, text, vocab)
    };
    Ok(paragraphs)
}

fn to_json(p: &impl serde::ser::Serialize) -> Value {
    serde_json::to_value(p).unwrap_or(Value::Null)
}

// ---------------- URL 导入 ----------------

#[derive(Deserialize)]
pub struct FetchReq {
    url: String,
}

/// Readability 正文提取（公众号/原生壳渲染等多处共用）
fn extract_article_text(html: &str, url: &str) -> Result<(String, String), ApiError> {
    let mut owned = html.to_string();
    // 公众号文章正文默认 visibility:hidden（靠 JS 显示），Readability 会跳过隐藏元素，喂之前先解开
    if owned.contains(r#"id="js_content""#) {
        owned = owned.replace("visibility: hidden; opacity: 0;", "");
    }
    // Formatted：块级边界（p/section/br 等）输出换行；默认 Raw 会把全文黏成一行
    let cfg = dom_smoothie::Config {
        text_mode: dom_smoothie::TextMode::Formatted,
        ..Default::default()
    };
    let mut reader = dom_smoothie::Readability::new(owned.as_str(), Some(url), Some(cfg))
        .map_err(|e| ApiError(StatusCode::UNPROCESSABLE_ENTITY, format!("解析失败: {e}")))?;
    let article = reader
        .parse()
        .map_err(|e| ApiError(StatusCode::UNPROCESSABLE_ENTITY, format!("提取正文失败: {e}")))?;
    // 只取纯文本（阅读视图分词用）；编码按 UTF-8（公众号/主流新闻站均为 UTF-8）
    let text = article.text_content.trim().to_string();
    if text.chars().count() < 100 {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "抓不到正文：页面可能需要 JS 渲染或需要登录，请手动复制粘贴".into(),
        ));
    }
    Ok((article.title, text))
}

/// POST /api/reader/fetch：拉取网页并提取正文（Readability 算法）。
/// 服务器/手机端内嵌后端都会执行这个请求（手机上是进程内 cdylib/静态库），无跨域问题。
pub async fn fetch_article(
    State(_state): State<AppState>,
    Json(req): Json<FetchReq>,
) -> ApiResult<Json<Value>> {
    let url = req.url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(bad("只支持 http/https 链接"));
    }
    let parsed = url.parse::<reqwest::Url>().map_err(|_| bad("链接格式不对"))?;
    if parsed.host_str().is_none() {
        return Err(bad("链接缺少主机名"));
    }

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, format!("HTTP 客户端初始化失败: {e}")))?;
    let resp = http
        .get(parsed)
        .header("accept", "text/html,application/xhtml+xml")
        .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, format!("抓取失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(ApiError(StatusCode::BAD_GATEWAY, format!("页面返回 {}", resp.status())));
    }
    // 微信风控会把非客户端访问 302 到 wappoc 环境校验页（先取最终落点，bytes 会移动 resp）
    let risk_control = resp.url().path().contains("wappoc");
    // 上限 8MB（公众号富文本页可到 3-4MB），防异常大文件拖垮端上内存
    let bytes = resp.bytes().await.map_err(|e| ApiError(StatusCode::BAD_GATEWAY, format!("读取失败: {e}")))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(ApiError(StatusCode::BAD_GATEWAY, "页面过大（>8MB）".into()));
    }
    let html = String::from_utf8_lossy(&bytes).into_owned();
    // 微信风控：非客户端访问 302 到 wappoc 环境校验页（reqwest 过不去，要跑 JS）。
    // 手机 App 的原生渲染路径（WebView 执行校验 JS）通常能自动通过
    if risk_control || html.contains("wappoc_appmsgcaptcha") {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "微信风控要求环境校验，直接抓取过不去。手机 App 的原生渲染通常可自动通过；或在微信里全文复制后粘贴".into(),
        ));
    }
    let (title, text) = extract_article_text(&html, url)?;
    Ok(Json(json!({
        "title": title,
        "content": text,
        "chars": text.chars().count(),
    })))
}

#[derive(Deserialize)]
pub struct ExtractReq {
    url: String,
    /// 已渲染页面的 HTML（移动壳隐藏 WebView 渲染后回传）
    html: String,
}

/// POST /api/reader/extract：对现成 HTML 做正文提取。
/// SPA 页面在 fetch 端点拿不到正文（HTML 里没字），由移动壳原生 WebView 渲染后走这里
pub async fn extract_article(
    State(_state): State<AppState>,
    Json(req): Json<ExtractReq>,
) -> ApiResult<Json<Value>> {
    let url = req.url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(bad("只支持 http/https 链接"));
    }
    if req.html.chars().count() > 4_000_000 {
        return Err(bad("页面内容过大"));
    }
    let (title, text) = extract_article_text(&req.html, url)?;
    Ok(Json(json!({
        "title": title,
        "content": text,
        "chars": text.chars().count(),
    })))
}

// ---------------- 分词 ----------------

#[derive(Deserialize)]
pub struct TokenizeReq {
    lang: String,
    text: String,
}

/// POST /api/reader/tokenize：粘贴预览用
pub async fn tokenize(
    State(state): State<AppState>,
    Json(req): Json<TokenizeReq>,
) -> ApiResult<Json<Value>> {
    check_size(&req.text)?;
    let mut core = lock(&state);
    let paragraphs = tokenize_text(&mut core, &req.lang, &req.text)?;
    Ok(Json(json!({ "paragraphs": paragraphs })))
}

// ---------------- 文章 ----------------

#[derive(Deserialize)]
pub struct ArticleReq {
    lang: String,
    #[serde(default)]
    title: String,
    content: String,
}

fn article_payload(a: store::ArticleFull, paragraphs: Value) -> Value {
    let mut v = to_json(&a.meta);
    if let Value::Object(m) = &mut v {
        m.insert("content".into(), Value::String(a.content));
        m.insert("paragraphs".into(), paragraphs);
    }
    v
}

/// POST /api/articles：服务端 tokenize 一次，响应直接带 paragraphs（免二次请求）
pub async fn create_article(
    State(state): State<AppState>,
    Json(req): Json<ArticleReq>,
) -> ApiResult<Json<Value>> {
    check_size(&req.content)?;
    let title = req.title.trim().to_string();
    let mut core = lock(&state);
    let paragraphs = tokenize_text(&mut core, &req.lang, &req.content)?;
    let token_count: usize = paragraphs.iter().map(|p| p.len()).sum();
    let char_count = req.content.chars().count();
    let tokens_json = serde_json::to_string(&paragraphs).unwrap_or_else(|_| "[]".into());
    let id = store::insert_article(&core.conn, &req.lang, &title, &req.content, &tokens_json, char_count as i64, token_count as i64)?;
    let article = store::get_article(&core.conn, id)?.ok_or_else(|| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "文章保存失败".into()))?;
    Ok(Json(json!({ "article": article_payload(article, to_json(&paragraphs)) })))
}

/// GET /api/articles：列表绝不带 content / tokens_json
pub async fn list_articles(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    Ok(Json(json!({ "articles": store::list_articles(&core.conn)? })))
}

/// GET /api/articles/{id}：tokens_json 损坏时按当前词表懒重分词并回写
pub async fn get_article(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let mut core = lock(&state);
    let mut a = store::get_article(&core.conn, id)?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "文章不存在".into()))?;
    let (paragraphs, rewrite) = match serde_json::from_str::<Vec<Vec<podic_core::reader::Token>>>(&a.tokens_json) {
        Ok(p) => (p, None),
        Err(_) => {
            let paras = tokenize_text(&mut core, &a.meta.lang, &a.content)?;
            let tj = serde_json::to_string(&paras).unwrap_or_else(|_| "[]".into());
            (paras, Some(tj))
        }
    };
    if let Some(tj) = rewrite {
        core.conn
            .execute("UPDATE article SET tokens_json = ?1 WHERE id = ?2", rusqlite::params![tj, id])
            .map_err(podic_core::Error::Db)?;
        a.tokens_json = tj;
    }
    Ok(Json(json!({ "article": article_payload(a, to_json(&paragraphs)) })))
}

pub async fn delete_article(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    store::delete_article(&core.conn, id)?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------- 用户词典（AI 补录，词典扩充源） ----------------

/// 与词典包重复不在写入时拦（查重单点放在 lookup 合并：同 norm 包优先），写入保持幂等
#[derive(Deserialize)]
pub struct UserDictReq {
    lang: String,
    headword: String,
    #[serde(default)]
    reading: Option<String>,
    #[serde(default)]
    pos: Option<Vec<String>>,
    senses: Value,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    model: Option<String>,
    /// 点词时的 surface norm（屈折形镜像，供下次直接命中）
    #[serde(default)]
    alt_norm: Option<String>,
    /// 生成该词条的 ai_cache key（done 事件下发）；删词条时连带清缓存
    #[serde(default)]
    cache_key: Option<String>,
}

/// GET /api/user-dict?lang=&q=
pub async fn list_user_dict(
    State(state): State<AppState>,
    Query(p): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let core = lock(&state);
    let entries = store::list_user_dict(&core.conn, p.get("lang").map(|s| s.as_str()), p.get("q").map(|s| s.as_str()).unwrap_or(""))?;
    Ok(Json(json!({ "entries": entries })))
}

/// POST /api/user-dict：upsert 幂等
pub async fn save_user_dict(
    State(state): State<AppState>,
    Json(req): Json<UserDictReq>,
) -> ApiResult<Json<Value>> {
    // schema 校验：senses 必须是 [{pos:[...], zh:"..."}]，防 AI 坏输出污染 EntryCard 渲染
    let arr = req.senses.as_array().ok_or_else(|| bad("senses 必须是数组"))?;
    for s in arr {
        if !s.get("zh").and_then(|z| z.as_str()).is_some_and(|z| !z.trim().is_empty()) {
            return Err(bad("senses 每项必须含非空 zh 字段"));
        }
    }
    let senses_str = serde_json::to_string(&arr).map_err(|_| bad("senses 序列化失败"))?;
    let pos_str = match &req.pos {
        Some(v) if !v.is_empty() => Some(serde_json::to_string(v).map_err(|_| bad("pos 序列化失败"))?),
        _ => None,
    };
    if req.headword.trim().is_empty() {
        return Err(bad("headword 不能为空"));
    }
    let mut core = lock(&state);
    let (id, created) = store::user_dict_upsert(
        &core.conn,
        &req.lang,
        req.headword.trim(),
        req.reading.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        pos_str.as_deref(),
        &senses_str,
        req.source.as_deref().unwrap_or("ai"),
        req.model.as_deref(),
        req.alt_norm.as_deref(),
        req.cache_key.as_deref(),
    )?;
    core.invalidate_vocab(&req.lang);
    Ok(Json(json!({ "id": id, "created": created })))
}

/// DELETE /api/user-dict/{id}
pub async fn delete_user_dict(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let mut core = lock(&state);
    let entry = store::user_dict_get(&core.conn, id)?;
    store::delete_user_dict(&core.conn, id)?;
    if let Some(e) = entry {
        core.invalidate_vocab(&e.lang);
        // 连带清掉生成它的 AI 缓存：否则删掉的坏词条下次点词会原样复活
        if let Some(k) = e.cache_key {
            let _ = store::ai_cache_delete(&core.conn, &k);
        }
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------------- 生词/认识标记（键 = token 的 surface norm） ----------------

/// GET /api/word-status?lang=xx：全量（表小），返回 {norm: status} 映射
pub async fn list_word_status(
    State(state): State<AppState>,
    Query(p): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let lang = p.get("lang").cloned().ok_or_else(|| bad("缺少 lang"))?;
    let core = lock(&state);
    let mut statuses = serde_json::Map::new();
    for (norm, status) in store::word_status_list(&core.conn, &lang)? {
        statuses.insert(norm, Value::String(status));
    }
    Ok(Json(json!({ "statuses": Value::Object(statuses) })))
}

#[derive(Deserialize)]
pub struct WordStatusReq {
    lang: String,
    norm: String,
    /// known | new | none（none = 清除标记）
    status: String,
}

/// POST /api/word-status
pub async fn set_word_status(
    State(state): State<AppState>,
    Json(req): Json<WordStatusReq>,
) -> ApiResult<Json<Value>> {
    let status = match req.status.as_str() {
        "known" | "new" => Some(req.status.as_str()),
        "none" => None,
        _ => return Err(bad("status 只能是 known / new / none")),
    };
    if req.norm.is_empty() {
        return Err(bad("norm 不能为空"));
    }
    let core = lock(&state);
    store::word_status_set(&core.conn, &req.lang, &req.norm, status)?;
    Ok(Json(json!({ "ok": true })))
}
