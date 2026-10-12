"""LLM 补齐词条的中文释义：把 senses 里的外文释义（fr 等）翻译成 zh。

场景：fr.wiktionary 补齐的词条 ~47% 只有法语释义（zh: null），查询时
词条卡显示法文原文。本脚本批量翻译写回 entries.jsonl，之后重打包。

- 输入: data/work/{lang}/entries.jsonl（筛 senses 有外文义且无 zh 的词条）
- 断点: data/work/{lang}/translated.jsonl 逐词追加，重跑只补缺失
- 输出: 写回 entries.jsonl（senses[i].zh = 翻译[i]，zh_terms 重建）
- 协议: anthropic（ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN），与 generate 同款

用法: python3 translate_senses_llm.py --lang fr --language-name 法语 --source-field fr \
          --model glm-5.3-flash [--batch 60] [--concurrency 4] [--limit N] [--dry-run]
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

MAX_RETRY = 3
TOKENS_PER_WORD = 300


class ApiReject(Exception):
    pass


def api_call(model: str, system: str, user: str, max_tokens: int) -> str:
    base = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
    key = os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY", "")
    headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01",
               "Authorization": f"Bearer {key}"}
    body = {"model": model, "max_tokens": max_tokens, "temperature": 0,
            "thinking": {"type": "disabled"}, "system": system,
            "messages": [{"role": "user", "content": user}]}
    req = urllib.request.Request(f"{base}/v1/messages", json.dumps(body).encode(), headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500 and e.code != 429:
            raise ApiReject(f"HTTP {e.code}")
        raise OSError(f"HTTP {e.code}")
    stop = data.get("stop_reason")
    if stop not in (None, "end_turn"):
        raise ApiReject(f"stop_reason={stop}")
    return "".join(b.get("text", "") for b in data.get("content", []))


def parse_batch(text: str) -> list[dict] | None:
    t = text.strip()
    if t.startswith("```"):
        m = re.search(r"```(?:json)?\s*([\s\S]*?)```", t)
        t = (m.group(1) if m else t.replace("```", "")).strip()
    try:
        arr = json.loads(t)
    except Exception:
        return None
    if not isinstance(arr, list):
        return None
    out = []
    for d in arr:
        if not isinstance(d, dict) or not isinstance(d.get("word"), str):
            return None
        zh = d.get("zh")
        if not isinstance(zh, list) or not zh:
            return None
        clean = [z.strip() for z in zh if isinstance(z, str) and z.strip()]
        if not clean:
            return None
        out.append({"word": d["word"].strip(), "zh": clean})
    return out


def split_zh(zh: str) -> list[str]:
    t = re.sub(r"[（(][^）)]*[）)]", "", zh)
    res = []
    for seg in re.split(r"[；;]", t):
        for w in re.split(r"[，,、]", seg):
            w = w.strip().strip("。，,、")
            if 2 <= len(w) <= 8:
                res.append(w)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", required=True)
    ap.add_argument("--language-name", required=True)
    ap.add_argument("--source-field", default="fr", help="释义来源字段（fr/en/…）")
    ap.add_argument("--model", required=True)
    ap.add_argument("--batch", type=int, default=60)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--max-tokens", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--work-dir", default="")
    ap.add_argument("--allow-empty", action="store_true",
                    help="senses 全空的词条也处理（由词头+词性生成释义，en 长尾用）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    work = Path(args.work_dir) if args.work_dir else common.WORK / args.lang
    entries = [json.loads(l) for l in open(work / "entries.jsonl", encoding="utf-8") if l.strip()]
    todo = []
    for e in entries:
        ss = e.get("senses", [])
        if not any(s.get("zh") for s in ss):
            # 有外文释义 -> 翻译；senses 全空（en 长尾词）-> 由词头直接生成
            if ss and any(s.get(args.source_field) for s in ss):
                todo.append(e)
            elif not ss and args.allow_empty:
                todo.append(e)
    if args.limit > 0:
        todo = todo[: args.limit]
    common.log(f"总 {len(entries)} 词条，待翻译 {len(todo)}（senses.{args.source_field} -> zh）")

    prog = work / "translated.jsonl"
    done: dict[str, list[str]] = {}
    if prog.exists():
        for line in open(prog, encoding="utf-8"):
            line = line.strip()
            if line:
                try:
                    d = json.loads(line)
                    done[d["word"]] = d["zh"]
                except Exception:
                    pass
    todo = [e for e in todo if e["headword"] not in done]
    common.log(f"断点已有 {len(done)}，剩余 {len(todo)}")

    batch_tokens = args.max_tokens or min(65536, args.batch * TOKENS_PER_WORD + 600)
    if args.dry_run:
        for e in todo[:5]:
            fr0 = next(s.get(args.source_field) for s in e["senses"] if s.get(args.source_field))
            print(f"  [dry] {e['headword']}: {fr0[:60]}")
        return

    system = "你是双语词典编纂者。把外语词典释义翻译成简洁的中文词典释义。只输出 JSON，不要围栏。"
    lock = threading.Lock()
    stats = {"ok": 0, "skip": 0}

    def worker(idx: int, chunk: list[dict]):
        def src_text(e):
            ss = e.get("senses", [])
            if not ss:  # 空词条：给词头+词性让模型编写
                pos = "/".join(e.get("pos") or []) or "?"
                return f"[{pos}]（编写 1-2 条释义）"
            return " | ".join((s.get(args.source_field) or "")[:160] for s in ss[:4])
        wl = "\n".join(f"- {e['headword']} :: {src_text(e)}" for e in chunk)
        user = (
            f"把以下{args.language_name}词条的释义翻译成简洁的中文词典释义（保留术语准确性，去掉冗长修辞）；"
            f"标了词性的无释义词条则直接编写中文释义。"
            f"每个词输出 {{\"word\": 词, \"zh\": [每个义项一句中文]}}，输出 JSON 数组顺序与输入一致。\n\n{wl}"
        )
        rows = None
        for attempt in range(MAX_RETRY):
            try:
                rows = parse_batch(api_call(args.model, system, user, batch_tokens))
            except ApiReject:
                return None
            except Exception as e:
                common.log(f"  [warn] 批 {idx} 网络错误(第 {attempt + 1} 次): {e}")
                time.sleep(5 * (attempt + 1))
                continue
            if rows is None:
                continue
            got = [r["word"] for r in rows]
            want = [e["headword"] for e in chunk]
            if got != want:
                common.log(f"  [warn] 批 {idx} 词序不对应(第 {attempt + 1} 次)")
                continue
            return rows
        return None

        # 静态检查友好：worker 主体结束（上面 return 已覆盖所有路径）

    def run(idx, chunk):
        rows = worker(idx, chunk)
        if rows is None:
            with lock:
                stats["skip"] += len(chunk)
            return
        with lock:
            with open(prog, "a", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
                    done[r["word"]] = r["zh"]
            stats["ok"] += len(chunk)
            if stats["ok"] % 600 < len(chunk):
                common.log(f"[进度] 已译 {stats['ok']}，跳过 {stats['skip']}")

    chunks = [(i, todo[i : i + args.batch]) for i in range(0, len(todo), args.batch)]
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for idx, chunk in chunks:
            pool.submit(run, idx, chunk)
    common.log(f"翻译完成：{stats['ok']}，跳过 {stats['skip']} -> {prog}")

    # 写回 entries.jsonl：senses[i].zh 按义项对应填入（不足则填到首义），
    # zh_terms 重建（翻译后的中文要进反查索引）
    n_filled = 0
    out_lines = []
    for e in entries:
        ss = e.get("senses", [])
        zh_list = done.get(e["headword"])
        if zh_list and not any(s.get("zh") for s in ss):
            if not ss:  # 空词条：构造 senses（pos 保留在词条级）
                e["senses"] = ss = [{"zh": z} for z in zh_list[:3]]
            for i, s in enumerate(ss):
                z = zh_list[i] if i < len(zh_list) else (zh_list[-1] if len(ss) == 1 else None)
                if z:
                    s["zh"] = z
            if any(s.get("zh") for s in ss):
                e["zh_terms"] = [[t, i, "llm"] for i, s in enumerate(ss) if s.get("zh")
                                 for t in split_zh(s["zh"])]
                n_filled += 1
        out_lines.append(json.dumps(e, ensure_ascii=False))
    tmp = work / "entries.jsonl.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")
    os.replace(tmp, work / "entries.jsonl")
    common.log(f"写回 entries.jsonl：补 zh {n_filled} 条")


if __name__ == "__main__":
    main()
