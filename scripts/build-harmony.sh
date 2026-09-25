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

# ABI 列表：真机 arm64 + 模拟器 x86_64（sysroot 缺 x86_64 时只编 arm64）
ABIS="arm64-v8a:aarch64-unknown-linux-ohos:aarch64-linux-ohos"
if [ -d "$SDK/native/sysroot/usr/lib/x86_64-linux-ohos" ]; then
  ABIS="$ABIS
x86_64:x86_64-unknown-linux-ohos:x86_64-linux-ohos"
fi

# 交叉编译需要显式指工具链：cargo 链接器 + cc crate 的 C 编译器都指向 SDK clang
# wrapper（不指的话 cc 找不到目标编译器会静默回退宿主 cc，产物架构错误）。
# wrapper 可同时作编译驱动（clang 见 -c 会编译）。
BUILD_DIR="harmony/.build"
mkdir -p "$BUILD_DIR"
for entry in $ABIS; do
  DIR="${entry%%:*}"; rest="${entry#*:}"
  TGT="${rest%%:*}"; TRIPLE="${rest#*:}"
  WRAP="$BUILD_DIR/$TRIPLE-clang.sh"
  cat > "$WRAP" <<EOF
#!/bin/sh
exec "$SDK/native/llvm/bin/clang" -target "$TRIPLE" \\
  --sysroot="$SDK/native/sysroot" -D__MUSL__ "\$@"
EOF
  chmod +x "$WRAP"
  V=$(echo "$TGT" | tr 'a-z-' 'A-Z_'); v=$(echo "$TGT" | tr 'A-Z-' 'a-z_')
  export "CARGO_TARGET_${V}_LINKER=$PWD/$WRAP"
  export "CARGO_TARGET_${V}_AR=$SDK/native/llvm/bin/llvm-ar"
  export "CC_${v}=$PWD/$WRAP"
  export "CXX_${v}=$PWD/$WRAP"
  export "AR_${v}=$SDK/native/llvm/bin/llvm-ar"
done

echo "[1/4] 前端构建"
npx vite build

echo "[2/4] Rust NAPI .so（$(echo "$ABIS" | cut -d: -f2 | tr '\n' ' ')）"
for entry in $ABIS; do
  DIR="${entry%%:*}"; TGT="${entry#*:}"; TGT="${TGT%%:*}"
  rustup target add "$TGT" >/dev/null 2>&1 || true
  cargo build --release -p podic-ohos --target "$TGT"
  mkdir -p "harmony/entry/libs/$DIR"
  cp "target/$TGT/release/libpodic_ohos.so" "harmony/entry/libs/$DIR/"
done

echo "[3/4] 资源：dist 前端 + 词典包 -> rawfile"
RAWFILE=harmony/entry/src/main/resources/rawfile
mkdir -p "$RAWFILE" # 首次构建时该目录不存在（rawfile 内容不入库）
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
# OpenHarmony 编译类型需要显式 SDK home（版本化布局 <home>/<api>/<component>，
# 用符号链接就地生成，指向 SDK 的 openharmony 组件目录）
if [ -n "${OHOS_BASE_SDK_HOME:-}" ] || [ -d "$SDK" ]; then
  API=$(cat "$SDK/native/oh-uni-package.json" 2>/dev/null | grep -o '"apiVersion": *"[0-9]*"' | grep -o '[0-9]*' | head -1)
  if [ -n "$API" ]; then
    OHOS_SDK_HOME="${PODIC_OHOS_SDK_HOME:-harmony/.sdk-home}"
    mkdir -p "$OHOS_SDK_HOME/$API"
    for c in native toolchains ets js previewer; do
      ln -sfn "$SDK/$c" "$OHOS_SDK_HOME/$API/$c"
    done
    export OHOS_BASE_SDK_HOME="$PWD/$OHOS_SDK_HOME"
  fi
fi
# HarmonyOS 版 SDK 的 device-define 缺 phone.json（OpenHarmony 才有），补一份
if [ -d "$SDK/ets/api/device-define" ] && [ ! -f "$SDK/ets/api/device-define/phone.json" ] && [ -f "$SDK/ets/api/device-define/default.json" ]; then
  cp "$SDK/ets/api/device-define/default.json" "$SDK/ets/api/device-define/phone.json"
fi
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

# [5/5] 用 SDK 自带的 OpenHarmony 官方 CA 签名（口令为公开默认值 123456，非机密）。
# oniro 等纯 OpenHarmony 系统要求：应用须以 `openharmony application profile release`
# key 签名（证书链 OpenHarmonyProfileRelease.pem，根在系统受信列表里）。
SIGN_TOOL="$SDK/toolchains/lib/hap-sign-tool.jar"
KEYSTORE="$SDK/toolchains/lib/OpenHarmony.p12"
CERT_CHAIN="$SDK/toolchains/lib/OpenHarmonyProfileRelease.pem"
HAP_DIR=entry/build/default/outputs/default
if [ -f "$SIGN_TOOL" ] && [ -f "$HAP_DIR/entry-default-unsigned.hap" ] && command -v java >/dev/null 2>&1; then
  # profile（debug 类型需绑定设备 UDID，模拟器无 UDID，统一用 release 模板）
  PODIC_PROFILE_CERT="$CERT_CHAIN" python3 - "$SDK/toolchains/lib/UnsgnedReleasedProfileTemplate.json" <<'PYEOF'
import json, sys, uuid, time, os
tpl = json.load(open(sys.argv[1]))
now = int(time.time())
tpl['uuid'] = str(uuid.uuid4())
tpl['validity'] = {'not-before': now, 'not-after': now + 10*365*24*3600}
tpl['bundle-info']['bundle-name'] = 'com.felix021.podic'
tpl['bundle-info']['apl'] = 'normal'
tpl['bundle-info']['app-feature'] = 'hos_normal_app'
certs = open(os.environ.get('PODIC_PROFILE_CERT', '')).read().split('-----END CERTIFICATE-----')
leaf = certs[2].strip() + '\n-----END CERTIFICATE-----\n'  # 链顺序 root→ca→leaf
tpl['bundle-info']['distribution-certificate'] = leaf
json.dump(tpl, open('.sign-profile.json', 'w'), indent=2)
PYEOF
  if [ -f .sign-profile.json ]; then
    java -jar "$SIGN_TOOL" sign-profile \
      -keyAlias "openharmony application profile release" -keyPwd 123456 \
      -signAlg SHA256withECDSA -mode localSign \
      -profileCertFile "$CERT_CHAIN" -inFile .sign-profile.json \
      -keystoreFile "$KEYSTORE" -keystorePwd 123456 -outFile .sign-profile.p7b >/dev/null
    java -jar "$SIGN_TOOL" sign-app \
      -keyAlias "openharmony application profile release" -keyPwd 123456 \
      -signAlg SHA256withECDSA -mode localSign \
      -appCertFile "$CERT_CHAIN" -profileFile .sign-profile.p7b \
      -inFile "$HAP_DIR/entry-default-unsigned.hap" \
      -keystoreFile "$KEYSTORE" -keystorePwd 123456 \
      -outFile "$HAP_DIR/podic-signed.hap" >/dev/null && \
      echo "已签名: $HAP_DIR/podic-signed.hap"
  fi
fi
