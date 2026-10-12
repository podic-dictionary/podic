#!/usr/bin/env python3
"""生成 demo/mock.js：内嵌真后端抓取的 API 响应 + fetch 拦截 + SSE 流模拟。
用法: pages-mock-gen.py <响应目录> <输出 mock.js>
"""
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])

def load(name):
    p = src / name
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None  # 错误响应/非 JSON（如缺参数的报错文本）不进 mock

# 词表 → 真实 lookup/suggest 响应（抓包文件名由脚本生成，含转义；这里重新精简键）
def load_pat(prefix):
    """按前缀找抓包文件（URL 转义后的文件名别硬编码）"""
    hits = sorted(src.glob(prefix + "*.json"))
    return json.loads(hits[0].read_text(encoding="utf-8")) if hits else None

LOOKUP = {
    "hello|en": load_pat("get-lookup_q_hello"),
    "bonjour|fr": load_pat("get-lookup_q_bonjour"),
    "食べる|ja": load_pat("get-lookup_q_") if not list(src.glob("*E9*")) else json.loads(list(src.glob("*E9*.json"))[0].read_text(encoding="utf-8")),
    "слово|ru": load_pat("get-lookup_q_") if not list(src.glob("*D1_81*")) else json.loads(list(src.glob("*D1_81*.json"))[0].read_text(encoding="utf-8")),
    "saudade|pt": load_pat("get-lookup_q_saudade_pt"),
}
SETTINGS = load("get-settings.json")
STATIC = {
    "/api/articles": load("get-articles.json"),
    "/api/packs": load("get-packs.json"),
    "/api/favorites": load("get-favorites.json"),
    "/api/attributions": load("get-attributions.json"),
    "/api/user-dict": load("get-user-dict.json"),
    "/api/word-status": load("get-word-status.json"),
}

miss = {"items": [], "user": [], "matched_by": None}
# 抓包 settings 可能含私有部署地址等真实配置，providers 一律替换成无害演示数据；
# languages 固定八语（与 app 默认一致——深链接 lang 参数对未注册语言会被校验回退）
if SETTINGS:
    SETTINGS = {**SETTINGS,
        "languages": [
            {"code": "en", "name": "英语", "short": "英"},
            {"code": "fr", "name": "法语", "short": "法"},
            {"code": "ja", "name": "日语", "short": "日"},
            {"code": "de", "name": "德语", "short": "德"},
            {"code": "es", "name": "西班牙语", "short": "西"},
            {"code": "ru", "name": "俄语", "short": "俄"},
            {"code": "it", "name": "意大利语", "short": "意"},
            {"code": "pt", "name": "葡萄牙语", "short": "葡"},
        ],
        "providers": [
            {"id": "demo-glm", "name": "GLM 演示", "protocol": "anthropic",
             "base_url": "https://open.bigmodel.cn/api/anthropic", "models": ["glm-5.3-flash", "glm-5.3"],
             "active_model": "glm-5.3-flash", "labels": {"glm-5.3-flash": "5.3-flash"}, "has_key": False},
        ]}
data = {
    "LOOKUP": LOOKUP,
    "SETTINGS": SETTINGS,
    "STATIC": STATIC,
}

mock_js = """// podic 官网 demo mock：真前端 + 预置数据（由 scripts/pages-mock-gen.py 生成，勿手改）
// 覆盖 fetch：/api/* 全部本地应答，不发网络请求
const MOCK = %s;
const SUGGEST_POOL = [
  {q:"hello",lang:"en"},{q:"hel",lang:"en"},{q:"hi",lang:"en"},
  {q:"bonjour",lang:"fr"},{q:"bon",lang:"fr"},
  {q:"食べる",lang:"ja"},{q:"たべる",lang:"ja"},
  {q:"слово",lang:"ru"},
];
const AI_FALLBACK_ENTRY = {"headword":"Sehnsucht","ipa":"/ˈzeːnˌzʊxt/","pos":["n."],"lang":"de","zh":["（德）渴望；憧憬——对远方或不可得之物的深切向往"],"senses":[{"pos":"n.","zh":"（德）渴望，憧憬（对远方、往昔或不可得之物的深情向往，近于葡语 saudade）","eg":"Heimweh ist eine Form der Sehnsucht.","eg_zh":"乡愁是渴望的一种形式。"}],"source":"ai"};
function jsonRes(obj, status){
  return new Response(JSON.stringify(obj), {status: status||200, headers:{"Content-Type":"application/json"}});
}
function sseRes(events, chunkDelay){
  // SSE 流模拟：ReadableStream 按块吐 data: 行
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    async pull(ctrl){
      if (i >= events.length) { ctrl.close(); return; }
      const ev = events[i++];
      ctrl.enqueue(enc.encode("data: " + JSON.stringify(ev) + "\\n\\n"));
      await new Promise(r => setTimeout(r, chunkDelay || 60));
    }
  });
  return new Response(stream, {headers:{"Content-Type":"text/event-stream"}});
}
function streamText(text, chunk){
  const parts = [];
  for (let i = 0; i < text.length; i += chunk) parts.push(text.slice(i, i + chunk));
  const events = [{type:"start", task_id:"demo-task"}];
  parts.forEach(p => events.push({type:"delta", text:p}));
  events.push({type:"done", cache_key:"demo-cache"});
  return events;
}
const origFetch = window.fetch;
window.fetch = async function(url, opts){
  let u;
  try { u = new URL(url, location.href); } catch(e) { return origFetch.apply(this, arguments); }
  const path = u.pathname, q = u.searchParams, method = (opts && opts.method) || "GET";

  if (!path.startsWith("/api/")) return origFetch.apply(this, arguments);
  window.__mockLog = window.__mockLog || [];
  window.__mockLog.push(method + " " + path + "?" + u.search.slice(1));

  // ---- 词查询 / 联想 ----
  if (path === "/api/lookup") {
    // 前端参数是 langs（复数，可多语言）；兼容 lang
    const lang = q.get("langs") || q.get("lang") || "en";
    const key = (q.get("q") || "") + "|" + lang;
    const hit = MOCK.LOOKUP[key];
    // saudade 故意 miss：演示 AI 补全路径
    return jsonRes(hit || %s);
  }
  if (path === "/api/suggest") {
    const word = (q.get("q") || "").toLowerCase(), lang = q.get("lang") || "en";
    const pool = SUGGEST_POOL.filter(s => !s.lang || s.lang === lang)
      .filter(s => s.q.toLowerCase().startsWith(word));
    return jsonRes({"items": pool.slice(0, 8).map(s => ({headword: s.q, lang: s.lang}))});
  }
  if (path === "/api/settings") return jsonRes(MOCK.SETTINGS);
  if (path === "/api/settings/test-provider") return jsonRes({"ok": true, "latency_ms": 128});
  if (path === "/api/examples") {
    // 例句：hello 配两条演示，其余词条空（前端 r.items 直接用，不能缺字段）
    const id = q.get("id");
    const hello = MOCK.LOOKUP["hello|en"];
    if (hello && hello.items[0] && String(hello.items[0].entry_id) === id) {
      return jsonRes({items: [
        {id: 1, text: "Hello! How are you today?", translation: ["你好！你今天怎么样？"]},
        {id: 2, text: "She said hello with a warm smile.", translation: ["她带着温暖的微笑打了个招呼。"]},
      ]});
    }
    return jsonRes({items: []});
  }
  if (path === "/api/word-status") return jsonRes({statuses: {}});

  // ---- AI：SSE 流（讲解/例句/翻译/AI 补全） ----
  if (path === "/api/ai/run" && method === "POST") {
    const body = JSON.parse((opts && opts.body) || "{}");
    const t = body.task, text = body.text || "";
    if (t === "translate") {
      // 前端 text 是完整 prompt（含"翻译成…："前缀），按内容特征给真译文
      const zh = text.includes("dictionary") ? "人生就像读一本词典：一词一句，慢慢消化。"
        : text.includes("舟") ? "Words as a boat, crossing the river of languages."
        : "（演示）这是一段流式输出的演示译文，实际效果由你配置的 AI 提供。";
      return sseRes(streamText(zh, 2), 45);
    }
    if (t === "fallback" || t === "complete") {
      // 只演示 Sehnsucht 一个词的 AI 补全；其他 miss 词返回空释义
      // （真实 app 行为：由前端 FallbackCard 引导手动触发），避免错配词条污染词表
      if ((body.text || "").trim() !== "Sehnsucht") {
        return sseRes(streamText(JSON.stringify({headword: body.text || "", senses: []}), 8), 60);
      }
      // 补全完成后写入词表（模拟真 app：AI 词条存 AI 词典，下次查询直接命中）
      const lang = (body.context && body.context.lang) || "de";
      const e = AI_FALLBACK_ENTRY;
      MOCK.LOOKUP[(body.text||"") + "|" + lang] = {
        items: [{entry_id: -1, headword: e.headword, ipa: e.ipa, pos: e.pos, lang: lang,
                 matched_by: "user", freq: 0,
                 senses: e.senses.map(s => ({kind:"def", pos:s.pos, zh:s.zh, eg:s.eg, eg_zh:s.eg_zh}))}],
        user: [], matched_by: "user"
      };
      return sseRes(streamText(JSON.stringify(e), 12), 70);
    }
    if (t === "explain") {
      const out = "「saudade」是葡语中近乎不可译的词：对离去之人或逝去之物的思念，混合着曾经拥有的温存与明知不可复得的怅惘。巴西音乐 saudade 之声（bossa nova）常以它为魂。\\n\\n· 词源：saudar（致敬）的派生，与拉丁语 solitas（孤独）同源\\n· 近义：nostalgia（乡愁）、melancolia（忧郁）、anhelo（渴望）";
      return sseRes(streamText(out, 3), 50);
    }
    if (t === "examples") {
      const out = "1. A saudade é o amor que fica. 思念是留下来的爱。\\n2. Sinto saudade do mar da minha terra. 我怀念故乡的海。";
      return sseRes(streamText(out, 4), 60);
    }
    return sseRes(streamText("（演示）", 3), 60);
  }
  if (path === "/api/ai/cancel") return jsonRes({"ok": true});

  // ---- 写操作：demo 只读，统一打回友好结果 ----
  if (method === "POST" || method === "PUT" || method === "DELETE") {
    return jsonRes({"ok": true, "demo": true});
  }
  if (MOCK.STATIC[path] !== undefined && MOCK.STATIC[path] !== null) return jsonRes(MOCK.STATIC[path]);
  return jsonRes({});
};
// mock 标记（landing 可检测）
window.__podicMock = true;
""" % (json.dumps(data, ensure_ascii=False), json.dumps(miss, ensure_ascii=False))

out.write_text(mock_js, encoding="utf-8")
print(f"mock.js -> {out} ({len(mock_js)//1024}KB)")
