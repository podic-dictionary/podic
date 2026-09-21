#!/usr/bin/env bash
# iOS 全链路发布（仅 macOS）：构建 -> archive -> export(ASC 云托管签名) -> 上传 TestFlight
# 用法: scripts/release-ios.sh [--skip-upload]
#   PODIC_IOS_BUILD=N    指定 build 号（同版本号必须递增，默认 1）
#   SKIP 上传用 --skip-upload
# 凭据: source ~/.config/podic/env.sh 提供 PODIC_ASC_KEY_ID / PODIC_ASC_ISSUER_ID
#   （PODIC_ASC_KEY_PATH 缺省 ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8）
# 参考 oh-my-term 踩坑：archive 不签名；签名在 -exportArchive，经 ASC API key
# 自动创建/使用云托管 Apple Distribution 证书与 profile（key 需 Admin 角色）。
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_UPLOAD=0
[ "${1:-}" = "--skip-upload" ] && SKIP_UPLOAD=1

# ssh 非交互 shell 没有 login PATH：补 nvm node 与 homebrew
export PATH="$HOME/.nvm/versions/node/v24.17.0/bin:/opt/homebrew/bin:$PATH"

if [ -z "${PODIC_ASC_KEY_ID:-}" ] && [ -f "$HOME/.config/podic/env.sh" ]; then
  # shellcheck disable=SC1091
  set +u; source "$HOME/.config/podic/env.sh"; set -u
fi

TEAM_ID="${PODIC_IOS_TEAM_ID:-6749ZYTN49}"
KEY_ID="${PODIC_ASC_KEY_ID:-}"
ISSUER="${PODIC_ASC_ISSUER_ID:-}"
KEY_PATH="${PODIC_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8}"
BUILD="${PODIC_IOS_BUILD:-1}"

if [ "$SKIP_UPLOAD" != 1 ]; then
  [ -n "$KEY_ID" ] && [ -n "$ISSUER" ] || { echo "缺 ASC 凭据：source ~/.config/podic/env.sh（PODIC_ASC_KEY_ID / PODIC_ASC_ISSUER_ID）"; exit 1; }
  [ -f "$KEY_PATH" ] || { echo "ASC key 不存在：$KEY_PATH"; exit 1; }
fi

VERSION=$(node -p "require('./package.json').version")
echo "== podic iOS v$VERSION (build $BUILD) =="

echo "[1/5] 依赖产物（前端 + Rust 静态库 + XCFramework + 资源）"
scripts/build-ios.sh

echo "[2/5] 生成 Xcode 工程"
(cd ios && xcodegen generate)

echo "[3/5] archive（不签名，签名在 export 阶段）"
(cd ios && xcodebuild archive \
  -project Podic.xcodeproj -scheme Podic \
  -destination 'generic/platform=iOS' \
  -archivePath build/Podic.xcarchive \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  CODE_SIGNING_ALLOWED=NO -quiet)

echo "[4/5] export（云托管签名）"
cat > ios/build/exportOptions.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
EOF
(cd ios && xcodebuild -exportArchive \
  -archivePath build/Podic.xcarchive \
  -exportOptionsPlist build/exportOptions.plist \
  -exportPath build/export \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" \
  -authenticationKeyIssuerID "$ISSUER" -quiet)

IPA=$(ls ios/build/export/*.ipa | head -1)
echo "IPA: $IPA"

if [ "$SKIP_UPLOAD" = 1 ]; then
  echo "跳过上传（--skip-upload）"; exit 0
fi

echo "[5/5] 上传 TestFlight"
xcrun altool --upload-app --type ios -f "$IPA" --apiKey "$KEY_ID" --apiIssuer "$ISSUER"
echo "上传完成，processing 状态稍后用 ASC API 查询（~/tmp/asc_builds.py 同款 JWT 直查）"
