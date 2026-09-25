#!/usr/bin/env bash
# 复核 worker：抽查/校对自己分片的精修产出，修正问题行写入 .fix.jsonl
# 用法: review_worker.sh <worker_id 0-2> [total_workers 3]
set -uo pipefail
cd "$(dirname "$0")/../.."

W="${1:?worker id}"
N="${2:-3}"
MODEL="${PODIC_REFINE_MODEL:-glm-5.3-flash[1m]}"
CLI="claude"
ROOT="$(pwd)"

for lang in fr ja; do
  sdir="data/work/$lang/refine_slices"
  [ -d "$sdir" ] || continue
  idx=0
  for input in "$sdir"/slice-*.input.jsonl; do
    [ -e "$input" ] || continue
    if (( idx % N != W )); then idx=$((idx+1)); continue; fi
    idx=$((idx+1))
    base="${input%.input.jsonl}"
    out="$base.output.jsonl"
    fix="$base.fix.jsonl"
    [ -s "$out" ] || continue
    [ -s "$fix" ] && { echo "[skip] $fix 已存在"; continue; }

    tdir="$ROOT/data/work/claude-tasks/$(date +%Y%m%d%H%M%S)-review-$(basename "$base")-w$W"
    mkdir -p "$tdir"
    rows=$(wc -l < "$input")
    {
      echo "你是词典数据质检员。任务：核对一份由 LLM 生成的词条中文释义数据。"
      echo ""
      echo "输入词条表（绝对路径）：$ROOT/$input （$rows 行）"
      echo "待核对的产出（绝对路径）：$ROOT/$out"
      echo ""
      echo "逐行核对以下项目："
      echo "1. headword 与输入一致（顺序、拼写）"
      echo "2. senses 非空，1-4 个义项；zh 为简体中文且以词性缩写开头（n./v./adj./adv./prep./pron./conj./int. 等）"
      echo "3. 释义与该词实际含义相符（结合你自己的语言知识判断，不要求逐字对照 glosses）"
      echo "4. 没有把英文/法文原词直接留在 zh 里（音译词、拉丁词源说明除外）"
      echo ""
      echo "输出：只把**有问题的行**修正后写到 $ROOT/$fix ，格式与产出文件相同（每行一个 JSON，headword 原样）。"
      echo "没有问题就写一个空文件。最后回复一行统计：TOTAL <输入行数> BAD <问题行数>"
    } > "$tdir/prompt.md"

    echo "[r$W] $(basename "$base") 复核中"
    set -o pipefail
    ( cd "$ROOT" && "$CLI" -p --model "$MODEL" --dangerously-skip-permissions \
        --max-turns 30 --verbose --output-format stream-json \
        < "$tdir/prompt.md" 2> "$tdir/log.md" \
        | jq --unbuffered -c 'select(.type=="result")' > "$tdir/events.jsonl" )
    [ -s "$fix" ] || : > "$fix"   # 确保有占位文件避免重复复核
    echo "[r$W] $(basename "$base") 复核完成"
  done
done
echo "[r$W] 复核完毕"
