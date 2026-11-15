//! 移动端壳入口：启动完整 podic 后端（词典包查询 + AI + 静态前端）。
//! - Android: JNI `Java_com_felix021_podic_PodicNative_startServer`（Kotlin PodicNative 调用）
//! - iOS: C ABI `podic_start_server`（Swift bridging header 调用）
//! 宿主侧拿到返回的实际端口后，WebView 加载 http://127.0.0.1:{port}。
//!
//! 启动逻辑统一在 `podic_server::start_background`，鸿蒙壳（podic-ohos）也复用同一入口。

use std::ffi::CStr;
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
    let path = std::path::PathBuf::from(&dir);
    let _ = TTS_DATA_DIR.set(path.clone());
    podic_server::start_background(path, port)
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
    let path = std::path::PathBuf::from(&dir);
    let _ = TTS_DATA_DIR.set(path.clone());
    podic_server::start_background(path, port)
}

/// C ABI（iOS 桥接）：强制重启后端（健康探测失败时壳调用），
/// 返回新端口（优先复用原端口），从未启动过/失败返回 -1
#[no_mangle]
pub extern "C" fn podic_restart_server() -> i32 {
    podic_server::restart_background()
}

/// C ABI（iOS 桥接）：服务线程是否存活（初始化失败/serve 退出后 false）
#[no_mangle]
pub extern "C" fn podic_server_alive() -> i32 {
    podic_server::server_alive() as i32
}

/// C ABI（iOS/Android 桥）：取已装模型的版本目录（壳加载引擎用）。
/// 返回 UTF-8 C 字符串（调用方 podic_tts_free_path 释放），未安装返回 NULL
#[no_mangle]
pub unsafe extern "C" fn podic_tts_model_path(model_id: *const std::os::raw::c_char) -> *mut std::os::raw::c_char {
    let dir = match tts_data_dir() {
        Some(d) => d,
        None => return std::ptr::null_mut(),
    };
    let id = match CStr::from_ptr(model_id).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    match podic_server::tts_model_path(&dir, id) {
        Some(p) => {
            let c = std::ffi::CString::new(p.to_string_lossy().into_owned()).unwrap_or_default();
            c.into_raw()
        }
        None => std::ptr::null_mut(),
    }
}

/// 释放 podic_tts_model_path 返回的字符串
#[no_mangle]
pub unsafe extern "C" fn podic_tts_free_path(p: *mut std::os::raw::c_char) {
    if !p.is_null() {
        drop(std::ffi::CString::from_raw(p));
    }
}

/// C ABI：模型使用引用（壳加载引擎前 +1，卸载后 -1；删除模型时引用>0 拒绝）
#[no_mangle]
pub extern "C" fn podic_tts_acquire(model_id: *const std::os::raw::c_char) -> i32 {
    match unsafe { CStr::from_ptr(model_id) }.to_str() {
        Ok(id) => podic_core::tts::acquire(id) as i32,
        Err(_) => -1,
    }
}

#[no_mangle]
pub extern "C" fn podic_tts_release(model_id: *const std::os::raw::c_char) -> i32 {
    match unsafe { CStr::from_ptr(model_id) }.to_str() {
        Ok(id) => podic_core::tts::release(id) as i32,
        Err(_) => -1,
    }
}

/// JNI（Android 壳）：取已装模型的版本目录，未安装返回 null
#[no_mangle]
pub extern "C" fn Java_com_felix021_podic_PodicNative_ttsModelPath(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    model_id: jni::objects::JString,
) -> jni::sys::jstring {
    let Ok(id) = env.get_string(&model_id).map(|s| s.to_string_lossy().into_owned()) else {
        return std::ptr::null_mut();
    };
    let Some(dir) = tts_data_dir() else {
        return std::ptr::null_mut();
    };
    match podic_server::tts_model_path(&dir, &id) {
        Some(p) => match env.new_string(p.to_string_lossy().into_owned()) {
            Ok(s) => s.as_raw(),
            Err(_) => std::ptr::null_mut(),
        },
        None => std::ptr::null_mut(),
    }
}

fn jni_model_id(env: &mut jni::JNIEnv, model_id: &jni::objects::JString) -> Option<String> {
    env.get_string(model_id).ok().map(|s| s.to_string_lossy().into_owned())
}

/// JNI：模型使用引用 +1（壳加载引擎前调用；删除模型时引用>0 后端拒绝）
#[no_mangle]
pub extern "C" fn Java_com_felix021_podic_PodicNative_ttsAcquire(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    model_id: jni::objects::JString,
) -> i32 {
    match jni_model_id(&mut env, &model_id) {
        Some(id) => podic_core::tts::acquire(&id) as i32,
        None => -1,
    }
}

/// JNI：模型使用引用 -1（壳卸载引擎后调用）
#[no_mangle]
pub extern "C" fn Java_com_felix021_podic_PodicNative_ttsRelease(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    model_id: jni::objects::JString,
) -> i32 {
    match jni_model_id(&mut env, &model_id) {
        Some(id) => podic_core::tts::release(&id) as i32,
        None => -1,
    }
}

/// 服务端 data_dir 的进程级记录（FFI 拿不到 AppState，start_server 时写入）
static TTS_DATA_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

fn tts_data_dir() -> Option<std::path::PathBuf> {
    TTS_DATA_DIR.get().cloned()
}
