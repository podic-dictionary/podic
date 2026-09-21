"""Lexique383 -> data/work/fr/{entries,forms}.jsonl（法语词条：读音/词性/阴阳性/词频/屈折）

Lexique383.tsv 关键列（35 列中）:
  ortho(正字法) phon(音位转写) lemme(原形) cgram(词性) genre(性) nombre(数)
  freqlemfilms2/freqlemlivres(词频) islem(是否原形行) infover(动词变位信息)

音位 -> IPA 映射：Lexique 用自造符号，映射表见 PHON2IPA；构建结束打印未映射字符集，非空即失败。
"""

import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

# Lexique 音位符号 -> IPA（实测词例校准：an=@→ɑ̃, de=°→ə, vin=v5→ɛ̃, un=1→œ̃,
# juin=Z85→ʒɥɛ̃, bon=b§→ɔ̃, blanc=bl@→blɑ̃, huit=8it→ɥit）
PHON2IPA = {
    "E": "ɛ", "O": "ɔ", "A": "ɑ", "2": "ø", "9": "œ",
    "S": "ʃ", "Z": "ʒ", "N": "ŋ", "R": "ʁ", "J": "ɲ", "U": "ɥ", "g": "ɡ",
    "@": "ɑ̃", "§": "ɔ̃", "°": "ə", "1": "œ̃", "5": "ɛ̃", "8": "ɥ",
}

CGRAAM_MAP = {
    "NOM": "n", "VER": "v", "AUX": "v", "ADJ": "adj", "ADV": "adv", "PRE": "prep",
    "CON": "conj", "DET": "det", "PRO": "pron", "NUM": "num", "ONO": "int", "INT": "int",
}


def phon_to_ipa(phon: str) -> str:
    return "".join(PHON2IPA.get(c, c) for c in phon)


def norm_freq(*values: str) -> float:
    vals = []
    for v in values:
        try:
            x = float(v)
            if x > 0:
                vals.append(x)
        except ValueError:
            pass
    if not vals:
        return 0.0
    # 频次(每百万词) -> 0..1
    return round(min(1.0, math.log10(max(vals) + 1) / 5.0), 6)


def main():
    tsv = common.RAW / "Lexique383.tsv"
    if not tsv.exists():
        common.log("缺少 data/raw/Lexique383.tsv，先运行 download_all.py")
        sys.exit(1)

    out_entries = common.WORK / "fr" / "entries.jsonl"
    out_forms = common.WORK / "fr" / "forms.jsonl"
    out_entries.parent.mkdir(parents=True, exist_ok=True)

    # 第一遍：聚合 lemma -> 词条；同时收集未映射音位
    # 聚合键用 lemme 原形（保变音）：élève/élevé 去变音同为 eleve，是两个不同的词
    # lemma -> {pos:set, gender, ipa, freq, is_lem}
    lemmas: dict[str, dict] = {}
    unmapped: set[str] = set()
    # (ortho_norm, lemme) -> (rule) 去重
    forms: dict[tuple, str] = {}

    with open(tsv, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE)
        for row in reader:
            ortho = (row.get("ortho") or "").strip()
            if not ortho:
                continue
            lemme = (row.get("lemme") or "").strip() or ortho
            cgram = (row.get("cgram") or "").strip()
            pos = CGRAAM_MAP.get(cgram, cgram.lower() or None)
            genre = (row.get("genre") or "").strip() or None  # m/f
            nombre = (row.get("nombre") or "").strip()  # s/p
            phon = (row.get("phon") or "").strip()

            lem_norm = common.norm(lemme, "fr")
            entry = lemmas.setdefault(
                lemme,
                {"headword": lemme, "norm": lem_norm, "pos": set(), "gender": None,
                 "ipa": None, "freq": 0.0},
            )
            if pos:
                entry["pos"].add(pos)
            if genre and not entry["gender"]:
                entry["gender"] = genre
            entry["freq"] = max(entry["freq"], norm_freq(row.get("freqlemlivres"), row.get("freqfilms2")))
            # islem=1 的行给 lemma 级读音
            if phon:
                if entry["ipa"] is None or (row.get("islem") == "1"):
                    entry["ipa"] = phon_to_ipa(phon)
                for c in phon:
                    if c not in PHON2IPA and not c.isalpha():
                        unmapped.add(c)

            # ortho -> lemme 屈折（ortho != lemme 才是变形）
            o_norm = common.norm(ortho, "fr")
            if o_norm and o_norm != lem_norm:
                rule = f"{cgram.lower() or '?'}-{genre or ''}-{nombre or ''}"
                key = (o_norm, lemme)
                if key not in forms:
                    forms[key] = rule

    # 词性按出现频次排序稳定性：转 list
    def pos_key(p: str):
        order = ["n", "v", "adj", "adv", "prep", "pron", "conj", "det", "num", "int"]
        return order.index(p) if p in order else 99

    n = 0
    with open(out_entries, "w", encoding="utf-8") as f:
        for e in lemmas.values():
            f.write(json.dumps({
                "headword": e["headword"],
                "norm": e["norm"],
                "ipa": json.dumps(e["ipa"], ensure_ascii=False) if e["ipa"] else None,
                "pos": sorted(e["pos"], key=pos_key),
                "gender": e["gender"],
                "freq": e["freq"],
                "senses": [],
                "zh_terms": [],
                "extra": {"source": "lexique"},
            }, ensure_ascii=False) + "\n")
            n += 1

    nf = 0
    with open(out_forms, "w", encoding="utf-8") as f:
        for (o_norm, lem_norm), rule in forms.items():
            f.write(json.dumps({"form_norm": o_norm, "entry_norm": lem_norm, "rule": rule},
                               ensure_ascii=False) + "\n")
            nf += 1

    common.log(f"entries={n} forms={nf}")
    if unmapped:
        common.log(f"[FAIL] 未映射音位字符: {sorted(unmapped)}")
        sys.exit(1)
    common.log("音位->IPA 映射无遗漏 ✓")


if __name__ == "__main__":
    main()
