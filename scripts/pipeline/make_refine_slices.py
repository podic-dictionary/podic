"""把待精修词条切成切片文件，供并行 subagent 处理。

输出: data/work/{lang}/refine_slices/slice-N.input.jsonl
      每行 {"headword","reading","pos","gender","glosses"}，N 为全局递增序号（含 fr+ja）。
用法: python3 scripts/pipeline/make_refine_slices.py [--size 500]
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common


def glosses_of(e: dict) -> list[str]:
    out = []
    for s in e.get("senses") or []:
        if isinstance(s, dict):
            g = s.get("en") or s.get("fr")
            if g:
                out.append(g)
    return out[:3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=500)
    args = ap.parse_args()

    n = 0
    for lang in ["fr", "ja"]:
        entries = list(common.read_jsonl(common.WORK / lang / "entries.jsonl"))
        entries.sort(key=lambda x: -x.get("freq", 0))
        todo = [e for e in entries if not (e.get("extra") or {}).get("refined")]
        sdir = common.WORK / lang / "refine_slices"
        sdir.mkdir(parents=True, exist_ok=True)
        for old in sdir.glob("slice-*"):
            old.unlink()  # 重新生成时清空旧切片
        for i in range(0, len(todo), args.size):
            chunk = todo[i : i + args.size]
            rows = [
                {
                    "headword": e["headword"],
                    "reading": e.get("reading"),
                    "pos": e.get("pos"),
                    "gender": e.get("gender"),
                    "glosses": glosses_of(e),
                }
                for e in chunk
            ]
            (sdir / f"slice-{n:04d}.input.jsonl").write_text(
                "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8"
            )
            n += 1
        common.log(f"[{lang}] 待精修 {len(todo)}，切片 {(len(todo) + args.size - 1) // args.size}")
    common.log(f"共 {n} 个切片 -> data/work/*/refine_slices/")


if __name__ == "__main__":
    main()
