package com.felix021.podic

/// Rust 后端 JNI 入口（crates/podic-mobile 编译为 libpodic_mobile.so）
object PodicNative {
    init {
        System.loadLibrary("podic_mobile")
    }

    /** 启动完整后端（词典包 + AI + 静态前端），返回实际监听端口；已启动幂等返回，失败返回 -1 */
    external fun startServer(dataDir: String, port: Int): Int

    /** 已装 TTS 模型的版本目录（壳加载引擎用），未安装返回 null */
    external fun ttsModelPath(modelId: String): String?

    /** 模型使用引用 +1（加载引擎前调；引用>0 时后端拒绝删除模型） */
    external fun ttsAcquire(modelId: String): Int

    /** 模型使用引用 -1（卸载引擎后调） */
    external fun ttsRelease(modelId: String): Int
}
