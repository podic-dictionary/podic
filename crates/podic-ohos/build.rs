fn main() {
    // 只有 target_env=ohos 时才会真正输出链接参数（链接 libace_napi.z）；
    // 其他目标内部会跳过，宿主构建不受影响。
    napi_build_ohos::setup();
}
