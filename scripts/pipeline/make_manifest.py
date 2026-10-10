"""产出并发布 release 资产：packs/*.db.gz + {lang}-metainfo.json + manifest.json

发布模型：dict 仓只有唯一滚动 tag（--tag packs，默认），
- 每个语言一个 {lang}-metainfo.json 作为发布记录：顶层 = 最新版本（含 notes 版本说明），
  history 数组保留历史版本（旧 .db.gz 按文件名在 release 里共存，不删除）
- 有新版本的语言才重新上传 .db.gz 与 metainfo，未变化的语言包不重复上传
- manifest.json（全量最新清单）同时更新，兼容旧版客户端
用法：
  python3 scripts/pipeline/make_manifest.py --lang fr [--notes fr=说明文本] [--tag packs] [--upload]
  --lang 缺省 = 全部语言；--notes 可多次（lang=文本），缺省沿用该语言上一版的说明
"""

import argparse
import datetime
import gzip
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

REPO = "podic-dictionary/dict"


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def version_key(v: str):
    return tuple(int(p) for p in v.split("-")[0].split("."))


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True)


def fetch_remote_meta(tag: str, lang: str) -> dict | None:
    """读 release 上该语言现有的 metainfo（没有 = None）"""
    url = f"https://github.com/{REPO}/releases/download/{tag}/{lang}-metainfo.json"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except Exception:
        return None


def slim(entry: dict) -> dict:
    """history 条目 = 纯版本记录：只留版本号/说明/构建信息。
    旧版 .db.gz 资产不长期保留（release 里会被清理），file/sha256 指向已删文件就是死链"""
    return {k: entry[k] for k in
            ("version", "notes", "built_at", "entry_count", "sources") if k in entry}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", action="append", help="语言码（可多次；缺省 = 全部）")
    ap.add_argument("--notes", action="append", default=[],
                    help="版本说明，格式 lang=文本（可多次）；缺省沿用上一版说明")
    ap.add_argument("--tag", default="packs", help="发布到的滚动 tag（默认 packs）")
    ap.add_argument("--upload", action="store_true", help="生成后上传到 GitHub release")
    args = ap.parse_args()
    notes_in = dict(n.split("=", 1) for n in args.notes)

    packs_dir = common.ROOT / "packs"
    # 按包内 meta.lang 分组（pack_id 可含连字符，比解析文件名稳），每语言取版本号最大的 .db
    by_lang: dict[str, tuple[str, Path]] = {}
    for db_path in sorted(packs_dir.glob("*.db")):
        if db_path.name.endswith(".part"):
            continue
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        meta = dict(conn.execute("SELECT key, value FROM meta"))
        conn.close()
        lang = meta.get("lang", "")
        if not lang:
            common.log(f"[warn] {db_path.name} 缺 meta.lang，跳过")
            continue
        ver = meta.get("version", "0")
        if lang not in by_lang or version_key(ver) > version_key(by_lang[lang][0]):
            by_lang[lang] = (ver, db_path)
    if not by_lang:
        common.log("[skip] packs/ 下没有匹配的词典包")
        return

    entries, uploads = [], []
    for lang, (_, db_path) in by_lang.items():
        if args.lang and lang not in args.lang:
            # 非本次目标语言：不重压缩不上传，metainfo 原样并入 manifest（保持全量）
            prev = fetch_remote_meta(args.tag, lang) if args.upload else \
                json.load(open(packs_dir / f"{lang}-metainfo.json", encoding="utf-8")) \
                if (packs_dir / f"{lang}-metainfo.json").exists() else None
            if prev:
                entries.append(prev)
            else:
                common.log(f"[warn] {lang} 无现成 metainfo（远端/本地都没有），该语言将缺席 manifest")
            continue
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        meta = dict(conn.execute("SELECT key, value FROM meta"))
        conn.close()

        remote = fetch_remote_meta(args.tag, lang) if args.upload else None
        new_sha = file_sha256(db_path)
        local_meta_path = packs_dir / f"{lang}-metainfo.json"
        local_prev = json.load(open(local_meta_path, encoding="utf-8")) if local_meta_path.exists() else None
        # 资产命名统一「语言码-dict-版本」开头（release 页按语言聚合排序）；
        # 官方/社区之分在包内 meta.pack_id，文件名不承载
        gz_path = packs_dir / f"{lang}-dict-{meta['version']}.db.gz"
        # 版本/哈希/文件名都一致且本次没改说明 → 跳过；--notes 传入（补说明）时强制重传
        if (remote and remote.get("version") == meta["version"] and remote.get("sha256") == new_sha
                and remote.get("file") == gz_path.name and lang not in notes_in):
            common.log(f"[{lang}] v{meta['version']} 与 release 一致，跳过（不重复上传）")
            entries.append(remote)
            continue

        if not gz_path.exists() or file_sha256(db_path) != new_sha:
            with open(db_path, "rb") as fin, gzip.open(gz_path, "wb", compresslevel=6) as fout:
                shutil.copyfileobj(fin, fout, 1 << 20)

        # 历史版本保留：远端 metainfo 优先，其次本地旧文件；当前版本降级进 history，去重
        if remote is not None:
            prev = remote
        else:
            prev = local_prev
        entry = {
            "lang": lang,
            "pack_id": meta["pack_id"],
            "version": meta["version"],
            # 说明优先级：本次命令行 > 远端 metainfo > 本地旧 metainfo
            "notes": notes_in.get(lang) or (remote or {}).get("notes") or (prev or {}).get("notes") or "",
            "built_at": meta["built_at"],
            "entry_count": int(meta.get("entry_count", 0)),
            "file": gz_path.name,
            "sha256": new_sha,
            "size": gz_path.stat().st_size,
            "sources": json.loads(meta.get("sources", "[]")),
        }
        history = list((prev or {}).get("history", []))
        if prev and prev.get("version") != entry["version"]:
            history.insert(0, slim(prev))
        seen = set()
        # 存量条目也过 slim：清掉指向已清理资产的 file/sha256/size 死链字段
        entry["history"] = [slim(h) if "file" in h else h
                            for h in history if not (h["version"] in seen or seen.add(h["version"]))]

        entries.append(entry)
        meta_path = packs_dir / f"{lang}-metainfo.json"
        json.dump(entry, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        uploads += [gz_path, meta_path]
        common.log(f"[{lang}] {gz_path.name} sha256={new_sha[:12]}… size={entry['size'] >> 20}MB "
                   f"history={len(entry['history'])}")

    manifest = {
        "schema_version": 1,
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "packs": entries,
    }
    json.dump(manifest, open(packs_dir / "manifest.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    common.log(f"manifest -> {packs_dir / 'manifest.json'}")

    if not args.upload:
        return

    # 唯一滚动 tag：release 不存在则建
    rels = gh("release", "list", "-R", REPO, "--json", "tagName").stdout
    if args.tag not in [r["tagName"] for r in json.loads(rels)]:
        gh("release", "create", args.tag, "-R", REPO, "--title", "词典包（滚动发布）",
           "--notes", "每语言一个 {lang}-metainfo.json 发布记录（最新版本+历史）；包文件按文件名共存")
        common.log(f"[release] 新建滚动 tag {args.tag}")

    # manifest.json 每次都重传（含 updated_at）；db.gz / metainfo 只有变化才在 uploads 里
    files = [str(p) for p in uploads] + [str(packs_dir / "manifest.json")]
    gh("release", "upload", args.tag, "-R", REPO, *files, "--clobber")
    common.log(f"[upload] {len(files)} 个文件 -> {args.tag}")


if __name__ == "__main__":
    main()
