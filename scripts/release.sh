#!/usr/bin/env bash
# 发布词典包到 podic-dictionary/dict 的 GitHub Release：packs/*.db.gz + manifest.json
# 前置: gh auth login 过；packs/ 已由 build_all.sh + make_manifest.py 产出
# 用法: bash scripts/release.sh <版本号>
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?用法: release.sh <版本号>}"
TAG="packs-v$VERSION"
DICT_REPO="podic-dictionary/dict"
MANIFEST_URL="https://github.com/$DICT_REPO/releases/latest/download/manifest.json"

gh release create "$TAG" \
  --repo "$DICT_REPO" \
  packs/*.db.gz packs/manifest.json \
  --title "词典包 v$VERSION" \
  --notes "词典包构建于 $(date +%F)。

- 更新源直链: $MANIFEST_URL
- 数据来源与授权见该仓 README 与各包 meta.sources"

echo "已发布 $TAG -> $DICT_REPO"
echo "App 内更新地址: $MANIFEST_URL（设置页留空即用此默认）"
