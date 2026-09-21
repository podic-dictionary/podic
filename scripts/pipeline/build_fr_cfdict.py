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

    n_match = n_skip = n_single = 0
    seen = set()
    per_entry: dict[str, int] = {}
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
            entry = by_head.get(cleaned.casefold())
            if entry is None:
                continue
            head = entry["headword"]
            key = (head, simp, d)
            if key in seen:
                continue
            seen.add(key)
            if per_entry.get(head, 0) >= MAX_PER_ENTRY:
                continue
            per_entry[head] = per_entry.get(head, 0) + 1
            entry.setdefault("senses", []).append({
                "zh": simp,
                "fr": d,
                "kind": "phrase",
                "tags": ["CFDICT"],
            })
            sense_idx = len(entry["senses"]) - 1
            entry.setdefault("zh_terms", []).append([simp, sense_idx, "cfdict"])
            if trad != simp:
                entry["zh_terms"].append([trad, sense_idx, "cfdict"])
            n_match += 1

    with open(entries_path, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    common.log(f"cfdict 匹配 {n_match} 条（跳过未匹配行 {n_skip}，单字 {n_single}）")


if __name__ == "__main__":
    main()
