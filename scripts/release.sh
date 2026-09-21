#!/usr/bin/env bash
# 发布词典包到 GitHub Release：packs/*.db.gz + manifest.json
# 前置: gh auth login 过；packs/ 已由 build_all.sh + make_manifest.py 产出
# 用法: bash scripts/release.sh <版本号>
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?用法: release.sh <版本号>}"
TAG="packs-v$VERSION"

gh release create "$TAG" \
  packs/*.db.gz packs/manifest.json \
  --title "词典包 v$VERSION" \
  --notes "词典包构建于 $(date +%F)。

- 更新源直链: https://github.com/\$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s/\.git$#')/releases/latest/download/manifest.json
- 数据来源与授权见 ATTRIBUTIONS.md 与各包 meta.sources"

echo "已发布 $TAG"
echo "App 内更新地址: https://github.com/$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s/\.git$#')/releases/latest/download/manifest.json"
