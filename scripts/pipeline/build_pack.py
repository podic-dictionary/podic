"""中间 JSONL -> 词典包 SQLite（schema v1）

用法: python3 scripts/pipeline/build_pack.py --lang en --version 0.1.0 \
        [--sources ecdict,tatoeba_sentences] [--examples]
输入: data/work/<lang>/{entries,forms}.jsonl [+ sentences.jsonl / entry_sentence.jsonl]
输出: packs/podic-<lang>-<version>.db
"""

import argparse
import re
import datetime
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

SCHEMA_VERSION = 1

DDL = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE entry(
  id INTEGER PRIMARY KEY,
  headword TEXT NOT NULL,
  reading  TEXT,
  norm     TEXT NOT NULL,
  ipa      TEXT,
  pos      TEXT,
  gender   TEXT,
  freq     REAL NOT NULL DEFAULT 0,
  senses   TEXT,
  zh_text  TEXT,
  extra    TEXT
);
-- norm 允许重复：不同词去变音后可能同 norm（fr: élève/élevé；ja: カッと/カット），查询时并列返回
CREATE INDEX idx_entry_norm ON entry(norm);
CREATE INDEX idx_entry_headword ON entry(headword);
CREATE INDEX idx_entry_freq ON entry(freq DESC);

CREATE TABLE form(
  form_norm TEXT NOT NULL,
  entry_id  INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  rule      TEXT
);
CREATE INDEX idx_form ON form(form_norm);

CREATE TABLE zh_index(
  term_norm TEXT NOT NULL,
  entry_id  INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  sense_idx INTEGER,
  origin    TEXT
);
CREATE INDEX idx_zh ON zh_index(term_norm);

CREATE TABLE sentence(
  id          INTEGER PRIMARY KEY,
  text        TEXT NOT NULL,
  translation TEXT
);
CREATE TABLE entry_sentence(
  entry_id    INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  sentence_id INTEGER NOT NULL REFERENCES sentence(id) ON DELETE CASCADE,
  score       REAL
);
CREATE INDEX idx_entry_sentence ON entry_sentence(entry_id, score DESC);

CREATE VIRTUAL TABLE entry_fts USING fts5(
  headword, reading, zh_text,
  content = 'entry', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER entry_ai AFTER INSERT ON entry BEGIN
  INSERT INTO entry_fts(rowid, headword, reading, zh_text)
  VALUES (new.id, new.headword, new.reading, new.zh_text);
END;
CREATE TRIGGER entry_ad AFTER DELETE ON entry BEGIN
  INSERT INTO entry_fts(entry_fts, rowid, headword, reading, zh_text)
  VALUES ('delete', old.id, old.headword, old.reading, old.zh_text);
END;
CREATE TRIGGER entry_au AFTER UPDATE ON entry BEGIN
  INSERT INTO entry_fts(entry_fts, rowid, headword, reading, zh_text)
  VALUES ('delete', old.id, old.headword, old.reading, old.zh_text);
  INSERT INTO entry_fts(rowid, headword, reading, zh_text)
  VALUES (new.id, new.headword, new.reading, new.zh_text);
END;
"""


def load_sources(names: str) -> str:
    out = []
    for name in (names or "").split(","):
        name = name.strip()
        if not name:
            continue
        src = common.SOURCES.get(name)
        if src and "cc" in src:
            out.append(src["cc"])
        elif src:  # jmdict 类动态源：URL 在 download 时确定，这里给项目页
            out.append(src["cc"])
        else:
            # 自定义来源名（community 包常见）：如实写进 meta，不静默丢致谢
            out.append({"name": name, "url": "", "license": ""})
    return json.dumps(out, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", required=True, help="语言码（2-4 位小写字母，多语言化后支持任意语言）")
    ap.add_argument("--version", default="0.1.0")
    ap.add_argument("--pack-id", default="", help="包标识（缺省 <lang>-dict，与发布资产命名一致）")
    ap.add_argument("--sources", default="", help="逗号分隔的 SOURCES 键或自由文本名，写进 meta")
    ap.add_argument("--examples", action="store_true", help="合并 sentences.jsonl / entry_sentence.jsonl")
    ap.add_argument("--out", help="输出 db 路径，缺省 packs/<pack_id>-<version>.db")
    args = ap.parse_args()
    if not re.fullmatch(r"[a-z]{2,4}", args.lang):
        ap.error(f"--lang {args.lang!r} 不合法（2-4 位小写字母）")

    work = common.WORK / args.lang
    pack_id = args.pack_id or f"{args.lang}-dict"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", pack_id):
        ap.error(f"--pack-id {pack_id!r} 不合法（文件名安全字符）")
    out = Path(args.out) if args.out else common.ROOT / "packs" / f"{pack_id}-{args.version}.db"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    for suffix in ("-wal", "-shm", "-journal"):
        p = out.with_name(out.name + suffix)
        if p.exists():
            p.unlink()

    db = sqlite3.connect(out)
    db.executescript(DDL)

    # ---- meta ----
    pack_id = args.pack_id or f"{args.lang}-dict"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", pack_id):
        ap.error(f"--pack-id {pack_id!r} 不合法（文件名安全字符）")
    for k, v in [
        ("schema_version", SCHEMA_VERSION),
        ("lang", args.lang),
        ("pack_id", pack_id),
        ("version", args.version),
        ("built_at", datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")),
        ("sources", load_sources(args.sources)),
    ]:
        db.execute("INSERT INTO meta(key, value) VALUES (?, ?)", (k, v))

    # ---- entry + zh_index ----
    entries = common.read_jsonl(work / "entries.jsonl")
    norm_to_id: dict[str, list] = {}  # 同 norm 可对应多个词条（fr: élève/élevé）
    head_to_id: dict[str, list] = {}  # casefold(headword) -> ids，例句关联用（保变音）
    n_entry = n_zh = 0
    batch = []
    for e in entries:
        norm = e["norm"]
        senses = e.get("senses") or []
        zh_text = "；".join(s["zh"] for s in senses if s.get("zh"))
        batch.append((
            e["headword"], e.get("reading"), norm, e.get("ipa"),
            json.dumps(e.get("pos") or [], ensure_ascii=False), e.get("gender"),
            e.get("freq") or 0.0,
            json.dumps(senses, ensure_ascii=False), zh_text,
            json.dumps(e.get("extra") or {}, ensure_ascii=False),
        ))
        n_entry += 1
    db.executemany(
        "INSERT OR IGNORE INTO entry(headword, reading, norm, ipa, pos, gender, freq, senses, zh_text, extra)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)", batch)
    # 回填 id：norm / casefold(headword) -> [entry_id, ...]
    # 例句关联键 en/fr 是 casefold(headword)（保变音，élève≠élevé），ja 是 norm
    for (eid, norm, head) in db.execute("SELECT id, norm, headword FROM entry"):
        norm_to_id.setdefault(norm, []).append(eid)
        head_to_id.setdefault(head.casefold(), []).append(eid)

    zh_batch = []
    # 同 headword 可有多条词条（如 LLM 把俄语变格词归一成同一词典形），各自义项数不同：
    # sense_idx 必须按「挂载目标词条」的义项数钳制，不能只按产生方钳
    eid_senses_len = dict(db.execute("SELECT id, json_array_length(senses) FROM entry"))
    for e in common.read_jsonl(work / "entries.jsonl"):
        # zh_terms 属于产生它的那个词条：按 casefold(headword) 精确关联。
        # 按 norm 会串到同 norm 的异形词条（élève/élevé），且对方义项数更少时 sense_idx 越界
        eid_list = head_to_id.get(e["headword"].casefold()) or []
        if not eid_list:
            continue
        for row in e.get("zh_terms") or []:
            term, raw_idx = row[0], int(row[1])
            origin = row[2] if len(row) > 2 else "pipeline"
            for eid in eid_list:
                n_senses = eid_senses_len.get(eid) or 0
                if n_senses <= 0:
                    continue
                sense_idx = min(raw_idx, n_senses - 1)  # 目标义项更少时钳到有效范围
                zh_batch.append((common.zh_term_norm(term), eid, sense_idx, origin))
    db.executemany("INSERT OR IGNORE INTO zh_index(term_norm, entry_id, sense_idx, origin) VALUES (?,?,?,?)",
                   zh_batch)
    n_zh = len(zh_batch)

    # ---- form ----
    n_form = 0
    form_batch = []
    forms_path = work / "forms.jsonl"
    forms_iter = common.read_jsonl(forms_path) if forms_path.exists() else iter([])
    for f in forms_iter:
        if f["form_norm"] == f["entry_norm"]:
            continue
        for eid in norm_to_id.get(f["entry_norm"]) or []:
            form_batch.append((f["form_norm"], eid, f.get("rule")))
    db.executemany("INSERT OR IGNORE INTO form(form_norm, entry_id, rule) VALUES (?,?,?)", form_batch)
    n_form = db.execute("SELECT count(*) FROM form").fetchone()[0]

    # ---- 例句 ----
    n_sent = 0
    if args.examples and (work / "sentences.jsonl").exists():
        sent_batch, link_batch = [], []
        for s in common.read_jsonl(work / "sentences.jsonl"):
            sent_batch.append((s["id"], s["text"], json.dumps(s.get("translation") or [], ensure_ascii=False)))
        for r in common.read_jsonl(work / "entry_sentence.jsonl"):
            # 两种键按语义查各自的映射：entry=headword（tatoeba 关联，en/fr）按 casefold 精确
            # 关联；entry_norm=norm（refine 的 AI 例句）按 norm。不能一个键同时回退两个映射——
            # 无变音 headword（如 sur）会先命中 norm_to_id，把例句串到同 norm 的所有词条（sûr）
            if (key := r.get("entry")) is not None:
                ids = head_to_id.get(key.casefold()) or norm_to_id.get(key)  # ja 历史数据的 entry 是 norm
            else:
                ids = norm_to_id.get(r.get("entry_norm") or "")
            for eid in ids or []:
                link_batch.append((eid, r["sentence_id"], r.get("score") or 0.0))
        db.executemany("INSERT OR IGNORE INTO sentence(id, text, translation) VALUES (?,?,?)", sent_batch)
        db.executemany("INSERT OR IGNORE INTO entry_sentence(entry_id, sentence_id, score) VALUES (?,?,?)",
                       link_batch)
        n_sent = len(link_batch)

    db.execute("INSERT INTO meta(key, value) VALUES ('entry_count', ?)", (str(n_entry),))
    db.commit()
    db.execute("PRAGMA optimize")
    db.commit()
    db.execute("VACUUM")
    db.close()

    size_mb = out.stat().st_size / 1048576
    common.log(f"[{args.lang}] entry={n_entry} form={n_form} zh_index={n_zh} sentences={n_sent} "
               f"size={size_mb:.1f}MB -> {out}")


if __name__ == "__main__":
    main()
