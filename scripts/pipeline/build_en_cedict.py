"""CC-CEDICT (中→英) -> 反向匹配 ECDICT headword，给英语词条补充中文释义。

行格式: 繁體 簡體 [pin1 yin1] /English1/English2/
策略：跳过单字中文条目（字头释义噪声大，同 build_fr_cfdict）；英文释义清洗
（去 to 前缀/括注）后只收无空格的单词，按 headword 精确匹配（casefold）；
同词条同简体去重，也跳过 zh_terms 里已有的词，每词条上限 8。
输出：改写 data/work/en/entries.jsonl（追加 senses + zh_terms）
"""

import gzip
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

_LINE = re.compile(r"^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+/(.+)/\s*$")


def clean_en_def(defn: str) -> str:
    d = defn.strip()
    d = re.sub(r"\([^)]*\)", "", d).strip()  # 去括注 (computing) 等
    if d.lower().startswith("to "):
        d = d[3:]
    return d.strip()


def main():
    path = common.RAW / "cedict.txt.gz"
    if not path.exists():
        common.log("缺少 data/raw/cedict.txt.gz，先运行 download_all.py")
        sys.exit(1)

    entries_path = common.WORK / "en" / "entries.jsonl"
    entries = list(common.read_jsonl(entries_path))
    by_head: dict[str, dict] = {}
    for e in entries:
        by_head.setdefault(e["headword"].casefold(), e)

    n_match = n_skip = n_single = 0
    seen: set = set()
    per_entry: dict[str, int] = {}
    MAX_PER_ENTRY = 8

    with gzip.open(path, "rt", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            m = _LINE.match(line)
            if not m:
                n_skip += 1
                continue
            _trad, simp, _pinyin, defs = m.groups()
            # 单字字头（一/个/了…）英文释义宽泛，反查噪声大
            if len(simp) < 2:
                n_single += 1
                continue
            for seg in defs.split("/"):
                # CEDICT 的英文释义段内还用「; 」分隔（如 /hello; hi/）
                for d in seg.split(";"):
                    d = clean_en_def(d)
                    if not d or " " in d:
                        continue
                    if not re.fullmatch(r"[A-Za-z'’-]+", d):
                        continue
                    entry = by_head.get(d.casefold())
                    if entry is None:
                        continue
                    head = entry["headword"]
                    key = (head, simp)
                    if key in seen:
                        continue
                    seen.add(key)
                    # ECDICT 已有的 zh_terms 里已有该词则不重复挂
                    existing = {row[0] for row in entry.get("zh_terms") or []}
                    if simp in existing:
                        continue
                    if per_entry.get(head, 0) >= MAX_PER_ENTRY:
                        continue
                    per_entry[head] = per_entry.get(head, 0) + 1
                    entry.setdefault("senses", []).append({
                        "zh": simp,
                        "kind": "phrase",
                        "tags": ["CEDICT"],
                        "en": d,
                    })
                    sense_idx = len(entry["senses"]) - 1
                    entry.setdefault("zh_terms", []).append([simp, sense_idx, "cedict"])
                    n_match += 1

    with open(entries_path, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    common.log(f"cedict 匹配 {n_match} 条（跳过坏行 {n_skip}，单字 {n_single}）")


if __name__ == "__main__":
    main()
