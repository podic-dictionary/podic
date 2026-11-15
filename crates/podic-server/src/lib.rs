//! podic-server 库入口：装配 AppState / 路由，供桌面 bin 与移动端壳（podic-mobile）复用。

pub mod daily_routes;
mod tts_routes;
pub mod error;
pub mod log;
pub mod reader_routes;
pub mod routes;
pub mod state;
pub mod vocab_routes;

pub use state::{AppState, Core};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// 初始化数据目录并装配 AppState（打开 app.db、挂载词典包、读设置）
pub fn init_state(data_dir: &Path) -> Result<AppState, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(data_dir)?;

    let conn = rusqlite::Connection::open(data_dir.join("app.db"))?;
    podic_core::store::init_app_db(&conn)?;

    let mut packs = podic_core::packs::PackManager::new(data_dir.join("packs"))?;
    let attached = packs.scan_and_attach(&conn)?;

    for p in &attached {
        println!("已挂载词典包: {} {} ({} 词条)", p.lang, p.version, p.entry_count);
    }

    // ja 分词词表预热（UNION ~0.5s）：放进启动时，避免首篇 ja 文章保存时全局长持锁
    let mut reader_vocab = HashMap::new();
    if packs.langs().iter().any(|l| l == "ja") {
        match podic_core::reader::build_vocab(&conn, "ja") {
            Ok(v) => {
                reader_vocab.insert("ja".to_string(), v);
            }
            Err(e) => plog!("ja 分词词表预热失败（将懒构建）: {e}"),
        }
    }

    let core = Core {
        conn,
        packs,
        settings: podic_core::settings::Settings::load(&data_dir.join("settings.json"))?,
        data_dir: data_dir.to_path_buf(),
        reader_vocab,
    };
    Ok(AppState {
        core: Arc::new(Mutex::new(core)),
        ai_tasks: Arc::new(Mutex::new(HashMap::new())),
        task_seq: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        daily_domains: Arc::new(Mutex::new(HashMap::new())),
        tts_tasks: Arc::new(crate::tts_routes::TtsTaskStore::default()),
        tts_cancel: Arc::new(Mutex::new(HashMap::new())),
    })
}

/// 组装完整路由：/api/* + 静态前端（dist_dir 不存在时仅 API 可用）
pub fn build_router(state: AppState, dist_dir: &Path) -> axum::Router {
    axum::Router::new()
        .route("/api/health", axum::routing::get(routes::health))
        .route("/api/packs", axum::routing::get(routes::list_packs))
        .route("/api/packs/import", axum::routing::post(routes::import_pack))
        .route("/api/packs/{lang}", axum::routing::delete(routes::remove_pack))
        .route("/api/packs/updates", axum::routing::get(routes::check_updates))
        .route("/api/packs/catalog", axum::routing::get(routes::packs_catalog))
        .route("/api/packs/speed-test", axum::routing::get(routes::speed_test))
        .route("/api/packs/install", axum::routing::post(routes::install_pack))
        .route("/api/lookup", axum::routing::get(routes::lookup))
        .route("/api/suggest", axum::routing::get(routes::suggest))
        .route("/api/reverse", axum::routing::get(routes::reverse))
        .route("/api/examples", axum::routing::get(routes::examples))
        .route("/api/attributions", axum::routing::get(routes::attributions))
        .route("/api/settings", axum::routing::get(routes::get_settings).post(routes::save_settings))
        .route("/api/settings/test-provider", axum::routing::post(routes::test_provider))
        .route("/api/favorites", axum::routing::get(routes::list_favorites).post(routes::add_favorite))
        .route("/api/favorites/{id}", axum::routing::delete(routes::remove_favorite))
        .route(
            "/api/favorites/{id}/review",
            // 练习判分只收小 JSON：独立小上限，不继承全局 1GiB（超大请求会在
            // 拿全局锁前就完成读取与解析，吃内存拖住服务）
            axum::routing::post(routes::review_favorite).layer(axum::extract::DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/api/ai/run", axum::routing::post(routes::ai_run))
        .route("/api/ai/cancel", axum::routing::post(routes::ai_cancel))
        .route("/api/ai/overlay", axum::routing::get(routes::get_overlay).post(routes::save_overlay).delete(routes::delete_overlay))
        .route("/api/reader/tokenize", axum::routing::post(reader_routes::tokenize))
        .route("/api/reader/fetch", axum::routing::post(reader_routes::fetch_article))
        .route("/api/reader/extract", axum::routing::post(reader_routes::extract_article))
        .route("/api/articles", axum::routing::get(reader_routes::list_articles).post(reader_routes::create_article))
        .route("/api/articles/{id}", axum::routing::get(reader_routes::get_article).delete(reader_routes::delete_article).put(reader_routes::update_article))
        .route("/api/user-dict", axum::routing::get(reader_routes::list_user_dict).post(reader_routes::save_user_dict))
        .route("/api/user-dict/{id}", axum::routing::delete(reader_routes::delete_user_dict))
        .route("/api/word-status", axum::routing::get(reader_routes::list_word_status).post(reader_routes::set_word_status))
        .route(
            "/api/vocab-tests",
            axum::routing::get(vocab_routes::list_vocab_tests).post(vocab_routes::create_vocab_test),
        )
        .route("/api/vocab-tests/{id}/finish", axum::routing::post(vocab_routes::finish_vocab_test))
        .route("/api/daily-sentence", axum::routing::post(daily_routes::daily_sentence))
        .route("/api/tts/models", axum::routing::get(tts_routes::models))
        .route("/api/tts/catalog", axum::routing::get(tts_routes::catalog))
        .route("/api/tts/speed-test", axum::routing::post(tts_routes::speed_test))
        .route("/api/tts/install", axum::routing::post(tts_routes::install))
        .route("/api/tts/tasks", axum::routing::get(tts_routes::tasks))
        .route("/api/tts/tasks/{id}/cancel", axum::routing::post(tts_routes::cancel_task))
        .route("/api/tts/models/{model_id}", axum::routing::delete(tts_routes::remove))
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024 * 1024))
        .with_state(state)
        .fallback_service(tower_http::services::ServeDir::new(dist_dir))
        // 请求日志（打到 logcat）：真机卡死排查时，最后一个无响应的请求直接指向卡点；
        // 慢请求（>1s）单独标注。axum 的 layer 只覆盖在它之前注册的路由，必须在链尾
        .layer(axum::middleware::from_fn(
            |req: axum::extract::Request, next: axum::middleware::Next| async move {
                let m = req.method().clone();
                let p = req.uri().path().to_string();
                let t = std::time::Instant::now();
                let res = next.run(req).await;
                let ms = t.elapsed().as_millis();
                if p != "/api/health" { // 探活会刷屏
                    if ms > 1000 {
                        plog!("[podic-http] SLOW {m} {p} {ms}ms");
                    } else {
                        plog!("[podic-http] {m} {p} {ms}ms");
                    }
                }
                res
            },
        ))
}

/// 绑定地址并运行到永久（桌面 bin 入口）
pub async fn serve(addr: &str, data_dir: PathBuf, dist_dir: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let state = init_state(&data_dir)?;
    let app = build_router(state, &dist_dir);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("podic server listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// 服务实例：线程存活即在跑。iOS 挂起/恢复后 listener 可能被系统回收
/// （TN2277），axum::serve 又不会因 accept 错误退出——服务死了旧实现也
/// 只会返回陈旧端口（OnceLock），宿主从此永远连不上。这里把一次性端口
/// 改成可管理实例：壳可以查询存活、强制重启，重启优先复用原端口
struct ServerInstance {
    port: u16,
    generation: u32,
    data_dir: PathBuf,
    thread: std::thread::JoinHandle<()>,
    shutdown: tokio::sync::watch::Sender<bool>,
}

static SERVER: std::sync::Mutex<Option<ServerInstance>> = std::sync::Mutex::new(None);
static GENERATION: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 服务线程是否还在跑（初始化失败/serve 退出后为 false）
pub fn server_alive() -> bool {
    SERVER
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| !s.thread.is_finished())
}

/// 在后台线程启动完整后端（静态前端取自 `data_dir/web`），返回实际监听端口。
///
/// - `port <= 0` 时由内核挑空闲端口
/// - 幂等且自愈：已存活直接返回其端口；实例死了（初始化失败/serve 退出）
///   用记录的 data_dir 重启，优先复用原端口；绑定/启动失败返回 -1
///
/// 供移动端壳复用：Android JNI / iOS C ABI / 鸿蒙 NAPI 都据此在设备内起本地服务，
/// 宿主 WebView 再加载 `http://127.0.0.1:{port}`。
pub fn start_background(data_dir: PathBuf, port: i32) -> i32 {
    let mut guard = SERVER.lock().unwrap();
    if let Some(inst) = guard.as_ref() {
        if !inst.thread.is_finished() {
            return inst.port as i32;
        }
    }
    // 实例死了：重启优先复用原端口（同 origin 保住 WebView 的 localStorage），
    // 原端口仍被旧线程占着（极端卡死场景）时由 spawn_server 兜底换端口
    let prefer = guard.as_ref().map(|s| s.port as i32).unwrap_or(port);
    let data_dir = guard.as_ref().map(|s| s.data_dir.clone()).unwrap_or(data_dir);
    spawn_server(&mut guard, data_dir, prefer)
}

/// 强制重启（健康探测失败时壳调用）：先优雅停旧实例，短暂等待后无论是否
/// 退出都起新实例——卡死的旧线程无法安全强杀，其端口占着就换端口，
/// WebView 重载新 origin 即可
pub fn restart_background() -> i32 {
    let mut guard = SERVER.lock().unwrap();
    let (port, data_dir) = match guard.take() {
        Some(inst) => {
            let _ = inst.shutdown.send(true);
            let inst_port = inst.port;
            let dir = inst.data_dir;
            // 优雅停机窗口：serve 循环响应 shutdown 信号需要让出时间；等不到就放弃
            for _ in 0..16 {
                if inst.thread.is_finished() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            (inst_port as i32, dir)
        }
        None => return -1,
    };
    spawn_server(&mut guard, data_dir, port)
}

/// 绑定 + 起线程 + 记录实例。prefer 端口绑不上时让内核挑空闲端口
fn spawn_server(
    guard: &mut std::sync::MutexGuard<'static, Option<ServerInstance>>,
    data_dir: PathBuf,
    prefer: i32,
) -> i32 {
    let dist_dir = data_dir.join("web");
    let addr = format!("127.0.0.1:{}", if prefer > 0 { prefer } else { 0 });
    let std_listener = match std::net::TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(_) if prefer > 0 => {
            // 原端口被占（旧实例未退/端口被系统回收给别处）：换随机端口
            match std::net::TcpListener::bind("127.0.0.1:0") {
                Ok(l) => l,
                Err(e) => {
                    plog!("podic bind fallback: {e}");
                    return -1;
                }
            }
        }
        Err(e) => {
            plog!("podic bind {addr}: {e}");
            return -1;
        }
    };
    // 交给 tokio 前必须置非阻塞（tokio 文档明确要求）。漏设时 iOS 上 accept 到的
    // 连接也会继承阻塞标志（BSD accept 不补设 O_NONBLOCK，Android accept4 会），
    // 慢连接的阻塞 I/O 可占住仅有的 2 个 worker，整个后端永久失去响应——
    // 锁屏/后台恢复后「每日一句永久 Load failed」的根因
    if let Err(e) = std_listener.set_nonblocking(true) {
        plog!("podic set_nonblocking: {e}");
        return -1;
    }
    let actual = std_listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;

    let data_dir_for_thread = data_dir.clone();
    let thread = match std::thread::Builder::new()
        .name("podic-server".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(r) => r,
                Err(e) => {
                    plog!("podic tokio runtime: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(std_listener) {
                    Ok(l) => l,
                    Err(e) => {
                        plog!("podic listener: {e}");
                        return;
                    }
                };
                let state = match init_state(&data_dir_for_thread) {
                    Ok(s) => s,
                    Err(e) => {
                        plog!("podic init state: {e}");
                        return;
                    }
                };
                let app = build_router(state, &dist_dir);
                plog!("podic serve g{generation} on 127.0.0.1:{actual}");
                let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
                    while shutdown_rx.changed().await.is_ok() {
                        if *shutdown_rx.borrow() {
                            break;
                        }
                    }
                });
                if let Err(e) = serve.await {
                    plog!("podic serve: {e}");
                }
            });
        })
    {
        Ok(t) => t,
        Err(e) => {
            plog!("podic spawn thread: {e}");
            return -1;
        }
    };

    **guard = Some(ServerInstance {
        port: actual,
        generation,
        data_dir,
        thread,
        shutdown: shutdown_tx,
    });
    actual as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 空临时目录起服务 → 幂等返回同端口；重启拿到可用端口且存活；
    /// 旧端口在优雅停机后让出（同端口复用）
    #[test]
    fn start_idempotent_and_restart_recovers() {
        let dir = std::env::temp_dir().join(format!("podic-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p1 = start_background(dir.clone(), 0);
        assert!(p1 > 0, "首次启动应返回端口");
        assert!(server_alive());
        let p2 = start_background(dir.clone(), 0);
        assert_eq!(p1, p2, "存活时重复调用应幂等返回原端口");
        // 等 serve 就绪再重启，避免初始化竞态
        std::thread::sleep(std::time::Duration::from_millis(500));
        let p3 = restart_background();
        assert!(p3 > 0, "重启应返回可用端口");
        assert!(server_alive());
        // 旧实例优雅停机后原端口应可复用（TN2277 场景壳依赖同端口恢复保住 origin）
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(p3, p1, "重启应复用原端口");
    }
}

/// 已装模型的版本目录（podic-mobile FFI 用）
pub fn tts_model_path(data_dir: &std::path::Path, model_id: &str) -> Option<std::path::PathBuf> {
    podic_core::tts::installed_models(data_dir)
        .into_iter()
        .find(|m| m.model_id == model_id)
        .map(|m| std::path::PathBuf::from(m.path))
}
