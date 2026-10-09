"""词典包校验：构建前（JSONL 输入）与构建后（SQLite 包）两道检查。

用法:
  python3 scripts/pipeline/validate_pack.py --jsonl data/work/de/entries.jsonl --lang de   # 构建输入预检
  python3 scripts/pipeline/validate_pack.py packs/community-de-0.1.0.db                   # 构建后验收

JSONL 检查: 必填字段/类型、norm 与 headword 一致性（common.norm）、zh_terms 下标范围。
SQLite 检查: meta 完整（schema_version/lang/pack_id）、必需表齐、norm 抽样一致性、
zh_index 越界（sense_idx >= senses 数组长度）、entry_fts 冒烟查询、entry_count 对账。
退出码非 0 = 校验失败（CI/脚本可依赖）。
"""

import argparse
import json
import random
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

REQUIRED_TABLES = ["entry", "form", "zh_index", "sentence", "entry_sentence"]


def fail(msg: str):
    print(f"[FAIL] {msg}")
    sys.exit(1)


def check_jsonl(path: Path, lang: str):
    n = 0
    norms = set()
    for i, line in enumerate(open(path, encoding="utf-8"), 1):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception as ex:
            fail(f"第 {i} 行不是合法 JSON: {ex}")
        for k in ("headword", "norm"):
            if not isinstance(e.get(k), str) or not e[k].strip():
                fail(f"第 {i} 行缺 {k}")
        want = common.norm(e["headword"], lang)
        if e["norm"] != want:
            fail(f"第 {i} 行 norm 不一致: headword={e['headword']!r} norm={e['norm']!r} 应为 {want!r}")
        if not isinstance(e.get("senses"), list):
            fail(f"第 {i} 行 senses 不是数组")
        for t in e.get("zh_terms") or []:
            if not isinstance(t, list) or len(t) < 2 or not (0 <= int(t[1]) < len(e["senses"])):
                fail(f"第 {i} 行 zh_terms 下标越界: {t!r}")
        if e["norm"] in norms:
            print(f"[warn] 第 {i} 行 norm 重复: {e['norm']!r}（同 norm 多词条会并列展示，确认是有意的）")
        norms.add(e["norm"])
        n += 1
    print(f"[ok] {path}: {n} 条，字段/norm/下标检查通过")


def check_db(path: Path):
    if not path.exists():
        fail(f"文件不存在: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    meta = dict(conn.execute("SELECT key, value FROM meta"))
    for k in ("schema_version", "lang", "pack_id", "version"):
        if k not in meta:
            fail(f"meta 缺 {k}")
    if meta.get("schema_version") != "1":
        fail(f"schema_version={meta.get('schema_version')!r}，本工具只认 1")
    import re as _re
    if not _re.fullmatch(r"[a-z]{2,4}", meta["lang"]):
        fail(f"meta.lang={meta['lang']!r} 不是 2-4 位小写字母")
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for t in REQUIRED_TABLES + ["entry_fts", "meta"]:
        if t not in tables:
            fail(f"缺表 {t}")

    lang = meta["lang"]
    n = conn.execute("SELECT count(*) FROM entry").fetchone()[0]
    if n == 0:
        fail("entry 表为空")
    declared = meta.get("entry_count")
    if declared and int(declared) != n:
        fail(f"entry_count 对账失败: meta={declared} 实际={n}")

    bad_idx = conn.execute(
        "SELECT count(*) FROM zh_index z JOIN entry e ON e.id = z.entry_id "
        "WHERE z.sense_idx >= json_array_length(e.senses)"
    ).fetchone()[0]
    if bad_idx:
        fail(f"zh_index 有 {bad_idx} 条 sense_idx 越界")

    sample = [r for r in conn.execute("SELECT headword, norm FROM entry")]
    for headword, norm in random.Random(7).sample(sample, min(50, len(sample))):
        if norm != common.norm(headword, lang):
            fail(f"norm 抽样不一致: headword={headword!r} norm={norm!r} 应为 {common.norm(headword, lang)!r}")

    fts_probe = conn.execute(
        "SELECT count(*) FROM entry_fts WHERE entry_fts MATCH '\"' || replace((SELECT headword FROM entry LIMIT 1), '\"', '\"\"') || '\"'"
    ).fetchone()[0]
    if fts_probe < 1:
        print("[warn] FTS 首词冒烟未命中（分词差异，建议人工确认搜索表现）")
    print(f"[ok] {path}: {n} 词条，表结构/meta/越界/norm 抽样/FTS 检查通过")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db", nargs="?", help="构建后的 .db")
    ap.add_argument("--jsonl", help="构建输入 entries.jsonl")
    ap.add_argument("--lang", help="JSONL 预检时的语言码")
    args = ap.parse_args()
    if args.jsonl:
        if not args.lang:
            ap.error("--jsonl 需要 --lang")
        check_jsonl(Path(args.jsonl), args.lang)
    if args.db:
        check_db(Path(args.db))


if __name__ == "__main__":
    main()
