"""ECDICT -> data/work/en/{entries,forms}.jsonl

ecdict.csv 字段: word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio
- translation: 多义按 \\n 分行，每行 "n. 释义；释义"，领域标签形如 "[网络] ..."
- definition:  英文释义，行数通常与 translation 对齐
- pos:         形如 "n:46/v:54"
- exchange:    形如 "d:perceived/p:perceived/3:perceives/i:perceiving/0:perceive"
               0:原形 s:复数 d:过去式 i:现在分词 3:三单 r:比较级 t:最高级
"""

import csv
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

# ECDICT 词性前缀 -> 标准化 POS
POS_MAP = {
    "n": "n", "v": "v", "vi": "v", "vt": "v", "adj": "adj", "adv": "adv",
    "prep": "prep", "pron": "pron", "conj": "conj", "art": "art", "int": "int",
    "num": "num", "abbr": "abbr", "aux": "aux", "pl": "n", "modal": "modal",
}
_POS_TOKEN = re.compile(r"^(n|v|vi|vt|adj|adv|prep|pron|conj|art|int|num|abbr|aux|pl|modal)\.\s*")
_BRACKET = re.compile(r"^\[([^\]]+)\]\s*")

# exchange 代码 -> 变形规则标签（p:过去式 d:过去分词 i:现在分词 3:三单 s:复数 r:比较级 t:最高级 0:原形）
EXCHANGE_RULES = {"p": "past", "d": "pp", "i": "ing", "3": "s3", "s": "pl", "r": "comp", "t": "sup"}

# ecdict.csv 字段内分隔符是字面量 \n（反斜杠+n），也可能混有真实换行
_FIELD_SPLIT = re.compile(r"\\n|\n")


def parse_translation(translation: str):
    """返回 (senses, zh_terms)；senses: [{pos, zh, en?, kind?, tags?}]"""
    senses, zh_terms = [], []
    for line in _FIELD_SPLIT.split(translation or ""):
        line = line.strip()
        if not line:
            continue
        pos_list, tags = [], []
        # 前缀词性，可能连写 "vt. & vi." / "n. & adj."
        while m := _POS_TOKEN.match(line):
            pos_list.append(POS_MAP[m.group(1)])
            line = line[m.end():]
        # 行首领域标签 [网络] [医]
        if m := _BRACKET.match(line):
            tags.append(m.group(1))
            line = line[m.end():]
        line = line.strip()
        if not line:
            continue
        kind = "phrase" if tags and not pos_list else "def"
        sense = {"pos": pos_list, "zh": line, "kind": kind}
        if tags:
            sense["tags"] = tags
        senses.append(sense)
        # 术语切分进反查索引（去掉括号补充说明）
        term_text = re.sub(r"[（(][^）)]*[）)]", "", line)
        for t in re.split(r"[；;]", term_text):
            t = t.strip().strip("。，,、")
            if t and common.zh_term_norm(t):
                zh_terms.append([t, len(senses) - 1])
    return senses, zh_terms


def parse_pos_field(pos: str):
    """'n:46/v:54' -> ['n','v']"""
    out = []
    for part in (pos or "").split("/"):
        code = part.split(":")[0].strip()
        if code in POS_MAP:
            out.append(POS_MAP[code])
    return out


def freq_rank(frq: str, bnc: str) -> float:
    """词频排名 -> 0..1 归一化（排名越小越高；无排名 = 0）"""
    rank = min(int(frq) if str(frq).isdigit() and int(frq) > 0 else 1 << 30,
               int(bnc) if str(bnc).isdigit() and int(bnc) > 0 else 1 << 30)
    if rank >= 1 << 30:
        return 0.0
    return 1.0 / math.log10(rank + 10)


def main():
    csv_path = common.RAW / "ecdict.csv"
    if not csv_path.exists():
        common.log("缺少 data/raw/ecdict.csv，先运行 download_all.py")
        sys.exit(1)

    out_entries = common.WORK / "en" / "entries.jsonl"
    out_forms = common.WORK / "en" / "forms.jsonl"
    out_entries.parent.mkdir(parents=True, exist_ok=True)

    n_entries = n_forms = n_skipped = 0
    seen_forms = set()
    with open(csv_path, newline="", encoding="utf-8") as f, \
         open(out_entries, "w", encoding="utf-8") as fe, \
         open(out_forms, "w", encoding="utf-8") as ff:

        def emit_form(form_norm: str, entry_norm: str, rule: str):
            nonlocal n_forms
            key = (form_norm, entry_norm, rule)
            if form_norm and entry_norm and form_norm != entry_norm and key not in seen_forms:
                seen_forms.add(key)
                ff.write(json.dumps({"form_norm": form_norm, "entry_norm": entry_norm, "rule": rule},
                                    ensure_ascii=False) + "\n")
                n_forms += 1

        reader = csv.DictReader(f)
        for row in reader:
            word = (row.get("word") or "").strip()
            translation = row.get("translation") or ""
            definition = row.get("definition") or ""
            if not word or (not translation and not definition):
                n_skipped += 1
                continue

            senses, zh_terms = parse_translation(translation)
            pos = parse_pos_field(row.get("pos") or "")
            # translation 行没有词性前缀时，用 pos 字段补
            if not pos and senses:
                pos = []
            if pos:
                for s in senses:
                    if not s["pos"]:
                        s["pos"] = pos

            # 英文释义按行对齐塞进 sense.en
            en_lines = [l.strip() for l in _FIELD_SPLIT.split(definition or "") if l.strip()]
            if en_lines:
                if len(en_lines) == len(senses):
                    for s, e in zip(senses, en_lines):
                        s["en"] = e
                else:
                    pass  # 行数对不齐就不硬塞，避免错位

            entry = {
                "headword": word,
                "norm": common.norm(word, "en"),
                "ipa": json.dumps({"uk": row.get("phonetic") or "", "us": ""}, ensure_ascii=False)
                if row.get("phonetic") else None,
                "pos": pos,
                "gender": None,
                "freq": round(freq_rank(row.get("frq"), row.get("bnc")), 6),
                "senses": senses,
                "zh_terms": zh_terms,
                "extra": {
                    "source": "ecdict",
                    **({"tags": row["tag"].split()} if row.get("tag") else {}),
                    **({"collins": int(row["collins"])} if str(row.get("collins", "")).isdigit() and int(row["collins"]) else {}),
                    **({"oxford": int(row["oxford"])} if str(row.get("oxford", "")).isdigit() and int(row["oxford"]) else {}),
                },
            }
            fe.write(json.dumps(entry, ensure_ascii=False) + "\n")
            n_entries += 1

            # exchange -> forms：lemma 行正向生成变形；变体行用 0:原形 回指
            exchange = row.get("exchange") or ""
            for code, rule in EXCHANGE_RULES.items():
                m = re.search(rf"(?:^|/){re.escape(code)}:([^/]+)", exchange)
                if m:
                    emit_form(common.norm(m.group(1).strip(), "en"), entry["norm"], rule)
            m0 = re.search(r"(?:^|/)0:([^/]+)", exchange)
            if m0:
                emit_form(entry["norm"], common.norm(m0.group(1).strip(), "en"), "lemma")

    common.log(f"entries={n_entries} forms={n_forms} skipped={n_skipped}")
    common.log(f"-> {out_entries}")
    common.log(f"-> {out_forms}")


if __name__ == "__main__":
    main()
