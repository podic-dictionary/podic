"""中间 JSONL -> 词典包 SQLite（schema v1）

用法: python3 scripts/pipeline/build_pack.py --lang en --version 0.1.0 \
        [--sources ecdict,tatoeba_sentences] [--examples]
输入: data/work/<lang>/{entries,forms}.jsonl [+ sentences.jsonl / entry_sentence.jsonl]
输出: packs/podic-<lang>-<version>.db
"""

import argparse
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
    return json.dumps(out, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", required=True, choices=["en", "fr", "ja"])
    ap.add_argument("--version", default="0.1.0")
    ap.add_argument("--sources", default="", help="逗号分隔的 SOURCES 键，写进 meta")
    ap.add_argument("--examples", action="store_true", help="合并 sentences.jsonl / entry_sentence.jsonl")
    ap.add_argument("--out", help="输出 db 路径，缺省 packs/podic-<lang>-<version>.db")
    args = ap.parse_args()

    work = common.WORK / args.lang
    out = Path(args.out) if args.out else common.ROOT / "packs" / f"podic-{args.lang}-{args.version}.db"
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
    pack_id = f"podic-{args.lang}"
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
    for e in common.read_jsonl(work / "entries.jsonl"):
        for eid in norm_to_id.get(e["norm"]) or []:
            for row in e.get("zh_terms") or []:
                term, sense_idx = row[0], row[1]
                origin = row[2] if len(row) > 2 else "pipeline"
                zh_batch.append((common.zh_term_norm(term), eid, sense_idx, origin))
    db.executemany("INSERT OR IGNORE INTO zh_index(term_norm, entry_id, sense_idx, origin) VALUES (?,?,?,?)",
                   zh_batch)
    n_zh = len(zh_batch)

    # ---- form ----
    n_form = 0
    form_batch = []
    for f in common.read_jsonl(work / "forms.jsonl"):
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
            key = r["entry"]
            # norm 优先（ja 关联键是 norm；fr 无变音词 key 即 norm），变音词 norm 未命中走 casefold(headword)
            for eid in norm_to_id.get(key) or head_to_id.get(key) or []:
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
