/**
 * podic-ohos（Rust NAPI）导出的 ArkTS 接口。
 * 与 crates/podic-ohos/src/lib.rs 的 #[napi] start_server 对应。
 */

/** 启动完整后端（词典包 + AI + 静态前端），返回实际监听端口；已启动幂等返回原端口，失败 -1。port 传 0 由内核挑空闲端口。 */
export const startServer: (dataDir: string, port: number) => number;
