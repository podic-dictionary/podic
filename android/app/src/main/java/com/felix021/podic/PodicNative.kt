package com.felix021.podic

/// Rust 后端 JNI 入口（crates/podic-mobile 编译为 libpodic_mobile.so）
object PodicNative {
    init {
        System.loadLibrary("podic_mobile")
    }

    /** 启动完整后端（词典包 + AI + 静态前端），返回实际监听端口；已启动幂等返回，失败返回 -1 */
    external fun startServer(dataDir: String, port: Int): Int
}
