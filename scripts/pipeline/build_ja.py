"""jmdict-simplified + KANJIDIC2 + deinflect.json -> data/work/ja/{entries,forms}.jsonl

- jmdict-eng-common: common 词条（kanji/kana/sense(gloss en)/pos）
- jmdict-fre:        同构 JSON，按 word id + sense 序号合并法语 gloss
- kanjidic2:         汉字信息（音训/笔画/级别/英文含义）
- deinflect.json:    正向生成屈折形式（食べる→食べた/食べます/...），规则组键为语义标签
  方向：lemma 以 kanaOut 结尾且词性 ∈ rulesOut -> 替换为 kanaIn；
        生成形态的词性 = rulesIn（用于链式：ない->なかった）；深度<=3，每词<=60 形式
"""

import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

# JMdict POS -> deinflect 链标签（只给动词和イ形容词生成变形；按前缀归类覆盖 v5k-s/vs-i 等变体）
def to_chain(p: str) -> str | None:
    if p == "v1":
        return "v1"
    if p.startswith("v5"):
        return "v5"
    if p == "vk" or p == "vz" or p == "adj-i":
        return p
    if p.startswith("vs"):
        return "vs"
    return None


MAX_DEPTH = 3
MAX_FORMS = 60


def load_deinflect() -> list[dict]:
    d = json.loads((common.RAW / "deinflect.json").read_text(encoding="utf-8"))
    rules = []
    for group, variants in d.items():
        for r in variants:
            rules.append({
                "kanaIn": r["kanaIn"], "kanaOut": r["kanaOut"],
                "rulesIn": set(r.get("rulesIn") or []),
                "rulesOut": set(r.get("rulesOut") or []),
                "label": group,
            })
    return rules


def forward_forms(lemma: str, pos_tags: set[str], rules: list[dict]) -> dict[str, str]:
    """正向生成屈折形式：form -> 规则标签（kanaIn）。"""
    forms: dict[str, str] = {}
    frontier = [(lemma, None)]  # (text, form 词性集合 or None)
    seen = {(lemma, None)}
    for _ in range(MAX_DEPTH):
        nxt = []
        for text, fpos in frontier:
            for r in rules:
                if not text.endswith(r["kanaOut"]):
                    continue
                stem_pos = pos_tags if fpos is None else fpos
                if not (stem_pos & r["rulesOut"]):
                    continue
                nf = text[: len(text) - len(r["kanaOut"])] + r["kanaIn"]
                if nf == lemma or nf in forms:
                    continue
                forms[nf] = r["kanaIn"]
                npos = r["rulesIn"]
                key = (nf, frozenset(npos))
                if key not in seen:
                    seen.add(key)
                    if npos:  # rulesIn 为空则不能再链下去
                        nxt.append((nf, npos))
        if len(forms) >= MAX_FORMS:
            break
        frontier = nxt
    return dict(list(forms.items())[:MAX_FORMS])


def hira(s: str) -> str:
    return common.kata_to_hira(s)


def main():
    zips = sorted(common.RAW.glob("jmdict-eng-common-*.json.zip"))
    if not zips:
        common.log("缺少 jmdict-eng-common zip，先运行 download_all.py")
        sys.exit(1)
    eng_zip = zips[0]

    fre = {}
    fre_zips = sorted(common.RAW.glob("jmdict-fre-*.json.zip"))
    if fre_zips:
        with zipfile.ZipFile(fre_zips[0]) as z:
            data = json.loads(z.read(z.namelist()[0]))
        for w in data["words"]:
            fre[w["id"]] = [g["text"] for s in w.get("sense", []) for g in s.get("gloss", []) if g.get("lang") == "fre"]
        common.log(f"jmdict-fre 词条 {len(fre)}")

    # kanjidic2
    kanji_info = {}
    kd_zips = sorted(common.RAW.glob("kanjidic2-en-*.json.zip"))
    if kd_zips:
        with zipfile.ZipFile(kd_zips[0]) as z:
            data = json.loads(z.read(z.namelist()[0]))
        for ch in data.get("characters", []):
            rm = ch.get("readingsMeanings") or {}
            misc = ch.get("misc") or {}
            kanji_info[ch["literal"]] = {
                "on": rm.get("jaOn", [])[:4],
                "kun": rm.get("jaKun", [])[:4],
                "grade": misc.get("grade"),
                "strokes": (misc.get("strokeCounts") or [None])[0],
                "meanings": rm.get("meanings", [])[:3],
            }
        common.log(f"kanjidic2 汉字 {len(kanji_info)}")

    with zipfile.ZipFile(eng_zip) as z:
        data = json.loads(z.read(z.namelist()[0]))
    words = data["words"]
    common.log(f"jmdict 词条 {len(words)}")

    rules = load_deinflect()
    out_entries = common.WORK / "ja" / "entries.jsonl"
    out_forms = common.WORK / "ja" / "forms.jsonl"
    out_entries.parent.mkdir(parents=True, exist_ok=True)

    n_e = n_f = 0
    with open(out_entries, "w", encoding="utf-8") as fe, open(out_forms, "w", encoding="utf-8") as ff:
        def emit_form(form_norm: str, entry_norm: str, rule: str):
            nonlocal n_f
            if form_norm and entry_norm and form_norm != entry_norm:
                ff.write(json.dumps({"form_norm": form_norm, "entry_norm": entry_norm, "rule": rule},
                                    ensure_ascii=False) + "\n")
                n_f += 1

        for w in words:
            kanjis = [k["text"] for k in w.get("kanji", [])]
            kanas = [k["text"] for k in w.get("kana", [])]
            if not kanjis and not kanas:
                continue
            headword = kanjis[0] if kanjis else kanas[0]
            # 读音：appliesToKanji 覆盖 headword 的 kana（或 '*‘）
            reading = None
            for k in w.get("kana", []):
                a = k.get("appliesToKanji") or []
                if "*" in a or headword in a or not kanjis:
                    reading = k["text"]
                    break
            if reading is None and kanas:
                reading = kanas[0]

            pos = sorted({p for s in w.get("sense", []) for p in s.get("partOfSpeech", [])})
            senses = []
            for si, s in enumerate(w.get("sense", [])):
                gl = [g["text"] for g in s.get("gloss", []) if g.get("lang") == "eng"]
                if not gl:
                    continue
                sense = {"pos": s.get("partOfSpeech", []), "en": "；".join(gl)}
                frs = fre.get(w["id"])
                if frs and si < len(frs):
                    sense["fr"] = frs[si]
                senses.append(sense)

            common_flag = any(k.get("common") for k in w.get("kanji", []) + w.get("kana", []))
            # 汉字信息（最多前 4 个字）
            chars = []
            for c in dict.fromkeys(headword):
                if c in kanji_info:
                    chars.append({"ch": c, **kanji_info[c]})
            entry = {
                "headword": headword,
                "norm": common.norm(headword, "ja"),
                "reading": reading,
                "ipa": None,
                "pos": pos,
                "gender": None,
                "freq": 1.0 if common_flag else 0.3,
                "senses": senses,
                "zh_terms": [],
                "extra": {"source": "jmdict", **({"kanji": chars[:4]} if chars else {})},
            }
            enorm = entry["norm"]
            if not enorm:
                continue
            fe.write(json.dumps(entry, ensure_ascii=False) + "\n")
            n_e += 1

            # 读音/其他表记 -> form（rule=reading/variant，促音脱落变体一并生成）
            for k in kanas:
                knorm = common.norm(k, "ja")
                emit_form(knorm, enorm, "reading")
                if "っ" in knorm:
                    emit_form(knorm.replace("っ", ""), enorm, "reading")
            for kk in kanjis[1:]:
                emit_form(common.norm(kk, "ja"), enorm, "variant")

            # 屈折形式：按各词性生成（基于 kanji 与 kana 表记）
            chains = {c for c in (to_chain(p) for p in pos) if c}
            if chains:
                for base in dict.fromkeys(kanjis + kanas):
                    bnorm = common.norm(base, "ja")
                    for form, rule in forward_forms(base, chains, rules).items():
                        fnorm = common.norm(form, "ja")
                        emit_form(fnorm, enorm, rule)
                        if "っ" in fnorm:
                            emit_form(fnorm.replace("っ", ""), enorm, rule)

    common.log(f"entries={n_e} forms={n_f}")
    common.log(f"-> {out_entries}")
    common.log(f"-> {out_forms}")

    # ---- 自测：反向验证若干核心变形 ----
    def has(form, entry_norm_prefix=""):
        got = set()
        for line in open(out_forms, encoding="utf-8"):
            r = json.loads(line)
            if r["form_norm"] == common.norm(form, "ja"):
                got.add(r["entry_norm"])
        return got

    checks = {
        "食べた": "た", "行きます": "ます", "大きくて": "くて",
        "大きくなかった": "なかった", "食べられる": "られる",
    }
    ok = True
    for form, expect_label in checks.items():
        got = has(form)
        if not got:
            common.log(f"[FAIL] {form} 无生成结果")
            ok = False
        else:
            common.log(f"  {form} -> {sorted(got)[:3]} (规则 {expect_label})")
    # された -> される（為れる，する 的被动条目）
    got = has("された")
    if not any(common.norm(s, "ja") in {common.norm(x, "ja") for x in ["される", "為れる"]} for s in got):
        common.log(f"[FAIL] された 未命中 される: {sorted(got)[:5]}")
        ok = False
    if not ok:
        sys.exit(1)
    common.log("变形自测通过 ✓")


if __name__ == "__main__":
    main()
