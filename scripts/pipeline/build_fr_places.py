"""Wikidata 地名 -> 补 fr 词包的专有名词（国家 + 主要城市）。

背景：fr 词包的其他来源都不收专有名词——Lexique383 是形态词频表，CFDICT 只补释义，
fr.wiktionary 补丁只收多词短语与缩写（见 build_fr_wiktionary.py 的文档字符串）。
结果就是 Paris / Tokyo 这类常用地名查不到（es/de/it/pt 包靠 LLM 词表天然带上了）。

本脚本从 Wikidata 取结构化数据，一次性补三类：
  - 主权国家（P31/P279* = Q6256，排除已解散）
  - 人口 >= 30 万的城市（Q515/Q3957/Q1549591/Q5119）
  - 各国首都（P1376，含人口不足 30 万的小国首都）
法语词头取 fr label，中文释义取 zh-hans → zh-cn → zh 的 label；地名 IPA 从已下载的
fr.wiktionary 抽取里按词头匹配（可选，文件缺失则跳过）。

输出：重建 data/work/fr/entries.jsonl 里 source=wikidata 的地名条目（每轮先摘旧条目），
同词头已存在则跳过，不覆盖词典原有词条。
原始查询结果缓存 data/raw/fr-places.jsonl，重跑不重复打 Wikidata。
"""

import gzip
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

SPARQL = "https://query.wikidata.org/sparql"
UA = "podic-dict/0.1 (lexicon build; +https://github.com/podic-dictionary)"

# 三个查询各自独立：并起来一次查会拖慢端点（城市类 P279* 展开很重）
Q_COUNTRY = """
SELECT ?item ?fr (SAMPLE(?zhh) AS ?zhHans) (SAMPLE(?zhc) AS ?zhCn) (SAMPLE(?zh_) AS ?zh) WHERE {
  # 直接 P31：P279* 会把 micronation、虚构政权等子类一起卷进来（实测混进 Filettino），
  # 三类直接实例覆盖主权国家 + 部分自治构成国（英格兰/苏格兰）
  VALUES ?cls { wd:Q6256 wd:Q3624078 wd:Q3336843 }
  ?item wdt:P31 ?cls .
  FILTER NOT EXISTS { ?item wdt:P576 ?dissolved }
  OPTIONAL { ?item rdfs:label ?fr . FILTER(lang(?fr)="fr") }
  OPTIONAL { ?item rdfs:label ?zhh . FILTER(lang(?zhh)="zh-hans") }
  OPTIONAL { ?item rdfs:label ?zhc . FILTER(lang(?zhc)="zh-cn") }
  OPTIONAL { ?item rdfs:label ?zh_ . FILTER(lang(?zh_)="zh") }
  FILTER(BOUND(?fr))
} GROUP BY ?item ?fr
"""

Q_CITY = """
SELECT ?item ?fr (SAMPLE(?zhh) AS ?zhHans) (SAMPLE(?zhc) AS ?zhCn) (SAMPLE(?zh_) AS ?zh)
       (SAMPLE(?p) AS ?pop) (SAMPLE(?cfr) AS ?countryFr) (SAMPLE(?czh) AS ?countryZh) WHERE {
  VALUES ?cls { wd:Q515 wd:Q3957 wd:Q1549591 wd:Q5119 }
  # 直接 P31：带 P279* 的版本在端点超时（504），少收几百个边缘子类换取可用的查询
  ?item wdt:P31 ?cls .
  ?item wdt:P1082 ?p . FILTER(?p >= 300000)
  OPTIONAL { ?item rdfs:label ?fr . FILTER(lang(?fr)="fr") }
  OPTIONAL { ?item rdfs:label ?zhh . FILTER(lang(?zhh)="zh-hans") }
  OPTIONAL { ?item rdfs:label ?zhc . FILTER(lang(?zhc)="zh-cn") }
  OPTIONAL { ?item rdfs:label ?zh_ . FILTER(lang(?zh_)="zh") }
  OPTIONAL {
    ?item wdt:P17 ?country .
    ?country rdfs:label ?cfr . FILTER(lang(?cfr)="fr")
    OPTIONAL { ?country rdfs:label ?czh . FILTER(lang(?czh)="zh-hans") }
  }
  FILTER(BOUND(?fr))
} GROUP BY ?item ?fr
"""

# 首都单独查：小国首都市区人口常不到 30 万，但查词需求高
Q_CAPITAL = """
SELECT ?item ?fr (SAMPLE(?zhh) AS ?zhHans) (SAMPLE(?zhc) AS ?zhCn) (SAMPLE(?zh_) AS ?zh)
       (SAMPLE(?p) AS ?pop) (SAMPLE(?cfr) AS ?countryFr) (SAMPLE(?czh) AS ?countryZh) WHERE {
  ?item wdt:P1376 ?country .
  # 只要主权国家：伦敦同时是英格兰与英国的首都，限定主权级才能拿到「英国」这种国家名
  ?country wdt:P31 ?ccls . VALUES ?ccls { wd:Q6256 wd:Q3624078 }
  FILTER NOT EXISTS { ?country wdt:P576 ?dissolved }
  OPTIONAL { ?item wdt:P1082 ?p }
  OPTIONAL { ?item rdfs:label ?fr . FILTER(lang(?fr)="fr") }
  OPTIONAL { ?item rdfs:label ?zhh . FILTER(lang(?zhh)="zh-hans") }
  OPTIONAL { ?item rdfs:label ?zhc . FILTER(lang(?zhc)="zh-cn") }
  OPTIONAL { ?item rdfs:label ?zh_ . FILTER(lang(?zh_)="zh") }
  OPTIONAL { ?country rdfs:label ?cfr . FILTER(lang(?cfr)="fr") }
  OPTIONAL { ?country rdfs:label ?czh . FILTER(lang(?czh)="zh-hans") }
  FILTER(BOUND(?fr))
} GROUP BY ?item ?fr
"""


def sparql(query: str) -> list[dict]:
    url = SPARQL + "?" + urllib.parse.urlencode({"query": query, "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.load(r)
    return [{k: v["value"] for k, v in row.items()} for row in data["results"]["bindings"]]


def fetch_places() -> dict[str, dict]:
    """返回 {item_qid: place}，合并三个查询；同 qid 以首都/城市信息为准"""
    places: dict[str, dict] = {}
    for q, kind in ((Q_COUNTRY, "country"), (Q_CITY, "city"), (Q_CAPITAL, "capital")):
        rows = sparql(q)
        common.log(f"[places] {kind}: {len(rows)} 行")
        for r in rows:
            qid = r["item"].rsplit("/", 1)[-1]
            p = places.setdefault(qid, {})
            # 国家信息不与城市冲突；城市/首都重复时首都优先（释义带「首都」）
            if kind == "country":
                p.update({"kind": "country", "fr": r.get("fr"), "zh": pick_zh(r)})
            else:
                p.update({
                    "kind": "capital" if kind == "capital" else p.get("kind", "city"),
                    "fr": r.get("fr"),
                    "zh": pick_zh(r),
                    "pop": parse_int(r.get("pop")),
                    "country_fr": pick_label(r.get("countryFr")),
                    "country_zh": pick_label(r.get("countryZh")),
                })
                if kind == "capital":
                    p["kind"] = "capital"
    return {k: v for k, v in places.items() if v.get("fr") and v.get("zh")}


KIND_RANK = {"capital": 2, "city": 1, "country": 0}


def merge_heads(places: dict[str, dict]) -> dict[str, dict]:
    """同一法语词头可能对应多个实体（东京都 Q1490 / 东京市 Q7473516），合并成一条：
    首都身份优先、中文名取更短的（东京 优于 东京都）、人口取大。"""
    out: dict[str, dict] = {}
    for p in places.values():
        head = (p.get("fr") or "").strip()
        if not head:
            continue
        head = head[0].upper() + head[1:]  # fr label 偶有小写开头（pays de Galles）
        p = {**p, "fr": head}
        cur = out.get(head)
        if cur is None:
            out[head] = p
            continue
        if KIND_RANK[p["kind"]] > KIND_RANK[cur["kind"]]:
            cur["kind"] = p["kind"]
        if len(p.get("zh") or "x" * 99) < len(cur.get("zh") or "x" * 99):
            cur["zh"] = p["zh"]
        if (p.get("pop") or 0) > (cur.get("pop") or 0):
            cur["pop"] = p["pop"]
        for k in ("country_fr", "country_zh"):
            if not cur.get(k) and p.get(k):
                cur[k] = p[k]
    return {h: p for h, p in out.items() if p.get("zh")}


def parse_int(v: str | None) -> int | None:
    """SPARQL 的 SAMPLE(OPTIONAL 变量) 在全空时会返回 blank node（genid），不是数字"""
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def pick_label(v: str | None) -> str | None:
    """SAMPLE(OPTIONAL 变量) 可能返回 blank node 的 genid URI，不是标签"""
    if not v or v.startswith("http://") or v.startswith("https://"):
        return None
    return v.strip() or None


def pick_zh(r: dict) -> str | None:
    for k in ("zhHans", "zhCn", "zh"):
        if s := pick_label(r.get(k)):
            return s
    return None


def load_ipa(words: set[str]) -> dict[str, str]:
    """从 fr.wiktionary 抽取里按词头取 IPA；结果缓存，避免每次重解 700MB gzip"""
    cache = common.RAW / "fr-places-ipa.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    src = common.RAW / "fr-extract.jsonl.gz"
    if not src.exists():
        common.log("[places] 缺少 fr-extract.jsonl.gz，跳过 IPA")
        return {}
    found: dict[str, str] = {}
    with gzip.open(src, "rt", encoding="utf-8") as f:
        for line in f:
            if '"pos": "name"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("lang_code") != "fr":
                continue
            w = (d.get("word") or "").strip()
            if w not in words or w in found:
                continue
            for s in d.get("sounds") or []:
                ipa = (s.get("ipa") or "").strip()
                # fr.wiktionary 的 IPA 用 \...\ 包裹
                if ipa.startswith("\\") and ipa.endswith("\\"):
                    ipa = ipa[1:-1].strip()
                if ipa and not ipa.startswith("{") and "/" not in ipa:
                    found[w] = ipa
                    break
            if len(found) == len(words):
                break
    cache.write_text(json.dumps(found, ensure_ascii=False, indent=0), encoding="utf-8")
    common.log(f"[places] IPA 命中 {len(found)}/{len(words)}")
    return found


def main():
    cache = common.RAW / "fr-places.jsonl"
    if cache.exists():
        raw = [json.loads(line) for line in cache.read_text(encoding="utf-8").splitlines() if line.strip()]
        places = {p["qid"]: p for p in raw}
        common.log(f"[places] 读缓存 {len(places)} 个地名")
    else:
        places = fetch_places()
        for qid, p in places.items():
            p["qid"] = qid
        cache.write_text(
            "\n".join(json.dumps(p, ensure_ascii=False) for p in places.values()), encoding="utf-8"
        )
        common.log(f"[places] 写入缓存 {len(places)} 个地名")

    places = merge_heads(places)
    common.log(f"[places] 合并同词头后 {len(places)} 个地名")

    entries_path = common.WORK / "fr" / "entries.jsonl"
    # 重跑时先摘掉上一轮写入的地名，按最新规则重建（否则旧规则混进的条目永远留着）
    entries = [
        e for e in common.read_jsonl(entries_path)
        if not (e.get("extra", {}).get("source") == "wikidata")
    ]
    existing_heads = {e["headword"].casefold() for e in entries}

    ipa_map = load_ipa({p["fr"] for p in places.values()})

    out = []
    seen: set[str] = set()
    for p in places.values():
        head = p["fr"]
        n = common.norm(head, "fr")
        # 同词头已存在（New York/Le Caire 早就被短语规则收进来）就跳过。
        # 注意只按词头判重、不按 norm：londrès（雪茄）与 Londres（伦敦）同 norm 但
        # 是不同词，精确检索会一并返回，正是词典该有的同形词行为。
        key = head.casefold()
        if not n or key in existing_heads or key in seen:
            continue
        seen.add(key)
        kind, zh = p["kind"], p["zh"]
        if kind != "country" and len(zh) > 2 and zh[-1] in "市都":
            zh = zh[:-1]  # 北京市/东京都 -> 北京/东京（释义里的通名后缀没必要）
        if kind == "country":
            gloss = f"{zh}（国家）"
            freq = 0.5
        else:
            country = p.get("country_zh") or p.get("country_fr")
            if kind == "capital":
                gloss = f"{zh}（{country}首都）" if country else f"{zh}（首都）"
            else:
                gloss = f"{zh}（{country}城市）" if country else f"{zh}（城市）"
            # 人口 -> 0..1（对数），让大城市在模糊检索里靠前
            pop = p.get("pop") or 0
            freq = round(min(0.6, math.log10(max(pop, 1)) / 7.0), 6)
        out.append({
            "headword": head,
            "norm": n,
            "ipa": json.dumps(ipa_map[head], ensure_ascii=False) if head in ipa_map else None,
            "pos": ["n"],
            "gender": None,
            "freq": freq,
            "senses": [{"zh": gloss}],
            "zh_terms": [[zh, 0, "wikidata"]],
            "extra": {"source": "wikidata", "kind": "place"},
        })

    entries.extend(out)
    common.write_jsonl(entries_path, entries)
    common.log(f"[places] 地名 {len(out)} 条，词包共 {len(entries) + len(out)} 条")


if __name__ == "__main__":
    main()
