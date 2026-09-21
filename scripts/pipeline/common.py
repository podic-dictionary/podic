"""podic 数据管道公共库：下载、校验、规范化、JSONL IO。

代理：urllib 默认读取 https_proxy/http_proxy 环境变量，无需硬编码。
下载 GitHub 等境外源前可 `export https_proxy=http://<代理地址>:<端口>`。
"""

from __future__ import annotations

import hashlib
import json
import sys
import unicodedata
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
RAW = ROOT / "data" / "raw"
WORK = ROOT / "data" / "work"

# 数据源（URL 集中维护；cc: 构建时写入包 meta 的致谢信息）
SOURCES = {
    "ecdict": {
        "url": "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv",
        "file": "ecdict.csv",
        "cc": {"name": "ECDICT", "url": "https://github.com/skywind3000/ECDICT", "license": "MIT"},
    },
    "lexique": {
        "url": "http://www.lexique.org/databases/Lexique383/Lexique383.tsv",
        "file": "Lexique383.tsv",
        "md5": "a742a88cb00759c1ebed34995aed9904",
        "cc": {"name": "Lexique383", "url": "http://www.lexique.org", "license": "CC BY 4.0"},
    },
    "cfdict": {
        "url": "https://chine.in/assets/cfdict/cfdict.u8",
        "file": "cfdict.u8",
        "cc": {"name": "CFDICT", "url": "https://chine.in/cfdict.php", "license": "CC BY-SA 3.0"},
    },
    "cedict": {
        "url": "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz",
        "file": "cedict.txt.gz",
        "cc": {"name": "CC-CEDICT", "url": "https://www.mdbg.net/chinese-dictionary/page/cedict", "license": "CC BY-SA 4.0"},
    },
    "tatoeba_sentences": {
        "url": "https://downloads.tatoeba.org/exports/sentences.tar.bz2",
        "file": "tatoeba_sentences.tar.bz2",
        "member": "sentences.csv",
        "extract": "tatoeba_sentences.csv",
        "cc": {"name": "Tatoeba", "url": "https://tatoeba.org", "license": "CC BY 2.0 FR"},
    },
    "tatoeba_links": {
        "url": "https://downloads.tatoeba.org/exports/links.tar.bz2",
        "file": "tatoeba_links.tar.bz2",
        "member": "links.csv",
        "extract": "tatoeba_links.csv",
        "cc": {"name": "Tatoeba", "url": "https://tatoeba.org", "license": "CC BY 2.0 FR"},
    },
    "deinflect": {
        "url": "https://raw.githubusercontent.com/FooSoft/yomichan/master/ext/data/deinflect.json",
        "file": "deinflect.json",
        "cc": {"name": "Yomitan (deinflect)", "url": "https://github.com/FooSoft/yomichan", "license": "GPL-3.0"},
    },
}


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def file_hash(path: Path, algo: str) -> str:
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _extract_if_needed(src: dict, dest: Path) -> Path:
    if "extract" not in src:
        return dest
    final = RAW / src["extract"]
    if final.exists():
        return final
    import tarfile
    member_name = src.get("member", src["extract"])
    with tarfile.open(dest, "r:bz2") as tf:
        member = next(
            m for m in tf.getmembers()
            if Path(m.name).name == member_name or m.name.endswith("/" + member_name)
        )
        with tf.extractfile(member) as f, open(final, "wb") as out:
            while chunk := f.read(1 << 20):
                out.write(chunk)
    log(f"[done] 解压 -> {final}")
    return final


def download(name: str, force: bool = False) -> Path:
    """下载 SOURCES[name] 到 data/raw/，已存在且校验通过则跳过。"""
    src = SOURCES[name]
    dest = RAW / src["file"]
    if dest.exists() and not force:
        if "md5" in src:
            got = file_hash(dest, "md5")
            if got == src["md5"]:
                log(f"[skip] {name} -> {dest}")
                return _extract_if_needed(src, dest)
            log(f"[warn] {name} 已存在但 md5 不符，重新下载")
        else:
            log(f"[skip] {name} -> {dest}（无校验和，直接复用）")
            return _extract_if_needed(src, dest)

    RAW.mkdir(parents=True, exist_ok=True)
    log(f"[get ] {name} <- {src['url']}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(src["url"], headers={"User-Agent": "podic-pipeline/0.1"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total:
                pct = done * 100 // total
                print(f"\r{name}: {pct:3d}%  ({done >> 20}MiB)", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)

    if "md5" in src:
        got = file_hash(tmp, "md5")
        if got != src["md5"]:
            tmp.unlink()
            raise RuntimeError(f"{name} md5 校验失败: got {got}, want {src['md5']}")
    tmp.rename(dest)

    if "extract" in src:
        import tarfile
        final = RAW / src["extract"]
        member_name = src.get("member", src["extract"])
        with tarfile.open(dest, "r:bz2") as tf:
            member = next(
                m for m in tf.getmembers()
                if Path(m.name).name == member_name or m.name.endswith("/" + member_name)
            )
            with tf.extractfile(member) as f, open(final, "wb") as out:
                while chunk := f.read(1 << 20):
                    out.write(chunk)
        log(f"[done] {name} -> {final}")
        return final

    log(f"[done] {name} -> {dest}")
    return dest


# ---------------- 规范化 ----------------

# 片假名 -> 平假名（含 ヴ）
_KATA_START, _KATA_END = 0x30A1, 0x30F6


def kata_to_hira(s: str) -> str:
    out = []
    for c in s:
        cp = ord(c)
        if _KATA_START <= cp <= _KATA_END:
            out.append(chr(cp - _KATA_START + 0x3041))
        else:
            out.append(c)
    return "".join(out)


def norm(s: str, lang: str) -> str:
    """检索规范化：NFKC + 小写；fr 去变音符；ja 片假名转平假名。"""
    s = unicodedata.normalize("NFKC", s).casefold().strip()
    if lang == "fr":
        s = "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))
    if lang == "ja":
        s = kata_to_hira(s)
    return s


def zh_term_norm(term: str) -> str:
    """中文反查词规范化：NFKC + 去空白 + 小写。"""
    return unicodedata.normalize("NFKC", term).casefold().replace(" ", "")


# ---------------- JSONL ----------------

def write_jsonl(path: Path, rows) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
    return n


def read_jsonl(path: Path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)
