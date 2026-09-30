#!/usr/bin/env bash
# iOS 全链路发布（Linux 编排）：Mac 未签名编译 -> Linux rcodesign 签名打 ipa -> Mac altool 上传
#
# 为什么签名在 Linux：ssh 无 GUI 会话下 macOS securityd 拒绝钥匙串私钥访问
# （errSecInternalComponent），Mac 命令行 codesign 走不通；rcodesign（apple-codesign）
# 是纯文件签名，完全不碰钥匙串。签名材料在配置仓 ~/.config/podic/：
#   apple-distribution-signer.pem   Distribution 私钥+证书+WWDR（leaf 须 PEM 且排最前）
#   podic_appstore.mobileprovision  App Store profile（ASC 网页下载，证书有效期内静态）
#
# 用法: scripts/release-ios.sh
#   PODIC_IOS_BUILD=N 必填（build 号全局单调递增，失败宁可 +1 别重传同号）
#   PODIC_MAC=host    Mac ssh 目标（默认 mbp.x.felix021.cn）
set -euo pipefail
cd "$(dirname "$0")/.."

MAC="${PODIC_MAC:-mbp.x.felix021.cn}"
RIG=~/code/podic-ios-build              # Mac 侧工作副本
RCODESIGN="${RCODESIGN:-$HOME/code/oh-my-term/gitea/oh-my-term/_work/target/apple-codesign-root/bin/rcodesign}"
SIGNER=~/.config/podic/apple-distribution-signer.pem
PROFILE=~/.config/podic/podic_appstore.mobileprovision
ENTITLEMENTS=ios/entitlements.plist

[ -n "${PODIC_IOS_BUILD:-}" ] || { echo "缺 PODIC_IOS_BUILD（build 号需单调递增）" >&2; exit 1; }
[ -f "$SIGNER" ]  || { echo "缺 $SIGNER" >&2; exit 1; }
[ -f "$PROFILE" ] || { echo "缺 $PROFILE（ASC 网页 -> Profiles -> podic App Store -> Download）" >&2; exit 1; }
[ -x "$RCODESIGN" ] || { echo "缺 $RCODESIGN（cargo install apple-codesign 或指定 RCODESIGN=）" >&2; exit 1; }

VERSION=$(node -p "require('./package.json').version")
echo "== podic iOS v$VERSION (build $PODIC_IOS_BUILD)，签名方式: Linux rcodesign =="

echo "[1/5] 同步源码到 Mac"
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude target --exclude dist \
  --exclude packs --exclude harmony --exclude 'ios/build' --exclude 'ios/Frameworks' \
  --exclude 'ios/Resources' --exclude 'ios/Podic.xcodeproj' \
  --exclude 'android/.gradle' --exclude 'android/app/build' \
  ./ "$MAC:$RIG/"

echo "[2/5] Mac：依赖产物 + 未签名编译"
ssh "$MAC" 'bash -l -c "
  cd ~/code/podic-ios-build
  scripts/build-ios.sh
  (cd ios && xcodegen generate)
  xcodebuild -project Podic.xcodeproj -scheme Podic \
    -destination \"generic/platform=iOS\" \
    -derivedDataPath build/dd build \
    CURRENT_PROJECT_VERSION=\"$PODIC_IOS_BUILD\" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO -quiet
  ls build/dd/Build/Products/Release-iphoneos/
"'

echo "[3/5] 取回 .app 并签名（Linux rcodesign）"
WORK=$(mktemp -d ~/tmp/ios-sign.XXXX)
rsync -az "$MAC:$RIG/ios/build/dd/Build/Products/Release-iphoneos/Podic.app" "$WORK/"
cp "$PROFILE" "$WORK/Podic.app/embedded.mobileprovision"   # rcodesign 不嵌 profile，手动放
"$RCODESIGN" sign \
  --pem-file "$SIGNER" \
  --entitlements-xml-file "$ENTITLEMENTS" \
  "$WORK/Podic.app"
"$RCODESIGN" verify "$WORK/Podic.app/Podic"
mkdir -p "$WORK/Payload" && cp -R "$WORK/Podic.app" "$WORK/Payload/"
(cd "$WORK" && zip -qr app.ipa Payload)
ls -lh "$WORK/app.ipa"

echo "[4/5] Mac：altool 上传"
rsync -az "$WORK/app.ipa" "$MAC:$RIG/ios/build/"
ssh "$MAC" 'bash -l -c "
  source ~/.config/podic/env.sh
  xcrun altool --upload-app --type ios -f ~/code/podic-ios-build/ios/build/app.ipa \
    --apiKey \"$PODIC_ASC_KEY_ID\" --apiIssuer \"$PODIC_ASC_ISSUER\"
"'

echo "[5/5] 完成。processing 状态稍后用 ASC API 查（VALID 后 TestFlight 可用）"
echo "临时目录: $WORK"
