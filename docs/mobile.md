# 移动端壳

同一套后端（podic-server 全部能力：词典包查询、AI、静态前端）跑在设备本地，WebView 加载 127.0.0.1。

## 架构

```
┌─ App 进程 ──────────────────────────────┐
│ WebView ──loadUrl──> http://127.0.0.1:p │
│    │                                    │
│ PodicNative.startServer(dataDir, 8787)  │
│    └─> crates/podic-mobile (jni/C ABI)  │
│          └─> podic-server::init_state   │
│               + build_router (axum)     │
└─────────────────────────────────────────┘
```

- `crates/podic-server/src/lib.rs`：`init_state` / `build_router` / `serve` / `start_background`，桌面 bin 与移动壳共用
- `crates/podic-mobile`：cdylib（Android JNI）+ staticlib（iOS C ABI `podic_start_server`），后台线程起 tokio，返回实际端口
- `crates/podic-ohos`：cdylib（鸿蒙 NAPI `#[napi] startServer`），复用同一 `start_background`，详见 [docs/harmony.md](harmony.md)
- 前端 `dist/` 与词典包随包分发：首启/升级拷到 `filesDir/data`（packs 缺才装，绝不覆盖用户数据）

## Android

```bash
scripts/build-android.sh [debug|release]
# 产物 android/app/build/outputs/apk/<type>/app-*.apk
adb install -r <apk> && adb forward tcp:18787 tcp:8787  # 可从本机直接访问设备内后端
```

- 签名/SDK 路径：配置仓 `~/.config/podic/env.sh`（`PODIC_CONFIG_DIR` 可重定向；显式环境变量优先）
- ABI：arm64-v8a（真机）+ x86_64（模拟器）
- 踩坑记录：aapt2 会把 assets 里的 `*.gz` 去后缀透明解压（与 `.db` 同名即 Duplicate），词典包统一放 `.db` 由 aapt2 压缩；WebView 忽略自身 padding，系统栏 inset 要加在父容器上
- 已知限制：WebView 无 speechSynthesis，朗读按钮不可用（后续可加 TTS 桥）；模拟器 x86_64 路径未实测

## iOS（Mac 遥控构建，全链路已通）

本机只改代码；构建/签名/上传在远程 Mac（`ssh <your-mac-host>`）的 rig `~/code/podic-ios-build` 完成：

```bash
# 同步 rig（排除依赖与产物；Mac 侧首次需 cd code/podic-ios-build && pnpm install）
rsync -a --delete --rsync-path="/usr/bin/rsync" \
  --exclude node_modules --exclude target --exclude .git --exclude dist \
  --exclude ios/Frameworks --exclude ios/Resources --exclude ios/build \
  --exclude android/app/build --exclude podic-data --exclude data \
  ~/code/podic/ <your-mac-host>:code/podic-ios-build/
# 全链路：构建 -> xcodegen -> archive -> export(云签名) -> 上传 TestFlight
ssh <your-mac-host> 'cd code/podic-ios-build && scripts/release-ios.sh'
# 只出 ipa 不上传：加 --skip-upload；build 号：PODIC_IOS_BUILD=N
```

- ASC 凭据：配置仓 env.sh（PODIC_ASC_KEY_ID / PODIC_ASC_ISSUER_ID / PODIC_IOS_TEAM_ID）
- 签名：Apple Distribution（Team <your-team-id>），私钥在 Mac 的 `cosmo-build.keychain`
  （密码在配置仓 env.sh；xcodebuild -allowProvisioningUpdates 自动配 profile）
- 踩坑记录：Rust 编 iOS target 必须显式 SDKROOT（iphoneos/iphonesimulator）；XcodeGen
  的 resources 段会**静默忽略** `type: folder`（folder reference 要写进 sources 段 +
  `buildPhase: resources`）；静态库 xcframework 勿 embed（.a 进 bundle App Store 拒审）；
  ASC 校验要求 1024 App 图标（90022）与 UISupportedInterfaceOrientations（90474）；
  ssh 无头签名要先解锁 keychain 并 set-key-partition-list 放行 codesign

## 鸿蒙（HarmonyOS NEXT）

同一 `start_background` + ArkUI `Web` 组件加载 `127.0.0.1`，Rust 侧用 NAPI（`napi-ohos`）暴露
`startServer`。工程在 `harmony/`，构建 `scripts/build-harmony.sh`。完整环境准备、构建步骤与
待真机验证清单见 [docs/harmony.md](harmony.md)。
