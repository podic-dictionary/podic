"""CFDICT (中→法) -> 反向匹配 Lexique lemme，给法语词条补充中文释义。

cfdict.u8 行格式: 繁體 簡體 [pin1 yin1] /法语释义1/法语释义2/
策略：法语释义清洗（去词性标记/冠词）后按 lemme 精确匹配，单词条才收。
输出：改写 data/work/fr/entries.jsonl（追加 senses + zh_terms）
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

_LINE = re.compile(r"^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+/(.+)/\s*$")
# 法语释义里的词性/用法标记
_POS_PREFIX = re.compile(r"^(n\.?\s*[mf]?\.?|v\.?(tr|intr)?\.?|adj\.?|adv\.?|prép\.?|loc\.?\s*[a-z]+\.?|interj\.?|num\.?|art\.?|prov\.?|familier|soutenu|littéraire|vieux)\s+", re.IGNORECASE)
_ARTICLES = {"l'", "le", "la", "les", "un", "une", "des", "d'", "au", "aux", "de", "du"}


def clean_fr_def(defn: str) -> str:
    d = defn.strip().rstrip(",").strip()
    # 括号补充说明去掉后判断是否单词
    d = re.sub(r"\([^)]*\)", "", d).strip()
    while True:
        m = _POS_PREFIX.match(d)
        if not m:
            break
        d = d[m.end():]
    words = d.split()
    while words and words[0].lower().rstrip("’'") in _ARTICLES:
        words = words[1:]
    return " ".join(words).strip()


def main():
    path = common.RAW / "cfdict.u8"
    if not path.exists():
        common.log("缺少 data/raw/cfdict.u8")
        sys.exit(1)

    entries_path = common.WORK / "fr" / "entries.jsonl"
    entries = list(common.read_jsonl(entries_path))
    # CFDICT 的法语释义是精确词形（élève≠élevé），按 headword 精确匹配（casefold 保变音）
    by_head: dict[str, dict] = {}
    for e in entries:
        by_head.setdefault(e["headword"].casefold(), e)

    # 幂等：已有 CFDICT 义项的条目视为已处理过（重跑不重复追加）。
    # 注意不能按标签删除旧义项：refined 合并时精修义项会继承原义项的 tags，
    # 其中 1.2 万条带 CFDICT 标签，删除会把精修结果一起清掉
    done_heads = {
        e["headword"].casefold()
        for e in entries
        if any("CFDICT" in (s.get("tags") or []) for s in e.get("senses") or [])
    }

    n_match = n_skip = n_single = 0
    # 同一法语释义（如 « avoir »）会被多个中文词头反查命中，它们指向同一个义项：
    # 按释义合并中文词，一个释义只产出一个义项（否则翻译阶段会把同一个外文原文
    # 译成同一句中文，出现 5 条相同释义）
    per_head: dict[str, dict[str, dict]] = {}
    MAX_PER_ENTRY = 12  # CFDICT 反向同义词太多时取前 N（文件序≈常用序）
    for raw in open(path, encoding="utf-8"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _LINE.match(line)
        if not m:
            n_skip += 1
            continue
        trad, simp, pinyin, defs = m.groups()
        # 单字字头（峨/巍/嵩…）法语释义常捎带常用词，反查噪声大；多字词才可读
        if len(simp) < 2:
            n_single += 1
            continue
        for d in defs.split("/"):
            d = d.strip()
            if not d:
                continue
            cleaned = clean_fr_def(d)
            # 单词释义才做精确匹配（多词短语反向歧义太大）
            if not cleaned or " " in cleaned:
                continue
            if not re.fullmatch(r"[A-Za-zÀ-ÿ'’-]+", cleaned):
                continue
            if cleaned.casefold() in done_heads:
                continue
            entry = by_head.get(cleaned.casefold())
            if entry is None:
                continue
            head = entry["headword"]
            glosses = per_head.setdefault(head, {})
            g = glosses.get(cleaned.casefold())
            if g is None:
                if len(glosses) >= MAX_PER_ENTRY:
                    continue
                g = glosses[cleaned.casefold()] = {"fr": d, "zh": [], "trads": []}
            if simp not in g["zh"]:
                g["zh"].append(simp)
            if trad != simp and trad not in g["trads"] and trad not in g["zh"]:
                g["trads"].append(trad)

    for head, glosses in per_head.items():
        entry = by_head[head]
        for g in glosses.values():
            entry.setdefault("senses", []).append({
                "zh": "；".join(g["zh"]),
                "fr": g["fr"],
                "kind": "phrase",
                "tags": ["CFDICT"],
            })
            sense_idx = len(entry["senses"]) - 1
            entry.setdefault("zh_terms", [])
            for term in g["zh"] + g["trads"]:
                entry["zh_terms"].append([term, sense_idx, "cfdict"])
            n_match += 1

    with open(entries_path, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    common.log(f"cfdict 匹配 {n_match} 条（跳过未匹配行 {n_skip}，单字 {n_single}）")


if __name__ == "__main__":
    main()
