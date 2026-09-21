"""合并精修切片产出 -> entries.jsonl（含复核修正）。

流程: 各切片 .output.jsonl（+.fix.jsonl 覆盖） -> refined.jsonl（全量格式，幂等）
      -> 应用到 entries.jsonl（覆盖前 N 个 sense 保留原 en/fr/kind/tags 字段，标 extra.refined）
用法: python3 scripts/pipeline/merge_refined.py
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

# 精修 sense 的词性前缀需与词条自身 pos（Lexique cgram/JMDict，标准答案）兼容，防串词幻觉
# 如 élevé(adj) 幻觉出 "n. 学生（= élève）"、voyage(n) 幻觉出 "v. 旅行"
_SENSE_POS = re.compile(r"^(n|v|adj|adv)\.")


def load_slice_rows(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            pass  # 坏行丢弃
    return rows


def main():
    stats = {"slices": 0, "rows": 0, "bad": 0, "missing": 0, "merged": 0, "pos_dropped": 0, "dup_dropped": 0}
    refined: dict[str, dict] = {}

    for lang in ["fr", "ja"]:
        sdir = common.WORK / lang / "refine_slices"
        if not sdir.exists():
            continue
        entries = {e["headword"]: e for e in common.read_jsonl(common.WORK / lang / "entries.jsonl")}
        for input_path in sorted(sdir.glob("slice-*.input.jsonl")):
            base = input_path.with_name(input_path.name.replace(".input.jsonl", ".output.jsonl"))
            if not base.exists():
                stats["missing"] += 1
                continue
            fix = base.with_name(base.name.replace(".output.jsonl", ".fix.jsonl"))
            rows = load_slice_rows(base)
            if fix.exists():
                fixes = {r.get("headword"): r for r in load_slice_rows(fix)}
                rows = [fixes.get(r.get("headword"), r) for r in rows]

            inputs = [json.loads(l) for l in input_path.read_text(encoding="utf-8").splitlines() if l.strip()]
            # 产出按 headword 匹配（不依赖行序，允许部分产出）
            row_by_head = {r.get("headword"): r for r in rows if isinstance(r, dict)}
            for src in inputs:
                headword = src["headword"]
                r = row_by_head.get(headword)
                if not r:
                    stats["bad"] += 1
                    continue
                senses = r.get("senses")
                if not senses or not isinstance(senses, list):
                    stats["bad"] += 1
                    continue
                clean = []
                for s in senses[:4]:
                    if isinstance(s, dict) and s.get("zh"):
                        clean.append({"zh": str(s["zh"])})
                if not clean:
                    stats["bad"] += 1
                    continue
                if headword not in entries:
                    stats["missing"] += 1
                    continue
                refined[headword] = {"headword": headword, "senses": clean}
                stats["rows"] += 1
            stats["slices"] += 1

    # 写 refined.jsonl（全量幂等格式）
    out = common.WORK / "refined_merged.jsonl"
    with open(out, "w", encoding="utf-8") as f:
        for r in refined.values():
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    # 应用到 entries.jsonl
    for lang in ["fr", "ja"]:
        entries_path = common.WORK / lang / "entries.jsonl"
        entries = list(common.read_jsonl(entries_path))
        changed = False
        for e in entries:
            r = refined.get(e["headword"])
            if not r:
                continue
            entry_pos = {str(p).lower() for p in (e.get("pos") or [])}
            new_senses = []
            for s in r["senses"]:
                m = _SENSE_POS.match(s["zh"])
                # 无词性数据的词条不过滤；sense 无词性前缀也不过滤
                if m and entry_pos and not any(p.startswith(m.group(1)) for p in entry_pos):
                    stats["pos_dropped"] += 1
                    continue
                new_senses.append({"zh": s["zh"]})
            old = e.get("senses") or []
            for i, s in enumerate(new_senses):
                if i < len(old) and isinstance(old[i], dict):
                    keep = {k: v for k, v in old[i].items() if k in ("en", "fr", "kind", "tags", "pos")}
                    s.update(keep)
            # CFDICT 补充义与精修释义重复时去掉（élève 已有「n. 学生，学员」，CFDICT 的「学生」不再重复）
            refined_zh = "".join(s["zh"] for s in new_senses)
            leftovers = []
            for s in old[len(new_senses):]:
                if (isinstance(s, dict) and s.get("zh") and s.get("zh") in refined_zh
                        and "CFDICT" in (s.get("tags") or [])):
                    stats["dup_dropped"] += 1
                    continue
                leftovers.append(s)
            e["senses"] = new_senses + leftovers
            e.setdefault("extra", {})["refined"] = True
            changed = True
            stats["merged"] += 1
        if changed:
            with open(entries_path, "w", encoding="utf-8") as f:
                for e in entries:
                    f.write(json.dumps(e, ensure_ascii=False) + "\n")

    common.log(
        f"切片 {stats['slices']}（缺产出 {stats['missing']}）| 有效行 {stats['rows']}（坏行 {stats['bad']}，"
        f"词表缺 {stats['missing'] and 0}）| 合并 {stats['merged']} 词条（词性冲突丢弃 {stats['pos_dropped']}，"
        f"重复 CFDICT 丢弃 {stats['dup_dropped']}） -> {out}"
    )


if __name__ == "__main__":
    main()
