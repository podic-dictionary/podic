"""构建期 LLM 精修：给高频词补全中文释义 + 例句。

- 输入: data/work/{lang}/entries.jsonl（按 freq 或 --rank-file 词频排序取 top N）
- 输出: data/work/{lang}/refined.jsonl（完整精修数据，断点续跑幂等）
        合并阶段把 senses.zh / extra.refined 写回 entries.jsonl，
        例句追加到 sentences.jsonl / entry_sentence.jsonl（负数 id，与 Tatoeba 共存）
- LLM: Anthropic 协议直调（ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN；可选 ANTHROPIC_BASE_URL）
- 失败批次本次跳过，下次运行自动重试

用法: python3 refine_llm.py --lang fr --limit 5000 [--batch 20] [--model glm-5.3] [--dry-run]
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

BATCH_MAX_TOKENS = 8000
LANG_NAME = {"en": "英语", "fr": "法语", "ja": "日语"}


def api_call(base_url: str, key: str, model: str, system: str, user: str, use_bearer: bool) -> str:
    body = {
        "model": model,
        "max_tokens": BATCH_MAX_TOKENS,
        "temperature": 0,
        "thinking": {"type": "disabled"},
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
    if use_bearer:
        headers["Authorization"] = f"Bearer {key}"
    else:
        headers["x-api-key"] = key
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/messages", json.dumps(body).encode(), headers
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.load(resp)
    return "".join(b.get("text", "") for b in data.get("content", []))


def load_rank(rank_file: Path) -> dict[str, int]:
    ranks = {}
    for line in open(rank_file, encoding="utf-8"):
        parts = line.rstrip("\n").split("\t")
        if len(parts) >= 2:
            try:
                ranks[parts[0]] = int(parts[1])
            except ValueError:
                pass
    return ranks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", required=True, choices=["en", "fr", "ja"])
    ap.add_argument("--limit", type=int, default=5000)
    ap.add_argument("--batch", type=int, default=20)
    ap.add_argument("--model", default=os.environ.get("PODIC_REFINE_MODEL", "glm-5.3"))
    ap.add_argument("--rank-file", help="headword<TAB>count 词频文件（覆盖默认 freq 排序）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    base_url = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
    key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
    if not key and not args.dry_run:
        common.log("缺少 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN")
        sys.exit(1)

    work = common.WORK / args.lang
    entries_path = work / "entries.jsonl"
    entries = list(common.read_jsonl(entries_path))

    # 候选排序
    if args.rank_file and Path(args.rank_file).exists():
        ranks = load_rank(Path(args.rank_file))
        for e in entries:
            e["_rank"] = ranks.get(e["headword"], ranks.get(e["norm"], 0))
        candidates = sorted(
            (e for e in entries if e.get("_rank", 0) > 0), key=lambda x: -x["_rank"]
        )
    else:
        candidates = sorted(entries, key=lambda x: -x.get("freq", 0))

    refined_path = work / "refined.jsonl"
    # 已精修过的 headword（完整数据都在 refined.jsonl，幂等合并）
    refined_data: dict[str, dict] = {}
    if refined_path.exists():
        for r in common.read_jsonl(refined_path):
            if r.get("headword") and r.get("senses"):
                refined_data[r["headword"]] = r
    todo = [e for e in candidates if e["headword"] not in refined_data][: args.limit]
    common.log(f"候选 {len(candidates)}，已精修 {len(refined_data)}，待精修 {len(todo)}")

    if not args.dry_run:
        n_batch = (len(todo) + args.batch - 1) // args.batch
        n_err = 0
        with open(refined_path, "a", encoding="utf-8") as out:
            for bi in range(n_batch):
                chunk = todo[bi * args.batch : (bi + 1) * args.batch]
                words_payload = []
                for e in chunk:
                    en_glosses = [
                        s.get("en") or s.get("fr") for s in (e.get("senses") or []) if isinstance(s, dict)
                    ]
                    words_payload.append({
                        "headword": e["headword"],
                        "reading": e.get("reading"),
                        "pos": e.get("pos"),
                        "gender": e.get("gender"),
                        "existing_glosses": [g for g in en_glosses if g][:4] or None,
                    })
                user = (
                    f"为以下 {len(chunk)} 个{LANG_NAME[args.lang]}词条给出中文释义和例句。"
                    "要求：义项按常用度排序（1-3 个），每个义项以词性缩写开头（如 n. / v. / adj.）；"
                    "每个词条给 2 个例句（覆盖不同义项）并附中文翻译。\n"
                    f"输入：{json.dumps(words_payload, ensure_ascii=False)}\n"
                    '输出格式：[{"headword": "...", "senses": [{"zh": "n. 中文释义"}], '
                    '"examples": [{"text": "例句", "zh": "中文翻译"}]}]'
                )

                result = None
                for attempt in range(2):
                    try:
                        raw = api_call(
                            base_url, key, args.model, system_prompt(), user,
                            use_bearer=bool(os.environ.get("ANTHROPIC_AUTH_TOKEN")),
                        )
                        raw = raw.strip()
                        if raw.startswith("```"):
                            raw = raw.split("```")[1].removeprefix("json")
                        result = json.loads(raw)
                        break
                    except Exception as e:  # noqa: BLE001
                        common.log(f"[warn] 批次 {bi + 1} 第 {attempt + 1} 次失败: {e}")
                        time.sleep(3)

                if result is None:
                    n_err += 1
                    continue  # 不落盘，下次运行自动重试

                merged = 0
                for r in result:
                    if isinstance(r, dict) and r.get("headword") and r.get("senses"):
                        out.write(json.dumps(r, ensure_ascii=False) + "\n")
                        refined_data[r["headword"]] = r
                        merged += 1
                out.flush()
                common.log(f"[{bi + 1}/{n_batch}] 批内合并 {merged}/{len(chunk)}")
        if n_err:
            common.log(f"错误批次 {n_err}（下次运行重试）")

    # ---- 合并回 entries.jsonl + 例句文件 ----
    neg_id = -1
    sent_path = work / "sentences.jsonl"
    es_path = work / "entry_sentence.jsonl"
    existing_sent_ids = set()
    if sent_path.exists():
        existing_sent_ids = {s["id"] for s in common.read_jsonl(sent_path)}
    sent_rows, es_rows = [], []
    for e in entries:
        r = refined_data.get(e["headword"])
        if not r:
            e.pop("_rank", None)
            continue
        # 用精修义项覆盖前 N 个 sense，保留后续原有 gloss
        new_senses = [{"zh": s.get("zh") or s.get("pos", "")} for s in (r.get("senses") or [])]
        old = e.get("senses") or []
        for i, s in enumerate(new_senses):
            if i < len(old) and isinstance(old[i], dict):
                keep = {k: v for k, v in old[i].items() if k in ("en", "fr", "kind", "tags")}
                s.update(keep)
        e["senses"] = new_senses + old[len(new_senses):]
        e.setdefault("extra", {})["refined"] = True
        for ex in (r.get("examples") or [])[:2]:
            if ex.get("text") and ex.get("zh") and neg_id not in existing_sent_ids:
                sent_rows.append({"id": neg_id, "text": ex["text"], "translation": [ex["zh"]]})
                es_rows.append({"entry_norm": e["norm"], "sentence_id": neg_id, "score": 5.0})
                existing_sent_ids.add(neg_id)
                neg_id -= 1
        e.pop("_rank", None)

    with open(entries_path, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    if sent_rows:
        with open(sent_path, "a", encoding="utf-8") as f:
            for s in sent_rows:
                f.write(json.dumps(s, ensure_ascii=False) + "\n")
        with open(es_path, "a", encoding="utf-8") as f:
            for r in es_rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    common.log(f"完成：合并 {len(refined_data)} 词条，AI 例句 {len(sent_rows)}")


def system_prompt() -> str:
    return (
        "你是双语词典编纂者，负责把词典条目的释义补全为简体中文。"
        "只输出严格 JSON 数组，不要 markdown 代码块、不要任何解释文字。"
    )


if __name__ == "__main__":
    main()
