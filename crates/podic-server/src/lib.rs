//! podic-server 库入口：装配 AppState / 路由，供桌面 bin 与移动端壳（podic-mobile）复用。

pub mod error;
pub mod reader_routes;
pub mod routes;
pub mod state;

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
            Err(e) => eprintln!("ja 分词词表预热失败（将懒构建）: {e}"),
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
        .route("/api/ai/run", axum::routing::post(routes::ai_run))
        .route("/api/ai/cancel", axum::routing::post(routes::ai_cancel))
        .route("/api/ai/overlay", axum::routing::get(routes::get_overlay).post(routes::save_overlay).delete(routes::delete_overlay))
        .route("/api/reader/tokenize", axum::routing::post(reader_routes::tokenize))
        .route("/api/reader/fetch", axum::routing::post(reader_routes::fetch_article))
        .route("/api/reader/extract", axum::routing::post(reader_routes::extract_article))
        .route("/api/articles", axum::routing::get(reader_routes::list_articles).post(reader_routes::create_article))
        .route("/api/articles/{id}", axum::routing::get(reader_routes::get_article).delete(reader_routes::delete_article))
        .route("/api/user-dict", axum::routing::get(reader_routes::list_user_dict).post(reader_routes::save_user_dict))
        .route("/api/user-dict/{id}", axum::routing::delete(reader_routes::delete_user_dict))
        .route("/api/word-status", axum::routing::get(reader_routes::list_word_status).post(reader_routes::set_word_status))
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024 * 1024))
        .with_state(state)
        .fallback_service(tower_http::services::ServeDir::new(dist_dir))
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

/// 在后台线程启动完整后端（静态前端取自 `data_dir/web`），返回实际监听端口。
///
/// - `port <= 0` 时由内核挑空闲端口
/// - 幂等：重复调用返回首次启动的端口；绑定/启动失败返回 -1
///
/// 供移动端壳复用：Android JNI / iOS C ABI / 鸿蒙 NAPI 都据此在设备内起本地服务，
/// 宿主 WebView 再加载 `http://127.0.0.1:{port}`。
pub fn start_background(data_dir: PathBuf, port: i32) -> i32 {
    static STARTED: OnceLock<u16> = OnceLock::new();
    if let Some(p) = STARTED.get() {
        return *p as i32;
    }
    let dist_dir = data_dir.join("web");

    // 先用 std listener 绑定拿实际端口，再交给 tokio
    let addr = format!("127.0.0.1:{}", if port > 0 { port } else { 0 });
    let std_listener = match std::net::TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("podic bind {addr}: {e}");
            return -1;
        }
    };
    let actual = std_listener.local_addr().map(|a| a.port()).unwrap_or(0);
    if STARTED.set(actual).is_err() {
        return STARTED.get().map(|p| *p as i32).unwrap_or(-1);
    }

    std::thread::Builder::new()
        .name("podic-server".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("podic tokio runtime: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(std_listener) {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("podic listener: {e}");
                        return;
                    }
                };
                let state = match init_state(&data_dir) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("podic init state: {e}");
                        return;
                    }
                };
                let app = build_router(state, &dist_dir);
                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("podic serve: {e}");
                }
            });
        })
        .ok();

    actual as i32
}
