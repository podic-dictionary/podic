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
# headers 目录是可选的（Swift 壳自带 bridging.h）
HDR=()
if [ -d crates/podic-mobile/include ]; then
  HDR=(-headers crates/podic-mobile/include)
fi
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libpodic_mobile.a \
  "${HDR[@]}" \
  -library target/aarch64-apple-ios-sim/release/libpodic_mobile.a \
  -output ios/Frameworks/PodicMobile.xcframework

echo "[4/4] 资源"
mkdir -p ios/Resources/web ios/Resources/packs
rsync -a --delete dist/ ios/Resources/web/
rsync -a --delete packs/ ios/Resources/packs/ --include 'podic-*.db' --exclude '*'

echo "完成：ios/Frameworks/PodicMobile.xcframework + ios/Resources（xcodegen generate 后可构建，见 ios/README.md）"
