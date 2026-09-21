"""Tatoeba 句对 -> data/work/{lang}/{sentences,entry_sentence}.jsonl

- sentences.csv: id \t lang \t text；links.csv: sentence_id \t translation_id（双向都有）
- 只对每语种 freq 排名前 --top headword 建索引；en/fr 整词精确匹配；ja 对 headword/reading 子串包含
- 译文优先中文（≤3 条）；每 entry 保留 --per-entry 句，按 score 排序
- 另产出 ja_word_freq.tsv（headword\t出现次数），供 refine_llm.py 给日语词条排序
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

MAX_SENT_LEN = {"en": 120, "fr": 140, "ja": 60, "zh": 80}
# Tatoeba 导出用 ISO 639-3 三字码；译文里 cmn/yue 都算中文
CODE_MAP = {"eng": "en", "fra": "fr", "jpn": "ja"}
ZH_CODES = {"cmn", "yue", "zh"}
WORD_SPLIT = re.compile(r"[^a-zàâäéèêëîïôöùûüç'’-]+", re.IGNORECASE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=50000, help="每语种索引的 headword 数（按 freq）")
    ap.add_argument("--per-entry", type=int, default=3)
    args = ap.parse_args()

    sent_path = common.RAW / "tatoeba_sentences.csv"
    links_path = common.RAW / "tatoeba_links.csv"
    if not sent_path.exists() or not links_path.exists():
        common.log("缺少 tatoeba_sentences.csv / tatoeba_links.csv，先运行 download_all.py")
        sys.exit(1)

    # 读词表：各语种 freq 前 N 的 headword（entry 键 -> 索引数据）
    # en/fr 关联键用 casefold(headword) 保变音：norm 去变音会碰撞（élève/élevé 同 norm，例句互串）
    lang_entries: dict[str, dict[str, dict]] = {}
    for lang in ["en", "fr", "ja"]:
        entries = list(common.read_jsonl(common.WORK / lang / "entries.jsonl"))
        entries.sort(key=lambda x: -x.get("freq", 0))
        top = entries[: args.top]
        lang_entries[lang] = {
            (e["norm"] if lang == "ja" else e["headword"].casefold()): {
                "headword": e["headword"], "reading": e.get("reading") or "", "freq": e.get("freq") or 0
            }
            for e in top
        }
        common.log(f"[{lang}] 词表 {len(lang_entries[lang])}（freq 前 {args.top}）")

    # 索引：en/fr 整词 -> norms；ja 子串搜索按 headword 长度分组
    word_index: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))
    ja_keys: dict[str, list[str]] = {}  # lang 'ja' -> [headword/reading 按长度降序]
    for lang, m in lang_entries.items():
        if lang == "ja":
            keys = []
            for norm, info in m.items():
                if len(info["headword"]) >= 2 and not re.fullmatch(r"[a-zA-Z0-9]+", info["headword"]):
                    keys.append(info["headword"])
                if info["reading"] and len(info["reading"]) >= 2:
                    keys.append(info["reading"])
            keys.sort(key=len, reverse=True)
            ja_keys[lang] = keys
        else:
            for ek, info in m.items():
                for w in WORD_SPLIT.split(info["headword"].lower()):
                    if len(w) >= 2:
                        word_index[lang][w].add(ek)

    # 第一遍：扫描句子，记录命中的句子
    hits: dict[str, dict[int, set]] = defaultdict(lambda: defaultdict(set))  # lang -> sent_id -> norms
    ja_sent_cache: dict[int, str] = {}
    n_lines = 0
    for raw in open(sent_path, encoding="utf-8"):
        n_lines += 1
        if n_lines % 1000000 == 0:
            common.log(f"  已扫描 {n_lines} 行")
        parts = raw.rstrip("\n").split("\t")
        if len(parts) < 3:
            continue
        sid, tcode, text = parts[0], parts[1], parts[2]
        lang = CODE_MAP.get(tcode)
        if lang is None or len(text) > MAX_SENT_LEN[lang]:
            continue
        if lang == "ja":
            ja_sent_cache[int(sid)] = text
            continue
        norms: set = set()
        for w in WORD_SPLIT.split(text.lower()):
            if w in word_index[lang]:
                norms |= word_index[lang][w]
        if norms:
            hits[lang][int(sid)] = norms

    common.log(f"en/fr 命中句子: " + ", ".join(f"{l}={len(hits[l])}" for l in ["en", "fr"]))

    # ja：子串匹配（key 按长度降序，长词优先归属；每句最多标 30 个 entry）
    for sid, text in ja_sent_cache.items():
        matched = 0
        for key in ja_keys["ja"]:
            if key in text:
                norm = common.norm(key, "ja")
                if norm in lang_entries["ja"]:
                    hits["ja"][sid].add(norm)
                    matched += 1
                    if matched >= 30:
                        break
        ja_sent_cache[sid] = text  # 保留原文
    common.log(f"ja 命中句子: {len(hits['ja'])}")

    # ja 词频统计（给 refine 排序）
    ja_freq = Counter()
    for sid, norms in hits["ja"].items():
        for norm in norms:
            ja_freq[lang_entries["ja"][norm]["headword"]] += 1
    freq_path = common.WORK / "ja" / "ja_word_freq.tsv"
    with open(freq_path, "w", encoding="utf-8") as f:
        for w, c in ja_freq.most_common():
            f.write(f"{w}\t{c}\n")
    common.log(f"ja 词频表: {len(ja_freq)} 词 -> {freq_path}")

    # 第二遍：取 en/fr 命中句子的文本
    hit_ids_enfr = set(hits["en"]) | set(hits["fr"])
    sent_text: dict[int, str] = {}
    for raw in open(sent_path, encoding="utf-8"):
        parts = raw.rstrip("\n").split("\t")
        if len(parts) < 3:
            continue
        try:
            sid = int(parts[0])
        except ValueError:
            continue
        if sid in hit_ids_enfr:
            sent_text[sid] = parts[2]

    # 第三遍：links.csv，为命中句子找翻译（优先中文）
    need_ids = set(hits["en"]) | set(hits["fr"]) | set(hits["ja"])
    translations: dict[int, list] = defaultdict(list)
    n_links = 0
    for raw in open(links_path, encoding="utf-8"):
        n_links += 1
        parts = raw.rstrip("\n").split("\t")
        if len(parts) < 2:
            continue
        try:
            a, b = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        if a in need_ids:
            translations[a].append(b)
    common.log(f"links {n_links} 行，命中句有翻译的: {len(translations)}")

    # 第四遍：读翻译句子内容
    all_tids = set()
    for tids in translations.values():
        all_tids.update(tids)
    tid_text: dict[int, tuple] = {}
    for raw in open(sent_path, encoding="utf-8"):
        parts = raw.rstrip("\n").split("\t")
        if len(parts) < 3:
            continue
        try:
            sid, lang, text = int(parts[0]), parts[1], parts[2]
        except ValueError:
            continue
        if sid in all_tids and len(text) <= 200:
            tid_text[sid] = (lang, text)

    # 组装输出
    for lang in ["en", "fr", "ja"]:
        m = lang_entries[lang]
        out_sents = common.WORK / lang / "sentences.jsonl"
        out_links = common.WORK / lang / "entry_sentence.jsonl"
        sent_rows = {}
        link_rows = []
        for sid, norms in hits[lang].items():
            text = ja_sent_cache.get(sid) if lang == "ja" else sent_text.get(sid)
            if text is None:
                continue
            trans = []
            for tid in translations.get(sid, []):
                if tid in tid_text:
                    tlang, ttext = tid_text[tid]
                    # 排序键：普通话最优，粤语等中文变体次之，其他语言最后
                    prio = 0 if tlang == "cmn" else (1 if tlang in ZH_CODES else 2)
                    trans.append((prio, tlang, ttext))
            trans.sort(key=lambda x: x[0])
            # 译文只保留中文（普通话优先，粤语等次之）；无中文译文的句子不作为例句
            translations_out = [t[2] for t in trans if t[0] <= 1][:1]
            if not translations_out:
                continue
            score = 1.0 if len(text) <= MAX_SENT_LEN[lang] * 0.6 else 0.0
            sent_rows[sid] = {"id": sid, "text": text, "translation": translations_out}
            for ek in norms:
                if ek in m:
                    link_rows.append({"entry": ek, "sentence_id": sid, "score": score})

        # 每 entry 截断 top N
        by_entry = defaultdict(list)
        for r in link_rows:
            by_entry[r["entry"]].append(r)
        final_links = []
        for ek, rows in by_entry.items():
            rows.sort(key=lambda x: -x["score"])
            final_links.extend(rows[: args.per_entry])
        used_sids = {r["sentence_id"] for r in final_links}

        n = common.write_jsonl(out_sents, (sent_rows[sid] for sid in used_sids if sid in sent_rows))
        n2 = common.write_jsonl(out_links, final_links)
        common.log(f"[{lang}] 例句 {n}，关联 {n2}（entry {len(by_entry)} 个）")


if __name__ == "__main__":
    main()
