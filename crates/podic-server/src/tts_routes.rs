//! 端侧 TTS 模型分发端点：清单目录、测速、安装（SSE 进度/取消）、任务列表、删除。
//! 模型文件只落 data_dir/tts；合成与播放在原生壳（见 podic-mobile FFI 与壳 TtsManager）。

use crate::error::{ApiError, ApiResult};
use crate::routes::lock;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use axum::Json;
use podic_core::tts;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio_stream::wrappers::UnboundedReceiverStream;

/// 安装任务快照（任务列表接口返回；SSE 断开后前端靠它恢复显示）
#[derive(Clone, serde::Serialize)]
pub struct TtsTaskSnap {
    pub id: String,
    pub model_id: String,
    pub state: String, // running | done | cancelled | error
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub started_at: u64,
}

#[derive(Default)]
pub struct TtsTaskStore {
    pub tasks: Mutex<HashMap<String, TtsTaskSnap>>,
    pub installing: Mutex<std::collections::HashSet<String>>,
    pub seq: AtomicU64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sse_event(v: Value) -> Result<Event, std::io::Error> {
    Ok(Event::default().data(v.to_string()))
}

/// GET /api/tts/models：已装模型（离线可用）
pub async fn models(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let data_dir = { lock(&state).data_dir.clone() };
    Ok(Json(json!({ "models": tts::installed_models(&data_dir) })))
}

/// GET /api/tts/catalog：从当前源拉清单（语言过滤由前端做）
pub async fn catalog(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let (manifest_url, source) = {
        let core = lock(&state);
        let t = core.settings.tts.clone().unwrap_or_default();
        (tts::manifest_url_for(&t.source), t.source)
    };
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let resp = http.get(&manifest_url).send().await.map_err(|e| {
        ApiError(StatusCode::BAD_GATEWAY, format!("清单获取失败：{e}"))
    })?;
    if !resp.status().is_success() {
        return Err(ApiError(StatusCode::BAD_GATEWAY, format!("清单返回 {}", resp.status())));
    }
    let manifest: tts::TtsManifest = resp.json().await.map_err(|e| {
        ApiError(StatusCode::BAD_GATEWAY, format!("清单解析失败：{e}"))
    })?;
    Ok(Json(json!({
        "manifest_url": manifest_url,
        "source_mode": source.mode,
        "schema_version": manifest.schema_version,
        "catalog_revision": manifest.catalog_revision,
        "defaults": manifest.defaults,
        "models": manifest.models,
    })))
}

#[derive(Deserialize)]
pub struct SpeedTestIn {
    /// 待测清单地址（前端把源选择换算成清单 URL 传入；缺省用当前设置源）
    pub url: Option<String>,
}

/// POST /api/tts/speed-test：清单响应耗时（与词典源测速同语义）
pub async fn speed_test(
    State(state): State<AppState>,
    Json(input): Json<SpeedTestIn>,
) -> ApiResult<Json<Value>> {
    let url = match input.url {
        Some(u) if !u.trim().is_empty() => u,
        _ => {
            let core = lock(&state);
            let t = core.settings.tts.clone().unwrap_or_default();
            tts::manifest_url_for(&t.source)
        }
    };
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let t0 = std::time::Instant::now();
    let resp = http.get(&url).send().await;
    let ms = t0.elapsed().as_millis() as u64;
    match resp {
        Ok(r) if r.status().is_success() => Ok(Json(json!({ "ms": ms }))),
        Ok(r) => Ok(Json(json!({ "ms": ms, "error": format!("HTTP {}", r.status()) }))),
        Err(e) => Ok(Json(json!({ "ms": ms, "error": e.to_string() }))),
    }
}

#[derive(Deserialize)]
pub struct InstallIn {
    pub model_id: String,
}

/// POST /api/tts/install：SSE 进度流。任务注册在全局 store，断开 SSE 不取消下载
pub async fn install(
    State(state): State<AppState>,
    Json(input): Json<InstallIn>,
) -> ApiResult<Sse<UnboundedReceiverStream<Result<Event, std::io::Error>>>> {
    let model_id = input.model_id.trim().to_string();
    if model_id.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "model_id 必填".into()));
    }

    let (data_dir, entry) = {
        let core = lock(&state);
        let data_dir = core.data_dir.clone();
        drop(core);
        let entry = tts::TtsModelEntry {
            model_id: model_id.clone(), family: "supertonic".into(), languages: vec!["ja".into()],
            name: String::new(), version: String::new(), revision: 1, notes: String::new(),
            package: tts::TtsPackage { url: String::new(), format: "tar.bz2".into(), sha256: String::new(), size_bytes: 0, archive_root: String::new() },
            files: vec![], config: serde_json::Value::Null, voices: vec![], default_voice_id: 0, licenses: vec![],
        };
        (data_dir, entry)
    };

    // 同模型互斥
    {
        let mut g = state.tts_tasks.installing.lock().unwrap();
        if g.contains(&model_id) {
            return Err(ApiError(StatusCode::CONFLICT, "该模型的下载任务正在进行中".into()));
        }
        g.insert(model_id.clone());
    }

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let task_id = format!("tts{}", state.tts_tasks.seq.fetch_add(1, Ordering::Relaxed) + 1);
    let snap = TtsTaskSnap {
        id: task_id.clone(),
        model_id: model_id.clone(),
        state: "running".into(),
        error: None,
        started_at: now_secs(),
    };
    state.tts_tasks.tasks.lock().unwrap().insert(task_id.clone(), snap.clone());
    let _ = tx.send(sse_event(json!({ "type": "accepted", "task_id": task_id, "model_id": model_id })));

    let st = state.clone();
    let tid = task_id.clone();
    let mid = model_id.clone();
    let stop = Arc::new(AtomicBool::new(false));
    // 取消句柄登记（cancel 端点按 task_id 找）
    st.tts_cancel.lock().unwrap().insert(task_id.clone(), stop.clone());

    tokio::spawn(async move {
        let tx2 = tx.clone();
        let r = tts::install_model(&data_dir, &entry, &entry.package.url, stop.clone(), move |p| {
            let _ = tx2.send(sse_event(json!({
                "type": "progress", "task_id": tid,
                "phase": p.phase, "downloaded": p.downloaded, "total": p.total,
            })));
        })
        .await;
        let _ = tx.send(match &r {
            Ok(inst) => {
                st.tts_tasks.tasks.lock().unwrap().get_mut(&task_id).map(|s| {
                    s.state = "done".into();
                });
                sse_event(json!({ "type": "done", "task_id": task_id, "model": inst }))
            }
            Err(e) => {
                let msg = e.to_string();
                let state_name = if msg.contains("已取消") { "cancelled" } else { "error" };
                st.tts_tasks.tasks.lock().unwrap().get_mut(&task_id).map(|s| {
                    s.state = state_name.into();
                    if state_name == "error" {
                        s.error = Some(msg.clone());
                    }
                });
                sse_event(json!({ "type": state_name, "task_id": task_id, "message": msg }))
            }
        });
        st.tts_cancel.lock().unwrap().remove(&task_id);
        st.tts_tasks.installing.lock().unwrap().remove(&mid);
    });

    Ok(Sse::new(UnboundedReceiverStream::new(rx)))
}

/// GET /api/tts/tasks：当前与最近任务（页面重进恢复显示）
pub async fn tasks(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let tasks: Vec<TtsTaskSnap> = {
        let m = state.tts_tasks.tasks.lock().unwrap();
        let mut v: Vec<TtsTaskSnap> = m.values().cloned().collect();
        v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        v.truncate(20);
        v
    };
    Ok(Json(json!({ "tasks": tasks })))
}

/// POST /api/tts/tasks/{id}/cancel
pub async fn cancel_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let stop = state.tts_cancel.lock().unwrap().get(&id).cloned();
    match stop {
        Some(s) => {
            s.store(true, Ordering::Relaxed);
            Ok(Json(json!({ "ok": true })))
        }
        None => Ok(Json(json!({ "ok": false, "message": "任务不存在或已结束" }))),
    }
}

/// DELETE /api/tts/models/{model_id}：使用中返回 409 MODEL_IN_USE
pub async fn remove(
    State(state): State<AppState>,
    Path(model_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let data_dir = { lock(&state).data_dir.clone() };
    tts::remove_model(&data_dir, &model_id).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("MODEL_IN_USE") {
            ApiError(StatusCode::CONFLICT, "模型正在被朗读引擎使用，请停止朗读后再删除".into())
        } else {
            ApiError(StatusCode::NOT_FOUND, msg)
        }
    })?;
    Ok(Json(json!({ "ok": true })))
}
