#!/usr/bin/env bash
# Android 构建串联：前端 -> Rust .so -> 资产 -> gradle APK/AAB
# 用法: scripts/build-android.sh [debug|release|bundle]（bundle=签名的 release AAB，上架用）
# 签名/SDK 来自配置仓（PODIC_CONFIG_DIR，默认 ~/.config/podic/env.sh）
set -euo pipefail
cd "$(dirname "$0")/.."

BUILD_TYPE="${1:-debug}"
case "$BUILD_TYPE" in
  bundle) GRADLE_TASK=bundleRelease; OUT_DIR=app/build/outputs/bundle/release ;;
  # dev = debug 变体的显式别名：包名 com.felix021.podic.dev + 桌面名 Podic Dev，可与正式版共存
  dev) GRADLE_TASK=assembleDebug; OUT_DIR=app/build/outputs/apk/debug ;;
  debug|release) GRADLE_TASK="assemble${BUILD_TYPE^}"; OUT_DIR=app/build/outputs/apk/$BUILD_TYPE ;;
  *) echo "用法: $0 [dev|debug|release|bundle]"; exit 1 ;;
esac
export PODIC_CONFIG_DIR="${PODIC_CONFIG_DIR:-$HOME/.config/podic}"

# 填充未设置的 PODIC_* 变量（显式 env 优先）
if [ -f "$PODIC_CONFIG_DIR/env.sh" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$PODIC_CONFIG_DIR/env.sh"
  set +a
fi
: "${PODIC_ANDROID_HOME:?缺 PODIC_ANDROID_HOME（配置仓 env.sh）}"
: "${PODIC_NDK_HOME:?缺 PODIC_NDK_HOME（配置仓 env.sh）}"
export ANDROID_HOME="$PODIC_ANDROID_HOME"
export ANDROID_NDK_HOME="$PODIC_NDK_HOME"
[ -f android/local.properties ] || echo "sdk.dir=$PODIC_ANDROID_HOME" > android/local.properties

echo "[1/4] 前端构建"
npx vite build

echo "[2/4] Rust .so（arm64-v8a + x86_64）"
cargo ndk -t arm64-v8a -t x86_64 --platform 24 -- build --release -p podic-mobile
mkdir -p android/app/src/main/jniLibs/arm64-v8a android/app/src/main/jniLibs/x86_64
cp target/aarch64-linux-android/release/libpodic_mobile.so android/app/src/main/jniLibs/arm64-v8a/
cp target/x86_64-linux-android/release/libpodic_mobile.so android/app/src/main/jniLibs/x86_64/

echo "[3/4] 资产：dist 前端 + 词典包"
mkdir -p android/app/src/main/assets
rm -rf android/app/src/main/assets/web
cp -r dist android/app/src/main/assets/web
mkdir -p android/app/src/main/assets/packs
# aapt2 对 *.gz 资产会去后缀并透明解压（与 .db 同名冲突），这里统一只放 .db
rm -f android/app/src/main/assets/packs/*.db android/app/src/main/assets/packs/*.gz
cp packs/podic-*.db android/app/src/main/assets/packs/
ls -lh android/app/src/main/assets/packs/ || true

echo "[4/4] gradle $GRADLE_TASK"
cd android && ./gradlew "$GRADLE_TASK"
ls -lh "$OUT_DIR"/
