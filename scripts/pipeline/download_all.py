"""下载全部原始数据源到 data/raw/。可重复执行（已存在且校验通过则跳过）。

用法: python3 scripts/pipeline/download_all.py [--only name1,name2]
"""

import argparse
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

# jmdict-simplified 需要先查最新 release tag
JMDICT_REPO = "https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest"


def jmdict_sources():
    req = urllib.request.Request(
        JMDICT_REPO,
        headers={"User-Agent": "podic-pipeline/0.1", "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.load(resp)
    tag = data["tag_name"]
    assets = {a["name"]: a["browser_download_url"] for a in data["assets"]}
    out = {}
    for key, prefix in [
        ("jmdict_eng", f"jmdict-eng-common-{tag}.json.zip"),
        ("kanjidic2", f"kanjidic2-en-{tag}.json.zip"),
        ("jmdict_fre", f"jmdict-fre-{tag}.json.zip"),
    ]:
        if prefix in assets:
            out[key] = {
                "url": assets[prefix],
                "file": prefix,
                "cc": {
                    "name": "JMdict/EDRDG",
                    "url": "https://www.edrdg.org/jmdict/j_jmdict.html",
                    "license": "CC BY-SA 4.0",
                },
            }
    common.log(f"jmdict-simplified tag = {tag}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="逗号分隔的源名，缺省全部")
    args = ap.parse_args()

    try:
        common.SOURCES.update(jmdict_sources())
    except Exception as e:  # noqa: BLE001 - 查不到 tag 不阻塞其他源
        common.log(f"[warn] 获取 jmdict-simplified release 失败: {e}")

    only = set(args.only.split(",")) if args.only else None
    failed = []
    for name in common.SOURCES:
        if only and name not in only:
            continue
        try:
            common.download(name)
        except Exception as e:  # noqa: BLE001 - 单个源失败不阻塞
            common.log(f"[fail] {name}: {e}")
            failed.append(name)

    if failed:
        common.log(f"失败源: {failed}")
        sys.exit(1)
    common.log("全部下载完成")


if __name__ == "__main__":
    main()
