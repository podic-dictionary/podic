#!/usr/bin/env bash
# iOS 依赖产物构建（仅 macOS 可跑）：podic-mobile 静态库 -> XCFramework + 前端/词典包资源包
# 用法: scripts/build-ios.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(uname)" != "Darwin" ]; then
  echo "本脚本只能在 macOS 上运行（需要 Xcode + rustup iOS target）"; exit 1
fi

rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

echo "[1/4] 前端构建"
npx vite build

echo "[2/4] Rust 静态库（真机 + 模拟器）"
# Rust 链接 iOS target 必须显式给对应 SDK，否则用宿主 macOS SDK 链接报错
SDKROOT="$(xcrun --sdk iphoneos --show-sdk-path)" \
  cargo build --release -p podic-mobile --target aarch64-apple-ios
SDKROOT="$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  cargo build --release -p podic-mobile --target aarch64-apple-ios-sim

echo "[3/4] XCFramework"
rm -rf ios/Frameworks
mkdir -p ios/Frameworks
# headers 不需要（Swift 壳自带 bridging.h）；注意 macOS 自带 bash 3.2 的 set -u 下
# 空数组展开报 unbound，别用可选参数数组
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libpodic_mobile.a \
  -library target/aarch64-apple-ios-sim/release/libpodic_mobile.a \
  -output ios/Frameworks/PodicMobile.xcframework

echo "[4/4] 资源"
mkdir -p ios/Resources/web ios/Resources/packs
rsync -a --delete dist/ ios/Resources/web/
# 只带最新版英文词典。不用 rsync --exclude --delete：exclude 会保护接收侧旧文件
# 不被删（en/fr/ja 历史包全残留进 bundle，App Store 显示 706MB 的根因），rm+cp 确定性重建
LATEST_EN=$(ls packs/en-dict-*.db | sort -V | tail -1 | xargs basename)
rm -rf ios/Resources/packs && mkdir -p ios/Resources/packs
cp "packs/$LATEST_EN" ios/Resources/packs/

echo "完成：ios/Frameworks/PodicMobile.xcframework + ios/Resources（xcodegen generate 后可构建，见 ios/README.md）"
