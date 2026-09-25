# 鸿蒙壳（HarmonyOS NEXT）

同一套后端（podic-server：词典包查询、AI、静态前端）跑在设备本地，ArkUI `Web` 组件加载 `127.0.0.1`。

## 架构

```
┌─ App 进程（.hap）──────────────────────────┐
│ ArkUI Web ──src──> http://127.0.0.1:p      │
│    │                                        │
│ ArkTS startServer(dataDir, 0)               │
│    └─> libpodic_ohos.so (NAPI, 同一线程)     │
│          └─> podic-server::start_background │
│               + build_router (axum)         │
└─────────────────────────────────────────────┘
```

- `crates/podic-server/src/lib.rs::start_background`：三个移动壳（Android / iOS / 鸿蒙）共用的后台启动入口
- `crates/podic-ohos`：cdylib，用 NAPI（`napi-ohos` / `napi-derive-ohos`）把 `startServer` 暴露给 ArkTS
- `crates/podic-mobile`：Android JNI + iOS C ABI
- 前端 `dist/` 与词典包打进 HAP 的 `resources/rawfile`，首启/升级拷到沙箱（packs 缺才装，绝不覆盖用户数据）

## 目录

```
harmony/
├── AppScope/                     应用级配置与图标
├── entry/                        主模块（Stage 模型）
│   ├── libs/arm64-v8a/           构建脚本产出的 libpodic_ohos.so（gitignore）
│   └── src/main/
│       ├── ets/entryability/     EntryAbility
│       ├── ets/pages/Index.ets   Web 组件 + 资产落地 + 返回键
│       ├── cpp/types/            libpodic_ohos.so 的 .d.ts 声明
│       └── resources/rawfile/    web/ 与 packs/（构建脚本填充，gitignore）
└── build-profile.json5 / hvigorfile.ts / oh-package.json5
```

## 环境准备（Linux）

1. **Rust target**（已可用，rustup 提供预编译 std）：

   ```bash
   rustup target add aarch64-unknown-linux-ohos
   ```

2. **OpenHarmony Public SDK（linux）**：到 OpenHarmony release-notes 页下载
   *Public SDK package for the standard system*（`ohos-sdk-*.zip`），解出 `linux/` 目录
   （内含 `native/llvm`、`native/sysroot`，以及 NAPI 运行库 `libace_napi.z.so`）。
   这是 Rust 交叉编译所需的 clang + sysroot。

3. **DevEco Studio**（含 HarmonyOS SDK）用于签名、打包 `.hap/.app`、真机部署。
   Linux 下用 OpenHarmony 的 DevEco Studio Linux 版，或用命令行 `hvigorw` + `hdc`。

4. **配置仓** `~/.config/podic/env.sh`（可用 `PODIC_CONFIG_DIR` 重定向）加：

   ```bash
   export PODIC_OHOS_SDK=/path/to/ohos-sdk/linux   # 内含 native/
   # 可选：DevEco 安装目录（含 tools/hvigor/bin/hvigorw）
   export PODIC_DEVECO_HOME=/path/to/DevEco-Studio
   ```

## 构建

```bash
scripts/build-harmony.sh              # assembleHap（调试用）
scripts/build-harmony.sh assembleApp  # 上架用 .app
```

脚本流程：`vite build` → `cargo build -p podic-ohos --target aarch64-unknown-linux-ohos`
→ 拷 `.so` 到 `harmony/entry/libs/arm64-v8a/`、资源到 `rawfile/` → `hvigorw` 打包。
签名在 DevEco Studio 里配（`build-profile.json5` 的 `signingConfigs`）。

首次需在 DevEco Studio 打开 `harmony/` 生成 `hvigorw` 包装与 `oh_modules`。

部署调试：`hdc install -r <hap>`；`hdc rport tcp:18787 tcp:8787` 可从本机直接访问设备内后端。

## 与 Android/iOS 的差异

- **桥**：Android 用 JNI、iOS 用 C ABI，鸿蒙用 NAPI（`#[napi]` 自动生成模块注册）。
- **前端返回键**：前端已有 `window.PodicAndroid.setCanGoBack` / `__podicGoBack`，鸿蒙侧用
  `javaScriptProxy` 注册同名方法的 `PodicHarmony` 对象对接（见 `src/App.tsx`）。
- **资源**：Android 用 `assets`、iOS 用 Bundle，鸿蒙用 `resources/rawfile`，落地策略一致。

## 待真机验证（诚实清单）

脚手架**尚未在真机验证**，以下点最可能需要微调：

- `resourceManager.getRawFileList` 是否区分目录/文件；若只返回文件，`copyRawDir` 的
  递归判断需要改为「按构建期文件清单拷贝」。
- `getRawFileDescriptor` 的 fd 能否直接用于 `fs.copyFileSync` 拷大文件（1GB 级词典包）。
- HarmonyOS NEXT 的 Web 组件访问 `http://127.0.0.1`（明文）是否还需网络策略声明；
  可能要在 `module.json5` 增加网络安全配置。
- `compatibleSdkVersion` 当前写 `5.0.0(12)`，需按本机 HarmonyOS SDK 版本对齐。
- 朗读（TTS）：Web 组件无 `speechSynthesis`，与 Android 一样暂不可用，后续可加 AVPlayer/TTS 桥。

## 备选方案

- **手写 NAPI 胶水**：只暴露一个同步函数，可直接 `extern "C"` 声明
  `napi_module_register` / `napi_create_function` 等，配 `ctor` 注册，零第三方依赖；
  当前选用 `napi-ohos` 是为了走社区标准、降低 ABI 出错概率。
- **`ohrs` CLI**：`cargo install cargo-ohrs` 后 `ohrs build`，可替代脚本里的
  `cargo build` + 手写 clang wrapper（会读同一个 `OHOS_NDK_HOME`）。
