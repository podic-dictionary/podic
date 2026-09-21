# iOS 壳（在 Mac 上操作）

Linux 机无法编译 iOS；本目录是脚手架，**未在真机验证**。步骤：

## 1. 构建 Rust 静态库与资源（macOS）

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
brew install xcodegen
scripts/build-ios.sh   # 产出 ios/Frameworks/PodicMobile.xcframework + ios/Resources
```

## 2. 生成并打开 Xcode 工程

```bash
cd ios && xcodegen generate && open Podic.xcodeproj
```

- 真机：Signing & Capabilities 选自己的开发者账号
- 运行：App 启动后把 Bundle 里的 web/词典包拷到 Documents/data，Rust 后端监听 127.0.0.1，WKWebView 加载

## 结构

- `Sources/bridging.h` — C ABI 声明（podic_start_server），工程设置 SWIFT_OBJC_BRIDGING_HEADER 指向它
- `Sources/ViewController.swift` — 资产落地 + 起后端 + WKWebView 加载
- `Frameworks/PodicMobile.xcframework` — scripts/build-ios.sh 产出（真机 + 模拟器双架构）
- `Resources/web`、`Resources/packs` — 前端与词典包（构建脚本从 dist/、packs/ 同步）

## 注意

- ATS 已放行本地网络（NSAllowsLocalNetworking），WKWebView 可访问 http://127.0.0.1
- App Store 分发需处理 ITSAppUsesNonExemptEncryption 声明与后台上限（WKWebView + 本地 HTTP 不走网络权限）
- TTS（speechSynthesis）iOS WKWebView 支持有限，后续可加 WKScriptMessageHandler 桥 AVSpeechSynthesizer
