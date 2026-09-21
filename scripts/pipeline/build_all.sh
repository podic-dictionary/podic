#!/usr/bin/env bash
# 全量构建：下载 -> 清洗 -> 打包 -> manifest。精修(refine_llm)是独立可重跑步骤，不在此链路。
# 用法: bash scripts/pipeline/build_all.sh [版本号，默认 0.1.0]
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION="${1:-0.1.0}"

python3 scripts/pipeline/download_all.py
python3 scripts/pipeline/build_en.py
python3 scripts/pipeline/build_en_cedict.py
python3 scripts/pipeline/build_fr.py
python3 scripts/pipeline/build_fr_cfdict.py
python3 scripts/pipeline/build_ja.py

# 例句依赖 Tatoeba（大文件，可选）
if [ -f data/raw/tatoeba_sentences.csv ] && [ -f data/raw/tatoeba_links.csv ]; then
  python3 scripts/pipeline/build_examples.py
  EXAMPLES="--examples"
else
  echo "[warn] 缺少 Tatoeba 数据，跳过例句"
  EXAMPLES=""
fi

python3 scripts/pipeline/build_pack.py --lang en --version "$VERSION" --sources ecdict,cedict $EXAMPLES
python3 scripts/pipeline/build_pack.py --lang fr --version "$VERSION" --sources lexique,cfdict $EXAMPLES
python3 scripts/pipeline/build_pack.py --lang ja --version "$VERSION" --sources jmdict_eng,kanjidic2 $EXAMPLES

# 精修（需要 ANTHROPIC_API_KEY/AUTH_TOKEN；fr 为 --rank-file 可选传 Tatoeba 词频）
# python3 scripts/pipeline/refine_llm.py --lang fr --limit 5000
# python3 scripts/pipeline/refine_llm.py --lang ja --limit 5000 --rank-file data/work/ja/ja_word_freq.tsv
# 重跑上面两条后需重新执行对应 build_pack

python3 scripts/pipeline/make_manifest.py --version "$VERSION" "$@"
echo "构建完成: packs/"
ls -la packs/
