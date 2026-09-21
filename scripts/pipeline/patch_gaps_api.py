"""补齐切片产出的缺失行：只对 output 里缺的 headword 再调 API，原子重写。

用法: python3 patch_gaps_api.py <slice.input.jsonl> [<slice2> ...]
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

BATCH = 100
MAX_TOKENS = 8192
MODEL = os.environ.get("PODIC_REFINE_MODEL", "glm-5.3-flash")

SYSTEM = (
    "你是双语词典编纂者，把词条释义补全为简体中文。只输出严格 JSON 数组，不要 markdown 代码块。"
    '每行格式 {"headword":"原样","senses":[{"zh":"词性缩写. 中文释义"}]}，'
    "义项 1-3 个按常用度排序，zh 以词性缩写开头（n./v./adj./adv./prep. 等），基于已有释义翻译整理，不得编造。"
)


def call_api(batch: list[dict]) -> str:
    body = {"model": MODEL, "max_tokens": MAX_TOKENS, "temperature": 0,
            "thinking": {"type": "disabled"}, "system": SYSTEM,
            "messages": [{"role": "user", "content": f"输入：{json.dumps(batch, ensure_ascii=False)}"}]}
    req = urllib.request.Request(
        os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/") + "/v1/messages",
        json.dumps(body).encode(),
        {"Content-Type": "application/json",
         "x-api-key": os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN", ""),
         "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        data = json.load(resp)
    return "".join(b.get("text", "") for b in data.get("content", []))


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


class Sensitive(Exception):
    """网关内容过滤(1301)拒批，需二分定位。"""

    def __init__(self, batch):
        super().__init__("1301 sensitive")
        self.batch = batch


class InvalidThinking(Exception):
    """网关后端不支持 thinking 参数，重发时去掉该字段。"""


def do_request(batch: list[dict], with_thinking: bool) -> str:
    body = {"model": MODEL, "max_tokens": MAX_TOKENS, "temperature": 0,
            "system": SYSTEM,
            "messages": [{"role": "user", "content": f"输入：{json.dumps(batch, ensure_ascii=False)}"}]}
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
                raise Sensitive(batch) from None
            if "thinking" in err and "InvalidParameter" in err:
                raise InvalidThinking from None
        raise
    return "".join(b.get("text", "") for b in data.get("content", []))


def call_batch(batch: list[dict], into: dict) -> None:
    """成功则把解析结果并入 into；撞 1301 抛 Sensitive(batch)。"""
    heads = {w["headword"] for w in batch}
    text = ""
    try:
        text = do_request(batch, with_thinking=True)
    except InvalidThinking:
        text = do_request(batch, with_thinking=False)
    got = parse(text, heads)
    if not got and text.strip():
        common.log(f"[warn] 空产出(非敏感，原文前80): {text.strip()[:80]!r}")
    into.update(got)


def run_chunk(chunk: list[dict], results: dict, skipped: list[str]) -> None:
    """带重试跑一个批；1301 则二分到单词级，过不了的记 skipped。"""
    for attempt in range(4):
        try:
            call_batch(chunk, results)
            return
        except Sensitive as s:
            if len(chunk) == 1:
                skipped.append(chunk[0]["headword"])
                common.log(f"[skip] 敏感过滤: {chunk[0]['headword']}")
                return
            mid = len(s.batch) // 2
            run_chunk(s.batch[:mid], results, skipped)
            run_chunk(s.batch[mid:], results, skipped)
            return
        except Exception:  # noqa: BLE001
            time.sleep(5 * (attempt + 1))
    common.log(f"[warn] 批最终失败，留待下轮: {len(chunk)} 行")


def process(inp: Path) -> None:
    out = inp.with_name(inp.name.replace(".input.jsonl", ".output.jsonl"))
    inputs = [json.loads(l) for l in inp.read_text(encoding="utf-8").splitlines() if l.strip()]
    have: dict[str, dict] = {}
    if out.exists():
        for l in out.read_text(encoding="utf-8").splitlines():
            if l.strip():
                r = json.loads(l)
                have[r["headword"]] = r
    missing = [w for w in inputs if w["headword"] not in have]
    if not missing:
        common.log(f"[skip] {out.name} 无缺口")
        return
    common.log(f"{out.name}: 补 {len(missing)}/{len(inputs)} 行")
    skipped: list[str] = []
    for i in range(0, len(missing), BATCH):
        chunk = missing[i : i + BATCH]
        run_chunk(chunk, have, skipped)
        time.sleep(1)
    if skipped:
        common.log(f"{out.name}: 敏感跳过 {len(skipped)} 词: {' '.join(skipped[:20])}")
    tmp = out.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for w in inputs:
            r = have.get(w["headword"])
            if r:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    tmp.rename(out)
    common.log(f"[done] {out.name}: {len(have)}/{len(inputs)}")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        process(Path(p))
