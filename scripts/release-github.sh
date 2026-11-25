#!/usr/bin/env bash
# 把 Android APK 发到本仓库的 GitHub Release（tag v<package.json version>）。
#
# 用法: scripts/release-github.sh [--apk PATH] [--notes FILE] [--title TITLE] [--repo OWNER/REPO]
#   --apk    默认 android/app/build/outputs/apk/release/app-release.apk（没有就先跑
#            scripts/build-android.sh release）
#   --notes  发布说明 markdown；不给就自动用上个 tag 以来的提交标题
#
# 大文件走代理会「发完无响应」卡死（实测 130MB 级别必现）。指定
# PODIC_GH_UPLOAD_HOST=user@host（一台能直连 GitHub 的机器）后，脚本把 APK 传过去，
# 用 curl 直传 assets；不指定则用 gh 本地上传（大陆网络容易卡）。
#
# 流程：建 tag（没有则建并推送）-> 建 draft release -> 传 APK -> 发布
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${PODIC_GH_REPO:-podic-dictionary/podic}"
APK="android/app/build/outputs/apk/release/app-release.apk"
NOTES=""
TITLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apk) APK="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
TITLE="${TITLE:-$TAG}"
[ -f "$APK" ] || { echo "缺 $APK，先跑 scripts/build-android.sh release" >&2; exit 1; }
command -v gh >/dev/null || { echo "缺 gh（GitHub CLI）" >&2; exit 1; }

echo "== $REPO $TAG，APK $(du -h "$APK" | cut -f1) =="

# tag：本地没有就以当前 HEAD 建，远端没有就推
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  git tag -a "$TAG" -m "$TITLE"
  echo "建 tag $TAG"
fi
if ! git ls-remote --tags github "refs/tags/$TAG" | grep -q .; then
  git push github "$TAG"
fi

# 说明：默认取上个 tag 以来的提交标题
if [ -z "$NOTES" ]; then
  NOTES=$(mktemp ~/tmp/release-notes.XXXXXX)
  PREV=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)
  RANGE="${PREV:+$PREV..}$TAG"
  {
    echo "## 变更"
    echo
    git log --no-merges --format='- %s' "$RANGE" | head -50
  } > "$NOTES"
fi

# 已有同名 release 就复用（重跑场景），否则建 draft
RID=$(gh api "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name==\"$TAG\") | .id" | head -1)
if [ -z "$RID" ]; then
  gh release create "$TAG" --repo "$REPO" --draft --title "$TITLE" --notes-file "$NOTES" >/dev/null
  RID=$(gh api "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name==\"$TAG\") | .id" | head -1)
  echo "建 draft release id=$RID"
else
  echo "复用已有 release id=$RID"
fi

# 已传过同名资产就跳过
EXIST=$(gh api "repos/$REPO/releases/$RID/assets" --jq '.[].name')
NAME=$(basename "$APK")
if grep -qx "$NAME" <<<"$EXIST"; then
  echo "资产 $NAME 已存在，跳过上传"
elif [ -n "${PODIC_GH_UPLOAD_HOST:-}" ]; then
  REMOTE_PATH="/tmp/podic-release-$NAME"
  rsync -az "$APK" "$PODIC_GH_UPLOAD_HOST:$REMOTE_PATH"
  TOKEN=$(gh auth token)
  echo "经 $PODIC_GH_UPLOAD_HOST 直传…"
  ssh "$PODIC_GH_UPLOAD_HOST" bash -s <<EOF
set -euo pipefail
curl -sS --max-time 900 -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/vnd.android.package-archive" \
  -H "Accept: application/vnd.github+json" \
  --data-binary @$REMOTE_PATH \
  "https://uploads.github.com/repos/$REPO/releases/$RID/assets?name=$NAME" \
  -w "\nHTTP %{http_code} %{size_upload}B %{time_total}s\n" | tail -c 300
rm -f $REMOTE_PATH
EOF
else
  gh release upload "$TAG" "$APK" --repo "$REPO" --clobber
fi

# 发布（draft -> published）
gh api -X PATCH "repos/$REPO/releases/$RID" -f draft=false >/dev/null
echo "已发布 https://github.com/$REPO/releases/tag/$TAG"
