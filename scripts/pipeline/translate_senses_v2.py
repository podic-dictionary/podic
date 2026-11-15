"""sense-level 中文释义翻译（v2）：以义项外文原文为键，全局去重翻译。

v1（translate_senses_llm.py）按词头翻译的三类根因缺陷：
- 同 headword 多词条（ja 190 组）共用一份 zh 列表 → 义项错位
- 长义项词（「と」20 义）输出截断 → 尾部义项永远空
- 模型输出带义项编号（"5. ..."）污染 zh

v2 逐义项翻译（唯一 src 文本全局去重），天然免疫以上三类；顺带修复
zh==外文原文、纯 ASCII zh（ECDICT 英文残留）。

- 输入: data/work/{lang}/entries.jsonl
- 需翻判定: senses[i].src 非空 且 zh 为 空/等于src/纯ASCII/带编号前缀
- 断点: work/sense-translations.jsonl（src sha1 → zh），重跑只补缺失
- 兜底: glm 拒答/坏输出 → 本机 llama（LLAMA_BASE_URL）逐条
- 写回: 按 src 精确匹配填 zh（不动的已有合法 zh），zh_terms 全量重建

用法: python3 translate_senses_v2.py --lang ja --src-field en [--model glm-5.3-flash]
      [--batch 40] [--concurrency 4] [--limit N] [--dry-run]
      en 包用 --src-field zh --src-is-zh（zh 本身是英文残留，当原文翻）
"""

import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common
from translate_senses_llm import api_call, llama_call, parse_batch, ApiReject, split_zh

MAX_RETRY = 3
NUM_PREFIX = re.compile(r"^\s*\d{1,2}[\.、]\s*")


def parse_rows(text: str) -> list[dict] | None:
    """[{"i": int, "zh": str}] 数组解析；坏输出返回 None"""
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
        i, zh = d.get("i"), d.get("zh")
        if not isinstance(i, int) or not isinstance(zh, str) or not zh.strip():
            return None
        out.append({"i": i, "zh": zh.strip()})
    return out


def needs_fix(zh: str | None, src: str, src_is_zh: bool = False) -> bool:
    """zh 无效判定：空 / 等于原文 / 纯 ASCII（英文残留）/ 带义项编号前缀。
    src_is_zh（en 包：zh 本身是英文残留当原文翻）时跳过 ==src 判断——恒真无意义"""
    if not src:
        return False
    z = (zh or "").strip()
    if not z:
        return True
    if not src_is_zh and z == src.strip():
        return True
    if z.isascii() and len(z) >= 1:
        return True
    if NUM_PREFIX.match(z):
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", required=True)
    ap.add_argument("--src-field", required=True, help="外文释义字段（en/fr）；en 包用 zh")
    ap.add_argument("--model", default="glm-5.3-flash")
    ap.add_argument("--language-name", required=True)
    ap.add_argument("--batch", type=int, default=40)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--min-senses", type=int, default=0,
                    help="只处理义项数 >= N 的词条（v1 词条级翻译的错位风险集）")
    ap.add_argument("--force-overwrite", action="store_true",
                    help="写回时 src 有翻译即覆盖（修复形式合法但语义错位的 v1 产物）")
    ap.add_argument("--only-untagged", action="store_true",
                    help="只处理含无 tags 义项的词条（v1 LLM 批翻产物无 tags，原生数据有）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    work = common.WORK / args.lang
    entries = [json.loads(l) for l in open(work / "entries.jsonl", encoding="utf-8") if l.strip()]

    # 收集需翻的唯一义项原文
    src_map: dict[str, str] = {}  # sha1[:16] -> src
    n_senses = 0
    for e in entries:
        if args.min_senses and len(e.get("senses", [])) < args.min_senses:
            continue
        if args.only_untagged and not any(not (s.get("tags") or s.get("kind")) for s in e.get("senses", [])):
            continue
        for s in e.get("senses", []):
            is_zh_src = args.src_field == "zh"
            src = (s.get(args.src_field) or s.get("zh") or "").strip() if is_zh_src else (s.get(args.src_field) or "").strip()
            if src and (args.force_overwrite or needs_fix(s.get("zh"), src, is_zh_src)):
                n_senses += 1
                h = hashlib.sha1(src.encode()).hexdigest()[:16]
                src_map.setdefault(h, src)
    todo_keys = list(src_map)
    if args.limit > 0:
        todo_keys = todo_keys[: args.limit]
    common.log(f"总 {len(entries)} 词条，待修义项 {n_senses}，唯一原文 {len(src_map)}，本轮翻 {len(todo_keys)}")
    if args.dry_run:
        for h in todo_keys[:5]:
            print(f"  [dry] {src_map[h][:70]}")
        return

    # llama 兜底模型
    args.llama_model = ""
    try:
        base = os.environ.get("LLAMA_BASE_URL", "http://127.0.0.1:18080").rstrip("/")
        with urllib.request.urlopen(f"{base}/v1/models", timeout=5) as r:
            m0 = json.load(r)["models"][0]
            args.llama_model = m0.get("id") or m0.get("model") or m0.get("name") or ""
        common.log(f"llama 兜底模型: {args.llama_model}")
    except Exception:
        common.log("llama 兜底不可用")

    # 断点
    prog = work / "sense-translations.jsonl"
    done: dict[str, str] = {}
    if prog.exists():
        for line in open(prog, encoding="utf-8"):
            line = line.strip()
            if line:
                try:
                    d = json.loads(line)
                    done[d["h"]] = d["zh"]
                except Exception:
                    pass
    todo = [h for h in todo_keys if h not in done]
    common.log(f"断点已有 {len(done)}，剩余 {len(todo)}")

    system = "你是双语词典编纂者。把外语词典释义翻译成简洁的中文词典释义（简体、词典体）。只输出 JSON，不要围栏。"
    lock = threading.Lock()
    stats = {"ok": 0, "skip": 0}

    def glm_batch(idx: int, chunk: list[str]) -> list[dict] | None:
        wl = "\n".join(f"{i+1}. {src_map[h]}" for i, h in enumerate(chunk))
        user = (
            f"把以下{args.language_name}词典释义逐条翻译成简洁的中文词典释义。"
            f'输出 JSON 数组 [{{"i": 序号, "zh": "中文"}}]，序号与条目一一对应、一条不落。\n\n{wl}'
        )
        for attempt in range(MAX_RETRY):
            try:
                rows = parse_rows(api_call(args.model, system, user, min(16000, args.batch * 120 + 400)))
                if rows is None:
                    continue
                got = {r.get("i") for r in rows if isinstance(r.get("i"), int)}
                want = set(range(1, len(chunk) + 1))
                if got != want:
                    common.log(f"  [warn] 批 {idx} 序号不齐(第 {attempt + 1} 次): 缺 {sorted(want - got)[:5]}")
                    continue
                return rows
            except ApiReject:
                return None
            except Exception as ex:
                common.log(f"  [warn] 批 {idx} 网络错误: {ex}")
                time.sleep(3 * (attempt + 1))
        return None

    def llama_one(h: str) -> str | None:
        if not args.llama_model:
            return None
        for _ in range(3):
            try:
                out = llama_call(args.llama_model, system,
                    f'翻译成简洁中文词典释义，只输出 {{"i": 1, "zh": "中文"}} 这一个 JSON 对象。\n1. {src_map[h]}', 300)
                rows = parse_rows(f"[{out}]")
                if rows and rows[0].get("i") == 1 and rows[0].get("zh"):
                    return rows[0]["zh"]
            except Exception:
                pass
        return None

    def run(idx: int, chunk: list[str]):
        rows = glm_batch(idx, chunk)
        out: list[tuple[str, str]] = []
        if rows is not None:
            out = [(chunk[r["i"] - 1], r["zh"]) for r in rows if isinstance(r.get("zh"), str) and r["zh"].strip()]
        else:
            for h in chunk:  # 逐条 llama 兜底（部分成功）
                z = llama_one(h)
                if z:
                    out.append((h, z))
                else:
                    with lock:
                        with open(work / "llama-failed.txt", "a", encoding="utf-8") as f:
                            f.write(src_map[h].split("\n")[0] + "\n")
        with lock:
            if out:
                with open(prog, "a", encoding="utf-8") as f:
                    for h, z in out:
                        f.write(json.dumps({"h": h, "zh": z}, ensure_ascii=False) + "\n")
                        done[h] = z
                stats["ok"] += len(out)
            stats["skip"] += len(chunk) - len(out)
            if stats["ok"] % 1000 < len(out):
                common.log(f"[进度] 已译 {stats['ok']}，跳过 {stats['skip']}")

    chunks = [todo[i : i + args.batch] for i in range(0, len(todo), args.batch)]
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for idx, chunk in enumerate(chunks):
            pool.submit(run, idx, chunk)
    common.log(f"翻译完成：{stats['ok']}，跳过 {stats['skip']}")

    # 写回：按 src 匹配填 zh；合法 zh 不动；编号残留清洗；zh_terms 全量重建
    n_fill = n_strip = 0
    out_lines = []
    for e in entries:
        ss = e.get("senses", [])
        for s in ss:
            is_zh_src = args.src_field == "zh"
            src = (s.get(args.src_field) or s.get("zh") or "").strip() if is_zh_src else (s.get(args.src_field) or "").strip()
            zh = (s.get("zh") or "")
            if zh and NUM_PREFIX.match(zh):
                s["zh"] = NUM_PREFIX.sub("", zh)  # 编号残留清洗
                n_strip += 1
            if src and (args.force_overwrite or not zh or needs_fix(zh, src)):
                h = hashlib.sha1(src.encode()).hexdigest()[:16]
                z = done.get(h)
                if z and z != s.get("zh"):
                    s["zh"] = z
                    n_fill += 1
        if any(s.get("zh") for s in ss):
            e["zh_terms"] = [[t, i, "llm"] for i, s in enumerate(ss) if s.get("zh")
                             for t in split_zh(s["zh"])]
        out_lines.append(json.dumps(e, ensure_ascii=False))
    tmp = work / "entries.jsonl.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")
    os.replace(tmp, work / "entries.jsonl")
    common.log(f"写回 entries.jsonl：补义项 {n_fill}，清编号 {n_strip}")


if __name__ == "__main__":
    main()
