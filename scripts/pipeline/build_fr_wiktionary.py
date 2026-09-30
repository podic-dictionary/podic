"""fr.wiktionary (wiktextract/kaikki) -> 补齐 Lexique 缺失的词条：多词短语 + 缩写。

Lexique383 是形态词频表，天然没有缩写（RTT）和短语（au fil du temps）；CFDICT 只反向补
释义不新增词条。本脚本从 fr.wiktionary 的机器可读抽取（fr-extract.jsonl.gz，每行一个词条
JSON，fr.wiktionary 覆盖全语种，lang_code=='fr' 才收）只收两类对症词条：
  - 多词短语：word 含空格（locution 系列）
  - 缩写类：全大写 ≥2 字母（RTT/CDI/SNCF…，pos 多被标成 noun，按词形判）
Gloss 取 senses[*]（form-of/alt-of 等屈折说明跳过）；中文从 translations（lang_code ∈
{zh, cmn}）取，带 sense 说明且能对上 gloss 的挂对应 sense，否则挂第一条。
输出：补全/追加 data/work/fr/entries.jsonl（同 headword 且 senses 为空则补释义，norm 已
存在则不重复收，其余追加新词条）。
"""

import gzip
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

# wiktextract 的 pos -> 包内 pos 标签
POS_MAP = {
    "noun": "n", "name": "n", "verb": "v", "adj": "adj", "adv": "adv",
    "prep": "prep", "prep_phrase": "prep", "pron": "pron", "conj": "conj",
    "det": "det", "num": "num", "intj": "int", "particle": "part",
    "proverb": "prov", "phrase": "loc",
}
# 屈折/异拼写说明类 sense 不是独立词条
_SKIP_TAGS = {"form-of", "alt-of", "plural-of", "contraction"}
# fr.wiktionary 大量短语变形页没有 form-of 标签，只有「Forme pronominale de X」式 gloss，按文本兜一道
_FORM_GLOSS = re.compile(
    r"^(Forme|Pluriel|Masculin|Féminin|Singulier|Participe|Présent|Imparfait|Passé|Futur|"
    r"Infinitif|Impératif|Subjonctif|Conditionnel|Variantes|Orthographe)\b",
    re.IGNORECASE,
)
_ZH_CODES = {"zh", "cmn"}
_WORD_OK = re.compile(r"^[^\d/@\n]{1,60}$")


def clean_gloss(s: dict) -> str | None:
    gs = s.get("raw_glosses") or s.get("glosses") or []
    g = (gs[0] if gs else "").strip()
    return g or None


def clean_ipa(sounds: list) -> str | None:
    for s in sounds or []:
        ipa = (s.get("ipa") or "").strip()
        # fr.wiktionary 的 IPA 用 \...\ 包裹
        if ipa.startswith("\\") and ipa.endswith("\\"):
            ipa = ipa[1:-1].strip()
        if ipa and not ipa.startswith("{"):
            return ipa
    return None


def main():
    src = common.RAW / "fr-extract.jsonl.gz"
    if not src.exists():
        common.log("缺少 data/raw/fr-extract.jsonl.gz，先运行 download_all.py")
        sys.exit(1)

    entries_path = common.WORK / "fr" / "entries.jsonl"
    entries = list(common.read_jsonl(entries_path))
    by_head: dict[str, dict] = {}      # casefold(headword) -> entry
    existing_norms: set[str] = set()
    for e in entries:
        by_head.setdefault(e["headword"].casefold(), e)
        existing_norms.add(e["norm"])

    n = n_new = n_fill = 0
    seen: set[str] = set()
    cand: dict[str, dict] = {}  # casefold(word) -> entry（同词多个义项页合并）

    with gzip.open(src, "rt", encoding="utf-8") as f:
        for line in f:
            n += 1
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("lang_code") != "fr":
                continue
            word = (d.get("word") or "").strip()
            if not _WORD_OK.match(word):
                continue
            is_acronym = len(word) >= 2 and word.isalpha() and word.isupper()
            is_phrase = " " in word and len(word.split()) <= 8
            if not is_acronym and not is_phrase:
                continue

            # sense 过滤：跳过屈折/异拼写说明，最多取 4 条
            senses = []
            for s in d.get("senses") or []:
                if set(s.get("tags") or []) & _SKIP_TAGS:
                    continue
                g = clean_gloss(s)
                if not g or _FORM_GLOSS.match(g):
                    continue
                senses.append({"s": s, "gloss": g})
                if len(senses) >= 4:
                    break
            if not senses:
                continue

            pos = ["abbr"] if is_acronym else [POS_MAP.get(d.get("pos"), "loc")]
            ipa = clean_ipa(d.get("sounds") or [])
            gender = next(iter(d.get("genders") or []), None)

            # 中文：{zh, cmn} 翻译，带 sense 说明且能对上 gloss 的挂对应条，否则挂第一条
            zh_all: list[tuple[str, str | None]] = []
            for t in d.get("translations") or []:
                if t.get("lang_code") not in _ZH_CODES:
                    continue
                w = (t.get("word") or "").strip()
                if w:
                    zh_all.append((w, (t.get("sense") or "").strip() or None))
                if len(zh_all) >= 6:
                    break

            key = word.casefold()
            if key in cand:  # 同词多页（多词源）合并：senses 拼接
                cand[key]["senses"].extend(senses)
                cand[key]["zh_all"].extend(zh_all)
                cand[key]["ipa"] = cand[key]["ipa"] or ipa
                cand[key]["gender"] = cand[key]["gender"] or gender
                continue
            cand[key] = {
                "headword": word, "norm": common.norm(word, "fr"), "pos": pos,
                "ipa": ipa, "gender": gender,
                "senses": senses, "zh_all": zh_all,
                "kind": "abbr" if is_acronym else "phrase",
            }
            if len(cand) >= 200_000:  # 防御上限，正常远达不到
                break

    def zh_for(gloss: str, zh_all: list[tuple[str, str | None]]) -> str | None:
        g = gloss.casefold()
        for w, sense in zh_all:
            if sense and sense.casefold() in g:
                return w
        return zh_all[0][0] if zh_all else None

    out = []
    for key, c in cand.items():
        old = by_head.get(key)
        if old is not None:
            # 同 headword：只给无释义的补（Lexique 词条常 senses:[]），有释义的不动
            if old.get("senses"):
                continue
        elif c["norm"] in existing_norms or key in seen:
            # 异形同 norm（é/e 变体等）被占、或本轮已新增过：跳过防串
            continue
        senses = [
            {"zh": zh_for(x["gloss"], c["zh_all"]), "fr": x["gloss"], "tags": ["Wiktionary"]}
            for x in c["senses"]
        ]
        if old is not None:
            old["senses"] = senses
            old.setdefault("extra", {}).setdefault("source", "lexique")
            old["extra"]["source"] += "+wiktionary"
            n_fill += 1
            continue
        seen.add(key)
        row = {
            "headword": c["headword"], "norm": c["norm"],
            "ipa": json.dumps(c["ipa"], ensure_ascii=False) if c["ipa"] else None,
            "pos": c["pos"], "gender": c["gender"], "freq": 0.0,
            "senses": senses,
            "zh_terms": [], "extra": {"source": "wiktionary", "kind": c["kind"]},
        }
        for i, s in enumerate(senses):
            if s["zh"]:
                row["zh_terms"].append([s["zh"], i, "wiktionary"])
        out.append(row)
        n_new += 1

    with open(entries_path, "a", encoding="utf-8") as f:
        for row in out:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    n_abbr = sum(1 for r in out if r["extra"]["kind"] == "abbr")
    common.log(f"扫描 {n} 行，新增 {n_new}（缩写 {n_abbr}、短语 {n_new - n_abbr}），补释义 {n_fill}")


if __name__ == "__main__":
    main()
