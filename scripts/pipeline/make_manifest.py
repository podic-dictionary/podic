"""产出 release 资产：packs/*.db.gz + packs/manifest.json

manifest 的 sha256 为解压后 .db 的哈希（下载后解压再校验，防 gzip 层篡改）。
用法: python3 scripts/pipeline/make_manifest.py --version 0.1.0 [--base-url https://github.com/<owner>/podic/releases/latest/download]
"""

import argparse
import datetime
import gzip
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--base-url", default="")
    args = ap.parse_args()

    packs_dir = common.ROOT / "packs"
    entries = []
    for db_path in sorted(packs_dir.glob(f"podic-*-{'*' if args.version == '*' else args.version}.db")):
        if db_path.name.endswith(".part"):
            continue
        # 读包 meta
        conn = sqlite3.connect(db_path)
        meta = dict(conn.execute("SELECT key, value FROM meta"))
        conn.close()
        lang = meta["lang"]

        gz_path = db_path.with_name(db_path.name + ".gz")
        with open(db_path, "rb") as fin, gzip.open(gz_path, "wb", compresslevel=6) as fout:
            while chunk := fin.read(1 << 20):
                fout.write(chunk)

        entry = {
            "lang": lang,
            "pack_id": meta["pack_id"],
            "version": meta["version"],
            "built_at": meta["built_at"],
            "entry_count": int(meta.get("entry_count", 0)),
            "file": gz_path.name,
            "sha256": file_sha256(db_path),
            "size": gz_path.stat().st_size,
            "sources": json.loads(meta.get("sources", "[]")),
        }
        if args.base_url:
            entry["url"] = f"{args.base_url.rstrip('/')}/{gz_path.name}"
        entries.append(entry)
        common.log(f"[{lang}] {gz_path.name} sha256={entry['sha256'][:12]}… size={entry['size'] >> 20}MB")

    manifest = {
        "schema_version": 1,
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "packs": entries,
    }
    out = packs_dir / "manifest.json"
    json.dump(manifest, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    common.log(f"manifest -> {out}")


if __name__ == "__main__":
    main()
