//! 移动端壳入口：启动完整 podic 后端（词典包查询 + AI + 静态前端）。
//! - Android: JNI `Java_com_felix021_podic_PodicNative_startServer`（Kotlin PodicNative 调用）
//! - iOS: C ABI `podic_start_server`（Swift bridging header 调用）
//! 宿主侧拿到返回的实际端口后，WebView 加载 http://127.0.0.1:{port}。

use std::path::PathBuf;
use std::sync::OnceLock;

static STARTED: OnceLock<u16> = OnceLock::new();

fn start_server(dir: String, port: i32) -> i32 {
    if let Some(p) = STARTED.get() {
        return *p as i32;
    }
    let data_dir = PathBuf::from(dir);
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
                let state = match podic_server::init_state(&data_dir) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("podic init state: {e}");
                        return;
                    }
                };
                let app = podic_server::build_router(state, &dist_dir);
                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("podic serve: {e}");
                }
            });
        })
        .ok();

    actual as i32
}

/// 启动后端，返回实际端口；已启动则幂等返回原端口，失败返回 -1。
#[no_mangle]
pub extern "C" fn Java_com_felix021_podic_PodicNative_startServer(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    data_dir: jni::objects::JString,
    port: i32,
) -> i32 {
    let dir: String = match env.get_string(&data_dir) {
        Ok(s) => s.into(),
        Err(_) => return -1,
    };
    start_server(dir, port)
}

/// C ABI（iOS 桥接）：data_dir 为 UTF-8 路径，返回实际端口，失败 -1
///
/// # Safety
/// data_dir 必须是调用方持有的合法以 NUL 结尾的 C 字符串
#[no_mangle]
pub unsafe extern "C" fn podic_start_server(data_dir: *const std::os::raw::c_char, port: i32) -> i32 {
    if data_dir.is_null() {
        return -1;
    }
    let dir = match std::ffi::CStr::from_ptr(data_dir).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => return -1,
    };
    start_server(dir, port)
}
