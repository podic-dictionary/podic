#!/usr/bin/env bash
# 鸿蒙（HarmonyOS NEXT）构建串联：前端 -> Rust NAPI .so -> rawfile 资源 -> hvigor 打包
# 用法: scripts/build-harmony.sh [assembleHap|assembleApp]（默认 assembleHap）
#
# 依赖（配置仓 env.sh，PODIC_CONFIG_DIR 默认 ~/.config/podic）：
#   PODIC_OHOS_SDK   OpenHarmony Public SDK 的 linux 目录（内部含 native/），用于交叉编译
#   PODIC_DEVECO_HOME（可选）DevEco Studio 安装目录，含 tools/hvigor/bin/hvigorw
# 签名在 DevEco Studio 里配置（build-profile.json5 的 signingConfigs）。
set -euo pipefail
cd "$(dirname "$0")/.."

export PODIC_CONFIG_DIR="${PODIC_CONFIG_DIR:-$HOME/.config/podic}"
if [ -f "$PODIC_CONFIG_DIR/env.sh" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$PODIC_CONFIG_DIR/env.sh"
  set +a
fi

: "${PODIC_OHOS_SDK:?缺 PODIC_OHOS_SDK（OpenHarmony SDK 的 linux 目录，含 native/）}"
SDK="$PODIC_OHOS_SDK"

# napi-build-ohos 读 OHOS_NDK_HOME，并在 $OHOS_NDK_HOME/native/sysroot 下找 libace_napi.z
if [ -d "$SDK/native" ]; then
  export OHOS_NDK_HOME="$SDK"
elif [ -d "$SDK/sysroot" ]; then
  export OHOS_NDK_HOME="$(dirname "$SDK")"
else
  echo "PODIC_OHOS_SDK 下找不到 native/ 或 sysroot/：$SDK" >&2
  exit 1
fi

RUST_TARGET=aarch64-unknown-linux-ohos

# Rust 交叉链接 ohos 需要显式 sysroot：生成 clang wrapper，再用环境变量指给 cargo
BUILD_DIR="harmony/.build"
mkdir -p "$BUILD_DIR"
WRAP="$BUILD_DIR/aarch64-linux-ohos-clang.sh"
cat > "$WRAP" <<EOF
#!/bin/sh
exec "$SDK/native/llvm/bin/clang" -target aarch64-linux-ohos \\
  --sysroot="$SDK/native/sysroot" -D__MUSL__ "\$@"
EOF
chmod +x "$WRAP"
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER="$PWD/$WRAP"
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_AR="$SDK/native/llvm/bin/llvm-ar"

echo "[1/4] 前端构建"
npx vite build

echo "[2/4] Rust NAPI .so（$RUST_TARGET）"
rustup target add "$RUST_TARGET" >/dev/null 2>&1 || true
cargo build --release -p podic-ohos --target "$RUST_TARGET"
mkdir -p harmony/entry/libs/arm64-v8a
cp "target/$RUST_TARGET/release/libpodic_ohos.so" harmony/entry/libs/arm64-v8a/

echo "[3/4] 资源：dist 前端 + 词典包 -> rawfile"
RAWFILE=harmony/entry/src/main/resources/rawfile
rm -rf "$RAWFILE/web"
cp -r dist "$RAWFILE/web"
mkdir -p "$RAWFILE/packs"
rm -f "$RAWFILE/packs"/*.db
cp packs/podic-*.db "$RAWFILE/packs/" 2>/dev/null || echo "  (未找到 packs/podic-*.db，跳过内置词典包)"
ls -lh "$RAWFILE/packs/" 2>/dev/null || true

# 运行期按清单拷贝 rawfile：ArkTS 侧不依赖 getRawFileList（其对目录/文件的列举行为不稳定）
write_manifest() { # $1=相对 rawfile 的目录  $2=输出文件
  local dir="$RAWFILE/$1" out="$2" first=1
  {
    printf '['
    if [ -d "$dir" ]; then
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        if [ "$first" -eq 1 ]; then first=0; else printf ','; fi
        printf '"%s"' "$f"
      done < <(cd "$dir" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)
    fi
    printf ']\n'
  } > "$out"
}
write_manifest web "$RAWFILE/web-manifest.json"
write_manifest packs "$RAWFILE/packs-manifest.json"

echo "[4/4] hvigor 打包"
TASK="${1:-assembleHap}"
cd harmony
if [ -x ./hvigorw ]; then
  HV=./hvigorw
elif [ -n "${PODIC_DEVECO_HOME:-}" ] && [ -x "$PODIC_DEVECO_HOME/tools/hvigor/bin/hvigorw" ]; then
  HV="$PODIC_DEVECO_HOME/tools/hvigor/bin/hvigorw"
elif command -v hvigorw >/dev/null 2>&1; then
  HV=hvigorw # command-line-tools 独立安装时 hvigorw 在其 bin/ 下（PATH 可达）
else
  echo "未找到 hvigorw：请先在 DevEco Studio 打开 harmony/ 生成 hvigor 包装，或设置 PODIC_DEVECO_HOME" >&2
  echo "Rust .so 与资源已就绪，可在 DevEco 里直接 Run/打包。" >&2
  exit 0
fi
"$HV" --no-daemon "$TASK"
