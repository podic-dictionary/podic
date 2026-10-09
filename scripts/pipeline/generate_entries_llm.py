"""LLM 从零生成语言词条：词单 -> entries.jsonl（多语言化自定义词典包的生成器）。

与 refine_llm.py 的分工：refine 是「给已有词条补释义」，本脚本从词单起建词条
（多语言化后用户为新注册语言构建 community 词典包的第一步）。

- 输入: 词单文件（每行一个词，或 `词<TAB>频次`；UTF-8）
- 输出: <work-dir>/entries.jsonl（原子写）+ 空 forms.jsonl
- 断点: <work-dir>/llm_entries.jsonl 逐词追加（word 一行 JSON），重跑只补缺失词
- norm/频次由脚本计算（与 crates/podic-core/src/norm.rs 同步的 common.norm），不交给 LLM
- 协议: --protocol openai（OPENAI_BASE_URL/OPENAI_API_KEY）| anthropic（ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN 或 API_KEY）
- 严格校验: 每批输出必须与输入词一一对应（按 word 字段回配），漏词/多词/重复/字段非法整批重试

用法:
  python3 scripts/pipeline/generate_entries_llm.py --lang de --language-name 德语 \\
      --words words.txt --model glm-5.3-flash --batch 20 [--limit 1000] \\
      [--work-dir data/work/de] [--dry-run]
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

BATCH_MAX_TOKENS = 8000
MAX_RETRY = 3


def api_call(protocol: str, model: str, system: str, user: str) -> str:
    if protocol == "anthropic":
        base = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
        key = os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY", "")
        headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01",
                   "Authorization": f"Bearer {key}"}
        body = {"model": model, "max_tokens": BATCH_MAX_TOKENS, "temperature": 0,
                "thinking": {"type": "disabled"}, "system": system,
                "messages": [{"role": "user", "content": user}]}
        url = f"{base}/v1/messages"
    else:  # openai 兼容
        base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        key = os.environ.get("OPENAI_API_KEY", "")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
        body = {"model": model, "max_tokens": BATCH_MAX_TOKENS, "temperature": 0,
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": user}]}
        url = f"{base}/chat/completions"

    req = urllib.request.Request(url, json.dumps(body).encode(), headers)
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.load(resp)
    if protocol == "anthropic":
        return "".join(b.get("text", "") for b in data.get("content", []))
    return data["choices"][0]["message"]["content"]


def parse_batch(text: str) -> list[dict] | None:
    """剥围栏 -> JSON 数组 -> 逐条校验字段；坏任一条整批判失败"""
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
        if not isinstance(d, dict):
            return None
        word = d.get("word")
        headword = d.get("headword")
        senses = d.get("senses")
        if not isinstance(word, str) or not word.strip():
            return None
        if not isinstance(headword, str) or not headword.strip():
            return None
        if not isinstance(senses, list) or not senses:
            return None
        clean = []
        for s in senses[:4]:
            if not isinstance(s, dict) or not isinstance(s.get("zh"), str) or not s["zh"].strip():
                return None
            entry = {"zh": s["zh"].strip()}
            if isinstance(s.get("pos"), list):
                entry["pos"] = [p for p in s["pos"] if isinstance(p, str)]
            clean.append(entry)
        out.append({
            "word": word.strip(),
            "headword": headword.strip(),
            "reading": d.get("reading") if isinstance(d.get("reading"), str) else "",
            "pos": [p for p in d.get("pos", []) if isinstance(p, str)],
            "senses": clean,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", required=True)
    ap.add_argument("--language-name", required=True, help="语言中文名（进提示词）")
    ap.add_argument("--words", required=True, help="词单文件：每行一个词或 词<TAB>频次")
    ap.add_argument("--protocol", choices=["openai", "anthropic"], default="anthropic")
    ap.add_argument("--model", required=True)
    ap.add_argument("--batch", type=int, default=20)
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 个词（0=全部）")
    ap.add_argument("--work-dir", default="", help="缺省 data/work/<lang>")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不联网不写文件")
    args = ap.parse_args()

    if not re.fullmatch(r"[a-z]{2,4}", args.lang):
        ap.error(f"--lang {args.lang!r} 不合法（2-4 位小写字母）")

    work = Path(args.work_dir) if args.work_dir else common.WORK / args.lang
    words: list[tuple[str, float]] = []
    for raw in open(args.words, encoding="utf-8"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        w = parts[0].strip()
        if not w:
            continue
        try:
            freq = min(100.0, max(0.0, float(parts[1]))) if len(parts) > 1 else 0.0
        except ValueError:
            freq = 0.0
        words.append((w, freq))
    if args.limit > 0:
        words = words[: args.limit]
    if not words:
        common.log("词单为空")
        sys.exit(1)

    # 断点：已生成的词跳过
    done: dict[str, dict] = {}
    prog = work / "llm_entries.jsonl"
    if prog.exists():
        for line in open(prog, encoding="utf-8"):
            line = line.strip()
            if line:
                try:
                    d = json.loads(line)
                    done[d["word"]] = d
                except Exception:
                    pass
    todo = [(w, f) for w, f in words if w not in done]
    common.log(f"词单 {len(words)} 个，已完成 {len(done)}，待生成 {len(todo)}")

    if args.dry_run:
        for w, f in todo[:10]:
            common.log(f"  [dry] {w} (freq={f})")
        common.log(f"[dry] 共 {len(todo)} 个待生成，批大小 {args.batch}，协议 {args.protocol}")
        return

    work.mkdir(parents=True, exist_ok=True)
    system = "你是双语词典编纂者。只输出 JSON，不要围栏、不要多余文字。"
    n_ok = n_skip = 0
    for i in range(0, len(todo), args.batch):
        chunk = todo[i : i + args.batch]
        wl = "\n".join(f"- {w}" for w, _ in chunk)
        user = (
            f"为以下{args.language_name}（{args.lang}）词语编写词典词条，输入输出一一对应。"
            f"每个词输出：word（原样返回输入词）、headword（规范词头）、reading（读音，无则空串）、"
            f"pos（词性数组如 [\"n.\"]）、senses（1-4 条，每条 {{\"pos\": [...], \"zh\": \"中文释义\"}}）。"
            f"输出 JSON 数组，顺序与输入一致。\n\n{wl}"
        )
        rows = None
        for attempt in range(MAX_RETRY):
            try:
                rows = parse_batch(api_call(args.protocol, args.model, system, user))
            except Exception as e:  # noqa: BLE001
                common.log(f"[warn] 批 {i // args.batch} 网络错误(第 {attempt + 1} 次): {e}")
                time.sleep(5 * (attempt + 1))
                continue
            if rows is None:
                common.log(f"[warn] 批 {i // args.batch} 输出不合法(第 {attempt + 1} 次)，重试")
                continue
            got = {r["word"] for r in rows}
            want = {w for w, _ in chunk}
            if got != want or len(rows) != len(chunk):
                common.log(f"[warn] 批 {i // args.batch} 词集不对应(第 {attempt + 1} 次)，重试")
                rows = None
                continue
            break
        if rows is None:
            n_skip += len(chunk)
            common.log(f"[fail] 批 {i // args.batch} 放弃（重跑可续）")
            continue
        with open(prog, "a", encoding="utf-8") as f:
            for (w, freq), r in zip(chunk, rows):
                entry = {
                    "word": w, "headword": r["headword"], "reading": r["reading"],
                    "pos": r["pos"], "senses": r["senses"], "freq": freq,
                    "norm": common.norm(r["headword"], args.lang),
                }
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                done[w] = entry
                n_ok += 1

    # 组装 entries.jsonl（构建协议）+ 空 forms.jsonl；原子写
    entries = []
    for w, freq in words:
        d = done.get(w)
        if not d:
            continue
        zh_terms = [[s["zh"], i, "llm"] for i, s in enumerate(d["senses"]) if s.get("zh")]
        entries.append({
            "headword": d["headword"], "norm": d["norm"], "reading": d["reading"] or None,
            "ipa": None, "pos": d["pos"], "gender": None, "freq": d["freq"],
            "senses": d["senses"], "zh_terms": zh_terms,
            "extra": {"source": "llm", "model": args.model},
        })
    for name, rows_ in (("entries.jsonl", entries), ("forms.jsonl", [])):
        tmp = work / f"{name}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for r in rows_:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        os.replace(tmp, work / name)
    common.log(f"完成：生成 {n_ok}，跳过 {n_skip} -> {work / 'entries.jsonl'}（{len(entries)} 条）")
    if n_skip:
        sys.exit(1)


if __name__ == "__main__":
    main()
