"""直调 API 处理单个精修切片（绕过 claude CLI 会话开销）。

用法: python3 refine_slice_api.py <slice.input.jsonl>
输出: 同目录 <slice>.output.jsonl（只含成功行，按 headword 匹配合并），原子写入。
一批最多 400 词（实测 400 词 ≈ 13.7k 输出 token，未截断、有效率 100%）。
"""

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

BATCH = 400
MAX_TOKENS = 16384
MODEL = os.environ.get("PODIC_REFINE_MODEL", "glm-5.3-flash")

SYSTEM = (
    "你是双语词典编纂者，把词条释义补全为简体中文。只输出严格 JSON 数组，不要 markdown 代码块。"
    '每行格式 {"headword":"原样","senses":[{"zh":"词性缩写. 中文释义"}]}，'
    "义项 1-3 个按常用度排序，zh 以词性缩写开头（n./v./adj./adv./prep. 等），基于已有释义翻译整理，不得编造。"
)


def call_api(batch: list[dict]) -> tuple[list[dict], float]:
    body = {"model": MODEL, "max_tokens": MAX_TOKENS, "temperature": 0,
            "thinking": {"type": "disabled"}, "system": SYSTEM,
            "messages": [{"role": "user", "content": f"输入：{json.dumps(batch, ensure_ascii=False)}"}]}
    req = urllib.request.Request(
        os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/") + "/v1/messages",
        json.dumps(body).encode(),
        {"Content-Type": "application/json",
         "x-api-key": os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN", ""),
         "anthropic-version": "2023-06-01"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as resp:
        data = json.load(resp)
    text = "".join(b.get("text", "") for b in data.get("content", []))
    return text, time.time() - t0


def parse(text: str, heads: set[str]) -> dict[str, dict]:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("```")[1].removeprefix("json")
    rows = []
    try:
        rows = json.loads(t)
    except json.JSONDecodeError:
        m = re.search(r"\[.*\]", t, re.S)
        if m:
            try:
                rows = json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    out = {}
    for r in rows:
        if isinstance(r, dict) and r.get("headword") in heads and r.get("senses"):
            clean = [{"zh": str(s["zh"])} for s in r["senses"][:4]
                     if isinstance(s, dict) and s.get("zh")]
            if clean:
                out[r["headword"]] = {"headword": r["headword"], "senses": clean}
    return out


def main():
    input_path = Path(sys.argv[1])
    out_path = input_path.with_name(input_path.name.replace(".input.jsonl", ".output.jsonl"))
    if out_path.exists():
        common.log(f"[skip] {out_path.name} 已存在")
        return

    inputs = [json.loads(l) for l in input_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    by_head = {w["headword"]: w for w in inputs}
    results: dict[str, dict] = {}

    for i in range(0, len(inputs), BATCH):
        chunk = inputs[i : i + BATCH]
        for attempt in range(3):
            try:
                text, dt = call_api(chunk)
                got = parse(text, {w["headword"] for w in chunk})
                results.update(got)
                common.log(f"  {input_path.name}[{i}:{i+len(chunk)}] {dt:.0f}s 有效 {len(got)}/{len(chunk)}")
                break
            except Exception as e:  # noqa: BLE001
                common.log(f"[warn] {input_path.name} 批 {i} 第 {attempt+1} 次失败: {e}")
                time.sleep(5 * (attempt + 1))

    # 缺失行补打（一轮）
    missing = [by_head[h] for h in by_head if h not in results]
    if missing:
        common.log(f"  {input_path.name} 补打 {len(missing)} 行")
        for i in range(0, len(missing), 100):
            chunk = missing[i : i + 100]
            try:
                text, _ = call_api(chunk)
                results.update(parse(text, {w["headword"] for w in chunk}))
            except Exception as e:  # noqa: BLE001
                common.log(f"[warn] 补打失败: {e}")

    # 原子写
    tmp = out_path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for w in inputs:
            r = results.get(w["headword"])
            if r:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    tmp.rename(out_path)
    common.log(f"[done] {out_path.name}: {len(results)}/{len(inputs)}")


if __name__ == "__main__":
    main()
