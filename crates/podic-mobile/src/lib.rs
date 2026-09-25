//! 移动端壳入口：启动完整 podic 后端（词典包查询 + AI + 静态前端）。
//! - Android: JNI `Java_com_felix021_podic_PodicNative_startServer`（Kotlin PodicNative 调用）
//! - iOS: C ABI `podic_start_server`（Swift bridging header 调用）
//! 宿主侧拿到返回的实际端口后，WebView 加载 http://127.0.0.1:{port}。
//!
//! 启动逻辑统一在 `podic_server::start_background`，鸿蒙壳（podic-ohos）也复用同一入口。

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
    podic_server::start_background(std::path::PathBuf::from(dir), port)
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
    podic_server::start_background(std::path::PathBuf::from(dir), port)
}
