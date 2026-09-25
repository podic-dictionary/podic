#!/usr/bin/env bash
# 精修 worker：处理自己分片（序号 % WORKERS == ID）的切片，一个切片一个无头会话。
# 用法: refine_worker.sh <worker_id 0-2> [total_workers 3]
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
    [ -s "$out" ] && { echo "[skip] $out 已存在"; continue; }

    tdir="$ROOT/data/work/claude-tasks/$(date +%Y%m%d%H%M%S)-refine-$(basename "$base")-w$W"
    mkdir -p "$tdir"
    rows=$(wc -l < "$input")
    parts=$(( (rows + 99) / 100 ))
    {
      echo "你是词典编纂数据处理器。任务：把输入文件里每个词条的释义补全为简体中文。"
      echo ""
      echo "输入文件（绝对路径）：$ROOT/$input"
      echo "每行一个 JSON：{\"headword\",\"reading\",\"pos\",\"gender\",\"glosses\"}，glosses 是已有英/法文释义（可能为空）。"
      echo ""
      echo "输出要求："
      echo "1. 逐行处理，输出行数必须与输入一致（$rows 行），顺序不变"
      echo "2. 每行输出：{\"headword\":\"原样\",\"senses\":[{\"zh\":\"词性缩写. 中文释义\"}]}"
      echo "3. 义项 1-3 个按常用度排序；zh 以词性缩写开头（n./v./adj./adv./prep./pron./conj./int. 等）；"
      echo "   基于 glosses 翻译整理，不得编造词义；glosses 为空时给出该词最常用的释义；"
      echo "   专有名词格式为「音译（类别说明）」，如「巴黎（法国首都）」"
      echo "4. 输出写到：$ROOT/$out  分 $parts 个分片：$out.part1 ... $out.part$parts，"
      echo "   每片恰好 100 行（最后一片可以少），用 Write 工具逐片写出"
      echo "5. 除了读写上述文件外不做任何其他操作，完成后只回复 DONE"
    } > "$tdir/prompt.md"

    echo "[w$W] $(basename "$base") 开始 ($rows 行)"
    set -o pipefail
    ( cd "$ROOT" && "$CLI" -p --model "$MODEL" --dangerously-skip-permissions \
        --max-turns 40 --verbose --output-format stream-json \
        < "$tdir/prompt.md" 2> "$tdir/log.md" \
        | jq --unbuffered -c 'select(.type=="result")' > "$tdir/events.jsonl" )
    rc=$?

    # 校验分片并拼接
    total=0
    for p in "$out".part*; do
      [ -e "$p" ] || continue
      lines=$(grep -c . "$p" 2>/dev/null || echo 0)
      total=$((total + lines))
    done
    if [ "$total" -eq "$rows" ]; then
      cat $(ls "$out".part* | sort -V) > "$out" 2>/dev/null || true
      for p in "$out".part*; do rm -f "$p"; done
      echo "[w$W] $(basename "$base") 完成 ($total 行, rc=$rc)"
    else
      echo "[w$W] $(basename "$base") 失败 (rc=$rc, 产出 $total/$rows 行) — 详情 $tdir/log.md"
    fi
  done
done
echo "[w$W] 全部分片处理完毕"
