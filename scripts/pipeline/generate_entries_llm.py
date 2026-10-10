"""LLM 从零生成语言词条：词单 -> entries.jsonl（多语言化自定义词典包的生成器）。

与 refine_llm.py 的分工：refine 是「给已有词条补释义」，本脚本从词单起建词条
（多语言化后用户为新注册语言构建 community 词典包的第一步）。

- 输入: 词单文件（每行一个词，或 `词<TAB>频次`；UTF-8）
- 输出: <work-dir>/entries.jsonl + forms.jsonl（变位归一映射，输入词被模型归一成词典形时记 form）
- 断点: <work-dir>/llm_entries.jsonl 逐词追加（word 一行 JSON），重跑只补缺失词
- norm/频次由脚本计算（与 crates/podic-core/src/norm.rs 同步的 common.norm），不交给 LLM
- 协议: --protocol openai（OPENAI_BASE_URL/OPENAI_API_KEY）| anthropic（ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN 或 API_KEY）
- 并发: --concurrency N 个批任务并行（主模型限流时批间自动退避）
- 兜底: 主 API 拒批（内容审查/4xx 非限流）时整批转 --fallback-base-url（本机 llama.cpp
  等 openai 兼容端点，无内容过滤）重跑；仍失败才放弃（断点续跑可补）
- 严格校验: 每批输出必须与输入词一一对应（按 word 字段回配），漏词/多词/重复/字段非法整批重试

用法:
  python3 scripts/pipeline/generate_entries_llm.py --lang de --language-name 德语 \\
      --words words.txt --model glm-5.3-flash --batch 40 --concurrency 4 [--limit 1000] \\
      [--work-dir data/work/de] [--fallback-model qwen3.8-27b] [--dry-run]
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
# 每词输出预算（token）：宽松估值，避免大批输出被 max_tokens 截断
TOKENS_PER_WORD = 420


class ApiReject(Exception):
    """主 API 明确拒批（内容审查/参数 4xx）：应转兜底端点，重试无意义"""


def api_call(protocol: str, model: str, system: str, user: str, max_tokens: int,
             base_url: str = "", api_key: str = "") -> str:
    """endpoint 显式传参（线程安全）：兜底与主端点并发时不能靠改环境变量"""
    if protocol == "anthropic":
        base = (base_url or os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")).rstrip("/")
        key = api_key or os.environ.get("ANTHROPIC_AUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY", "")
        headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01",
                   "Authorization": f"Bearer {key}"}
        body = {"model": model, "max_tokens": max_tokens, "temperature": 0,
                "thinking": {"type": "disabled"}, "system": system,
                "messages": [{"role": "user", "content": user}]}
        url = f"{base}/v1/messages"
    else:  # openai 兼容
        base = (base_url or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")).rstrip("/")
        key = api_key or os.environ.get("OPENAI_API_KEY", "")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
        body = {"model": model, "max_tokens": max_tokens, "temperature": 0,
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": user}]}
        url = f"{base}/chat/completions"

    req = urllib.request.Request(url, json.dumps(body).encode(), headers)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        # 4xx 非限流 = 服务端明确拒绝（内容审查/参数非法），重试无用 → 兜底
        if 400 <= e.code < 500 and e.code not in (408, 429):
            raise ApiReject(f"HTTP {e.code}: {detail}")
        raise OSError(f"HTTP {e.code}: {detail}")  # 限流/网关错误：可重试
    if protocol == "anthropic":
        stop = data.get("stop_reason")
        if stop not in (None, "end_turn"):  # max_tokens 截断：输出必不完整
            raise ApiReject(f"stop_reason={stop}")
        return "".join(b.get("text", "") for b in data.get("content", []))
    finish = (data.get("choices") or [{}])[0].get("finish_reason")
    if finish not in (None, "stop"):  # length 截断
        raise ApiReject(f"finish_reason={finish}")
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
    ap.add_argument("--concurrency", type=int, default=4, help="并发批任务数（主 API 限流内）")
    ap.add_argument("--max-tokens", type=int, default=0,
                    help="每批输出 token 上限（0=按批大小自动估）")
    ap.add_argument("--fallback-base-url", default="http://127.0.0.1:18080/v1",
                    help="主 API 拒批时的兜底端点（openai 兼容；空串禁用兜底）")
    ap.add_argument("--fallback-model", default="",
                    help="兜底模型名（缺省沿用 --model）")
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

    batch_tokens = args.max_tokens or min(65536, args.batch * TOKENS_PER_WORD + 800)
    common.log(f"批大小 {args.batch}，并发 {args.concurrency}，每批 max_tokens {batch_tokens}")
    if args.dry_run:
        for w, f in todo[:10]:
            common.log(f"  [dry] {w} (freq={f})")
        common.log(f"[dry] 共 {len(todo)} 个待生成，协议 {args.protocol}")
        return

    work.mkdir(parents=True, exist_ok=True)
    system = "你是双语词典编纂者。只输出 JSON，不要围栏、不要多余文字。"
    lock = threading.Lock()
    stats = {"ok": 0, "skip": 0, "fallback": 0}
    fb_url = args.fallback_base_url.rstrip("/")
    fb_model = args.fallback_model or args.model

    def make_user(chunk: list[tuple[str, float]]) -> str:
        wl = "\n".join(f"- {w}" for w, _ in chunk)
        return (
            f"为以下{args.language_name}（{args.lang}）词语编写词典词条，输入输出一一对应。"
            f"每个词输出：word（原样返回输入词）、headword（规范词头）、reading（读音，无则空串）、"
            f"pos（词性数组如 [\"n.\"]）、senses（1-4 条，每条 {{\"pos\": [...], \"zh\": \"中文释义\"}}）。"
            f"输出 JSON 数组，顺序与输入一致。\n\n{wl}"
        )

    def run_chunk(chunk, *, model: str, protocol: str, base_url: str = "", api_key: str = "") -> list[dict] | None:
        """一批经指定端点生成；返回与 chunk 一一对应的 rows 或 None（不可救）"""
        user = make_user(chunk)
        for attempt in range(MAX_RETRY):
            try:
                rows = parse_batch(api_call(protocol, model, system, user, batch_tokens, base_url, api_key))
            except ApiReject as e:
                common.log(f"  [reject] {model}: {e}")
                return None  # 拒批/截断：换端点，同端点重试无意义
            except Exception as e:  # noqa: BLE001
                common.log(f"  [warn] {model} 网络错误(第 {attempt + 1} 次): {e}")
                time.sleep(5 * (attempt + 1))
                continue
            if rows is None:
                common.log(f"  [warn] {model} 输出不合法(第 {attempt + 1} 次)，重试")
                continue
            got = [r["word"] for r in rows]
            want = [w for w, _ in chunk]
            if got != want or len(rows) != len(chunk):
                common.log(f"  [warn] {model} 词序/词集不对应(第 {attempt + 1} 次)，重试")
                continue
            return rows
        return None

    def worker(idx: int, chunk: list[tuple[str, float]]):
        rows = run_chunk(chunk, model=args.model, protocol=args.protocol)
        via = "main"
        if rows is None and fb_url:
            # 主端点拒批（敏感词审查等）→ 本地兜底端点（openai 兼容，无内容过滤）
            common.log(f"  [fallback] 批 {idx} 转兜底 {fb_model}")
            rows = run_chunk(chunk, model=fb_model, protocol="openai", base_url=fb_url, api_key="none")
            via = "fallback"
        if rows is None:
            with lock:
                stats["skip"] += len(chunk)
            common.log(f"[fail] 批 {idx} 放弃（重跑可续）")
            return
        with lock:
            stats["done_batches"] = stats.get("done_batches", 0) + 1
            if stats["done_batches"] % 10 == 0 or stats["done_batches"] == len(chunks):
                common.log(f"[进度] {stats['done_batches']}/{len(chunks)} 批，累计 {stats['ok']} 词")
            with open(prog, "a", encoding="utf-8") as f:
                for (w, freq), r in zip(chunk, rows):
                    entry = {
                        "word": w, "headword": r["headword"], "reading": r["reading"],
                        "pos": r["pos"], "senses": r["senses"], "freq": freq,
                        "norm": common.norm(r["headword"], args.lang),
                        "via": via,
                    }
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                    done[w] = entry
            stats["ok"] += len(chunk)
            if via == "fallback":
                stats["fallback"] += len(chunk)

    chunks = [(i, todo[i : i + args.batch]) for i in range(0, len(todo), args.batch)]
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for idx, chunk in chunks:
            pool.submit(worker, idx, chunk)
    common.log(f"完成：主端点 {stats['ok'] - stats['fallback']}，兜底 {stats['fallback']}，"
               f"跳过 {stats['skip']} -> {prog}")

    # 组装 entries.jsonl + forms.jsonl（变位归一映射）；原子写。
    # 模型常把词形归一成词典形（如 найдём->найти）：多个输入词归一到同一 norm 时
    # 合并为一条词条——主词条用首个到达的（词单按频降序，首个即最高频，最接近词典形），
    # senses 用主词条的（变位词条的释义只是"某某的变位"说明，并进词典形是噪音），
    # pos 取并集；否则查 быть 会出十几张重复卡。所有输入词形仍记 form，按词形查询走归一映射。
    merged: dict[str, dict] = {}
    for w, freq in words:
        d = done.get(w)
        if not d:
            continue
        m = merged.get(d["norm"])
        if m is None:
            merged[d["norm"]] = {
                "headword": d["headword"], "norm": d["norm"], "reading": d["reading"],
                "pos": list(d["pos"]), "senses": d["senses"], "freq": freq, "forms": [w],
            }
        else:
            m["freq"] = max(m["freq"], freq)
            for pp in d["pos"]:
                if pp not in m["pos"]:
                    m["pos"].append(pp)
            m["forms"].append(w)
    def split_zh(zh: str) -> list[str]:
        """释义切到反查粒度：去括号补充 -> 分号/逗号/顿号分段 -> 2-8 字短词。
        LLM 释义是流畅短语（"美丽的，漂亮的；好的"），整条做 term 反查永远 miss"""
        t = re.sub(r"[（(][^）)]*[）)]", "", zh)
        out = []
        for seg in re.split(r"[；;]", t):
            for w in re.split(r"[，,、]", seg):
                w = w.strip().strip("。，,、")
                if 2 <= len(w) <= 8:
                    out.append(w)
        return out

    entries = []
    forms = []
    for norm, m in merged.items():
        zh_terms = [[t, i, "llm"] for i, s in enumerate(m["senses"]) if s.get("zh")
                    for t in split_zh(s["zh"])]
        entries.append({
            "headword": m["headword"], "norm": m["norm"], "reading": m["reading"] or None,
            "ipa": None, "pos": m["pos"], "gender": None, "freq": m["freq"],
            "senses": m["senses"], "zh_terms": zh_terms,
            "extra": {"source": "llm", "model": args.model},
        })
        for w in m["forms"]:
            if w != m["headword"] and w.lower() != m["headword"].lower():
                fn = common.norm(w, args.lang)
                if fn != m["norm"]:
                    forms.append({"form_norm": fn, "entry_norm": m["norm"], "rule": "变位归一"})
    for name, rows_ in (("entries.jsonl", entries), ("forms.jsonl", forms)):
        tmp = work / f"{name}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for r in rows_:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        os.replace(tmp, work / name)
    common.log(f"完成：{len(entries)} 词条（合并自 {sum(len(m['forms']) for m in merged.values())} 个输入词）"
               f" -> {work / 'entries.jsonl'}")
    if stats["skip"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
