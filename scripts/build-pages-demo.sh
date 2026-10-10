#!/usr/bin/env bash
# 构建官网可交互 demo：真前端 dist + API mock（无后端也能完整体验）
# 产物写入 podic-dictionary.github.io 仓的 demo/，landing 页由 iframe 引用
# 用法: bash scripts/build-pages-demo.sh [pages仓路径]
set -euo pipefail
cd "$(dirname "$0")/.."
PAGES="${1:-$HOME/code/podic-dictionary/podic-dictionary.github.io}"
MOCK_SRC="${MOCK_SRC:-$HOME/tmp/pages-mock}"   # 真后端抓的响应目录

echo "[1/3] 前端构建（相对路径 base，适配子目录）"
npx vite build --base=./ >/dev/null

echo "[2/3] 产物拷贝 + mock 注入"
rm -rf "$PAGES/demo"
mkdir -p "$PAGES/demo"
cp -r dist/* "$PAGES/demo/"
python3 scripts/pages-mock-gen.py "$MOCK_SRC" "$PAGES/demo/mock.js"
# index.html 的 module script 前注入 mock（必须在 app 之前接管 fetch）
python3 - "$PAGES/demo/index.html" <<'PY'
import sys, re
p = sys.argv[1]
html = open(p, encoding='utf-8').read()
if 'mock.js' not in html:
    html = re.sub(r'(<script type="module")', r'<script src="./mock.js"></script>\n  \1', html, count=1)
    open(p, 'w', encoding='utf-8').write(html)
print("injected")
PY

echo "[3/3] 完成: $PAGES/demo（landing iframe 已引用则自动生效）"
