"""直调 API 复核：核对切片产出，只把有问题的行修正写入 .fix.jsonl。

用法: python3 refine_review_api.py <slice.input.jsonl>
瞬时失败重试 3 次；网关内容过滤(1301)拒批时二分到单词级，过不了的不复核。
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

BATCH = 200
MODEL = os.environ.get("PODIC_REFINE_MODEL", "glm-5.3-flash")

SYSTEM = (
    "你是词典数据质检员。给定词条表和对应的中文释义产出，逐行核对："
    "1. headword 一致；2. senses 非空且 zh 以词性缩写开头；3. 释义与该词实际含义相符；"
    "4. zh 里没有残留英文/法文原词。只输出有问题的行的修正结果，严格 JSON 数组，"
    '格式 {"headword":"原样","senses":[{"zh":"词性缩写. 修正后中文释义"}]}；没有问题输出 []。'
    "不要输出任何思考过程，直接给出结论。"
)


class Sensitive(Exception):
    """网关内容过滤(1301)拒批，需二分定位。"""


class InvalidThinking(Exception):
    """网关后端不支持 thinking 参数，重发时去掉该字段。"""


class Truncated(Exception):
    """响应无 text 块（思考块烧光 max_tokens 等），需二分重试。"""


def call_api(batch, with_thinking=True):
    body = {"model": MODEL, "max_tokens": 8000, "temperature": 0,
            "system": SYSTEM,
            "messages": [{"role": "user", "content": f"词条表与产出：{json.dumps(batch, ensure_ascii=False)}"}]}
    if with_thinking:
        body["thinking"] = {"type": "disabled"}
    req = urllib.request.Request(
        os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/") + "/v1/messages",
        json.dumps(body, ensure_ascii=False).encode("utf-8"),
        {"Content-Type": "application/json",
         "x-api-key": os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN", ""),
         "anthropic-version": "2023-06-01"})
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        if e.code == 400:
            if "1301" in err or "SensitiveContentDetected" in err:
                raise Sensitive from None
            if "thinking" in err and "InvalidParameter" in err:
                raise InvalidThinking from None
        raise
    return "".join(b.get("text", "") for b in data.get("content", []))


def apply_batch(chunk, outputs, fixes):
    try:
        text = call_api(chunk)
    except InvalidThinking:
        text = call_api(chunk, with_thinking=False)
    if not text.strip():
        raise Truncated
    t = text.strip()
    if t.startswith("```"):
        t = t.split("```")[1].removeprefix("json")
    rows = json.loads(t)
    for r in rows if isinstance(rows, list) else []:
        if isinstance(r, dict) and r.get("headword") in outputs and r.get("senses"):
            fixes[r["headword"]] = r


def review_chunk(chunk, outputs, fixes):
    """重试 3 次；1301/无 text 块则二分。"""
    for attempt in range(3):
        try:
            apply_batch(chunk, outputs, fixes)
            return
        except (Sensitive, Truncated):
            if len(chunk) == 1:
                common.log(f"[skip] 无法复核: {chunk[0]['headword']}")
                return
            mid = len(chunk) // 2
            review_chunk(chunk[:mid], outputs, fixes)
            review_chunk(chunk[mid:], outputs, fixes)
            return
        except Exception as e:  # noqa: BLE001
            common.log(f"[warn] 复核批第 {attempt + 1} 次失败: {e}")
            time.sleep(5 * (attempt + 1))


def main():
    input_path = Path(sys.argv[1])
    out_path = input_path.with_name(input_path.name.replace(".input.jsonl", ".output.jsonl"))
    fix_path = input_path.with_name(input_path.name.replace(".input.jsonl", ".fix.jsonl"))
    if not out_path.exists() or fix_path.exists():
        return

    inputs = {json.loads(l)["headword"]: json.loads(l)
              for l in input_path.read_text(encoding="utf-8").splitlines() if l.strip()}
    outputs = {json.loads(l)["headword"]: json.loads(l)
               for l in out_path.read_text(encoding="utf-8").splitlines() if l.strip()}

    heads = list(outputs.keys())
    fixes = {}
    for i in range(0, len(heads), BATCH):
        chunk = [{"headword": h, "input": inputs.get(h), "output": outputs[h]}
                 for h in heads[i : i + BATCH]]
        review_chunk(chunk, outputs, fixes)

    with open(fix_path, "w", encoding="utf-8") as f:
        for r in fixes.values():
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    common.log(f"[done] {fix_path.name}: 修正 {len(fixes)}/{len(heads)}")


if __name__ == "__main__":
    main()
