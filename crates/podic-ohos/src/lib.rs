//! 鸿蒙（HarmonyOS NEXT）壳入口：用 NAPI 把后端暴露给 ArkTS。
//!
//! 宿主 ArkTS 拿到实际端口后，用 ArkUI `Web` 组件加载 `http://127.0.0.1:{port}`。
//! 与 Android JNI / iOS C ABI 壳共用 `podic_server::start_background`。
//!
//! 构建产物 `libpodic_ohos.so`，ArkTS 侧 `import { startServer } from 'libpodic_ohos.so'`。

#[cfg(target_env = "ohos")]
mod ohos {
    use napi_derive_ohos::napi;

    /// 启动完整后端（词典包 + AI + 静态前端），返回实际监听端口；
    /// 已启动幂等返回原端口，失败返回 -1。ArkTS 导出名为 `startServer`。
    #[napi]
    pub fn start_server(data_dir: String, port: i32) -> i32 {
        podic_server::start_background(std::path::PathBuf::from(data_dir), port)
    }
}
