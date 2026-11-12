// 唯一的 HTTP 出口：所有后端调用都从这里走
import type { ArticleFull, ArticleMeta, Entry, PackInfo, Sentence, SuggestItem, UserDictEntry, WordStatus, LanguageConfig } from "./types";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api${path}`, init);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${resp.status}: ${body || resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) s.set(k, String(v));
  }
  return s.toString();
};

export const listPacks = () => api<{ packs: PackInfo[] }>("/packs");

export const importPack = (file: File) => {
  const form = new FormData();
  form.append("file", file);
  return api<PackInfo>("/packs/import", { method: "POST", body: form });
};

export const removePack = (lang: string) =>
  api<{ ok: boolean }>(`/packs/${lang}`, { method: "DELETE" });

export const lookup = (q: string, langs: string, limit = 20, exact = false) =>
  api<{ items: Entry[] }>(`/lookup?${qs({ q, langs, limit, ...(exact ? { exact: 1 } : {}) })}`).then((r) => r.items);

export const suggest = (q: string, langs: string, limit = 8) =>
  api<{ items: SuggestItem[] }>(`/suggest?${qs({ q, langs, limit })}`).then((r) => r.items);

export const reverse = (q: string, langs: string, limit = 20) =>
  api<{ items: Entry[] }>(`/reverse?${qs({ q, langs, limit })}`).then((r) => r.items);

export const examples = (lang: string, id: number, limit = 5) =>
  api<{ items: Sentence[] }>(`/examples?${qs({ lang, id, limit })}`).then((r) => r.items);

export const attributions = () =>
  api<{ sources: { name: string; url: string; license: string }[] }>("/attributions");

// ---------------- AI 生成内容叠加 ----------------

export type OverlayKind = "explain" | "examples" | "fallback";
export type OverlayEntry = { content: string; created_at: string };

export const getOverlay = (lang: string, headword: string) =>
  api<{ overlays: Record<string, OverlayEntry> }>(
    `/ai/overlay?lang=${encodeURIComponent(lang)}&headword=${encodeURIComponent(headword)}`,
  );

export const saveOverlay = (o: {
  lang: string;
  headword: string;
  kind: OverlayKind;
  content: string;
  model?: string;
}) =>
  api<{ ok: boolean }>("/ai/overlay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(o),
  });

export const deleteOverlay = (lang: string, headword: string, kind: OverlayKind) =>
  api<{ ok: boolean }>(
    `/ai/overlay?lang=${encodeURIComponent(lang)}&headword=${encodeURIComponent(headword)}&kind=${encodeURIComponent(kind)}`,
    { method: "DELETE" },
  );


// ---- 在线更新 ----

export interface PackUpdate {
  lang: string;
  pack_id: string;
  current_version: string;
  latest_version: string;
  /** 版本说明（metainfo 的 notes） */
  notes?: string;
  url: string;
  sha256: string;
  size: number;
  file: string;
}

export const checkUpdates = () => api<{ updates: PackUpdate[] }>("/packs/updates").then((r) => r.updates);

/** 更新源的全量词典清单（含未安装语言）；installed_version 为 null = 未安装 */
export interface CatalogItem {
  lang: string;
  pack_id: string;
  version: string;
  notes?: string;
  entry_count?: number;
  file: string;
  url: string;
  sha256?: string;
  size?: number;
  installed_version?: string | null;
}

export const fetchCatalog = () => api<{ catalog: CatalogItem[] }>("/packs/catalog").then((r) => r.catalog);

/** 测更新源延迟：拉一次 manifest.json，返回耗时毫秒 */
export const speedTest = (baseUrl: string) =>
  api<{ ms: number }>(`/packs/speed-test?url=${encodeURIComponent(baseUrl)}`).then((r) => r.ms);

export interface InstallProgress {
  phase: "download" | "extract" | "verify";
  downloaded: number;
  total: number;
}

// SSE 读取循环（install/ai 两处共用）：按空行切帧、取 data: 行、坏帧忽略；
// onEvent 返回 "stop" 可提前结束
async function readSSE(
  resp: Response,
  onEvent: (ev: Record<string, unknown> & { type: string }) => void | "stop",
): Promise<void> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let ev: Record<string, unknown> & { type: string };
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (onEvent(ev) === "stop") return;
    }
  }
}

export function installPackStream(
  u: { lang: string; url: string; sha256: string },
  onProgress: (p: InstallProgress) => void,
): { done: Promise<PackInfo | null> } {
  const done = (async () => {
    const resp = await fetch("/api/packs/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(u),
    });
    if (!resp.ok || !resp.body) throw new Error(`${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    let pack: PackInfo | null = null;
    await readSSE(resp, (ev) => {
      const e = ev as { type: string; pack?: PackInfo; message?: string; phase?: InstallProgress["phase"]; downloaded?: number; total?: number };
      if (e.type === "progress") onProgress({ phase: e.phase!, downloaded: e.downloaded!, total: e.total! });
      else if (e.type === "done") pack = e.pack ?? null;
      else if (e.type === "error") throw new Error(e.message);
    });
    return pack;
  })();
  return { done };
}

// ---- 设置 ----

export interface ProviderView {
  id: string;
  name: string;
  protocol: "openai" | "anthropic";
  base_url: string;
  models: string[];
  active_model: string;
  labels?: Record<string, string>;
  has_key: boolean;
}

export interface SettingsView {
  providers: ProviderView[];
  manifest_url: string;
  languages?: LanguageConfig[];
  /** 上次停留的页面（tab 记忆的服务端来源；原生壳冷启动换端口后 localStorage 不可靠） */
  last_view?: string | null;
  /** 每日一句按语言存的难度层偏好 */
  daily_sentence?: { levels_by_lang: Record<string, { mode: string; band?: number }> } | null;
}

export const getSettings = () => api<SettingsView>("/settings");

export const saveSettings = (settings: {
  /** 三组字段均可省略：省略 = 后端保留现值（各页面只提交自己改的字段，防跨端覆盖） */
  providers?: (Partial<ProviderView> & { id: string; name: string; protocol: string })[];
  manifest_url?: string;
  languages?: LanguageConfig[];
  last_view?: string;
  daily_sentence?: { levels_by_lang: Record<string, { mode: string; band?: number }> };
}) => api<{ ok: boolean }>("/settings", { method: "POST", body: JSON.stringify(settings), headers: { "Content-Type": "application/json" } });

export const testProvider = (
  provider_id: string,
  model?: string,
  /** 表单草稿：测试用当前输入值，不必先保存（key 掩码/空时后端用已存的） */
  draft?: { protocol?: string; base_url?: string; api_key?: string },
) =>
  api<{ ok: boolean; latency_ms?: number; error?: string }>("/settings/test-provider", {
    method: "POST",
    body: JSON.stringify({ provider_id, model, draft }),
    headers: { "Content-Type": "application/json" },
  });

// ---- 生词本 ----

export interface Favorite {
  id: number;
  lang: string;
  headword: string;
  norm: string;
  snapshot: string | null;
  note: string | null;
  /** 练习熟练度 1生 2模糊 3认识 4熟练（练习首答升降，见 reviewFavorite） */
  mastery: number;
  created_at: string;
}

export const listFavorites = () => api<{ items: Favorite[] }>("/favorites").then((r) => r.items);

export const addFavorite = (f: {
  lang: string;
  headword: string;
  norm: string;
  snapshot?: unknown;
}) => api<{ id: number; created: boolean; mastery: number }>("/favorites", { method: "POST", body: JSON.stringify(f), headers: { "Content-Type": "application/json" } });

export const removeFavorite = (id: number) =>
  api<{ ok: boolean }>(`/favorites/${id}`, { method: "DELETE" });

/** 练习答题判分 + 熟练度更新（first 首答升降级；retry 错词重练只判分）。
 * choice 题用 selected_key（"favorite:<id>"），typed 填词文本，不会则 surrender */
export const reviewFavorite = (id: number, o: {
  session_id: string;
  phase?: "first" | "retry";
  answer:
    | { kind: "choice"; selected_key: string }
    | { kind: "typed"; text: string; /** 用过提示（音标/首字母）：答对判对但不升级 */ hinted?: boolean }
    | { kind: "surrender" };
}) =>
  api<{
    correct: boolean;
    expected_headword: string;
    mastery_before: number;
    mastery_after: number;
    applied: boolean;
    duplicate: boolean;
  }>(`/favorites/${id}/review`, { method: "POST", body: JSON.stringify(o), headers: { "Content-Type": "application/json" } });

// ---- 词汇自测 ----

export interface VocabTestPlan {
  id: string;
  lang: string;
  pack_id: string;
  pack_version: string;
  domain_rule: string;
  domain_label: string;
  population_size: number;
  question_count: number;
  bands: { id: number; population: number; sample_size: number }[];
  items: { id: string; band: number; headword: string; ipa: string | null }[];
}

export interface VocabTestResult {
  estimate: number;
  low: number;
  high: number;
  population_size: number;
  bands: { id: number; population: number; sample_size: number; known: number }[];
  method: string;
}

export interface VocabTestHistoryItem {
  id: string;
  lang: string;
  pack_version: string;
  domain_rule: string;
  population_size: number;
  question_count: number;
  created_at: string;
  finished_at: string;
  result: VocabTestResult | null;
}

/** 生成一次不可变抽样计划（出题）。词典无词频数据时 422 提示不可测 */
export const createVocabTest = (lang: string, question_count: 60 | 120) =>
  api<VocabTestPlan>("/vocab-tests", { method: "POST", body: JSON.stringify({ lang, question_count }), headers: { "Content-Type": "application/json" } });

/** 提交全部答案，服务端按计划计算并保存结果 */
export const finishVocabTest = (id: string, answers: { item_id: string; known: boolean }[]) =>
  api<{ id: string; finished: boolean; result: VocabTestResult }>(`/vocab-tests/${id}/finish`, { method: "POST", body: JSON.stringify({ answers }), headers: { "Content-Type": "application/json" } });

/** 某语言已完成的历史结果 */
export const listVocabTests = (lang: string, limit = 20) =>
  api<{ items: VocabTestHistoryItem[] }>(`/vocab-tests?${qs({ lang, limit })}`).then((r) => r.items);

// ---- 每日一句 ----

export interface DailySentenceResult {
  word: { headword: string; entry_id: number; ipa: string | null };
  /** mode=auto 时 reason 是服务端生成的推荐说明（如「根据上次英语测试推荐…」） */
  level: { mode: "auto" | "manual"; band: number; reason: string; known?: number; sample_size?: number };
  /** 可用层及词数（难度选择控件的数据源） */
  bands: { id: number; count: number }[];
  /** null = 没取到例句（无词典例句且 AI 不可用），原因见 message */
  sentence: { text: string; translation: string[]; source: "pack" | "ai"; cached: boolean; id: number | null } | null;
  message?: string;
}

/** 随机抽词 + 例句（词典例句优先，AI 单句兜底并缓存）；level 省略 = 服务端偏好 */
export const dailySentence = (body: {
  lang: string;
  level?: { mode: "auto" | "manual"; band?: number };
  exclude_headword?: string;
  provider_id?: string;
  model?: string;
}) =>
  api<DailySentenceResult>("/daily-sentence", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

// ---- 阅读：文章 / 用户词典 / 生词标记 ----

/** 抓取网页正文（后端 Readability 提取；SPA 页面会 422 提示手动粘贴） */
export const fetchArticleFromUrl = (url: string) =>
  api<{ title: string; content: string; chars: number }>("/reader/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

/** 对已渲染 HTML 提正文（移动壳原生渲染 SPA 后走这里） */
export const extractFromHtml = (url: string, html: string) =>
  api<{ title: string; content: string; chars: number }>("/reader/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, html }),
  });

export const listArticles = () =>
  api<{ articles: ArticleMeta[] }>("/articles").then((r) => r.articles);

export const getArticle = (id: number) =>
  api<{ article: ArticleFull }>(`/articles/${id}`).then((r) => r.article);

export const createArticle = (lang: string, title: string, content: string) =>
  api<{ article: ArticleFull }>("/articles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang, title, content }),
  }).then((r) => r.article);

/** 编辑已保存文章：换标题/正文，服务端重新切词 */
export const updateArticle = (id: number, lang: string, title: string, content: string) =>
  api<{ article: ArticleFull }>(`/articles/${id}`, {
    method: "PUT",
    body: JSON.stringify({ lang, title, content }),
    headers: { "Content-Type": "application/json" },
  });

export const deleteArticle = (id: number) =>
  api<{ ok: boolean }>(`/articles/${id}`, { method: "DELETE" });

export const listUserDict = (lang?: string, q = "") =>
  api<{ entries: UserDictEntry[] }>(`/user-dict?${qs({ lang, q })}`).then((r) => r.entries);

export const saveUserDict = (o: {
  lang: string;
  headword: string;
  reading?: string;
  pos?: string[];
  senses: unknown[];
  source?: string;
  model?: string;
  /** 点词时的 surface norm（屈折形镜像，供下次直接命中） */
  alt_norm?: string;
  /** 生成该词条的 ai_cache key（done 事件下发），删词条时服务端连带清缓存 */
  cache_key?: string;
}) => api<{ id: number; created: boolean }>("/user-dict", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(o),
});

export const deleteUserDict = (id: number) =>
  api<{ ok: boolean }>(`/user-dict/${id}`, { method: "DELETE" });

/** 全量生词标记 {norm: status}（表小） */
export const getWordStatus = (lang: string) =>
  api<{ statuses: Record<string, WordStatus> }>(`/word-status?lang=${encodeURIComponent(lang)}`).then((r) => r.statuses);

export const setWordStatus = (lang: string, norm: string, status: WordStatus | "none") =>
  api<{ ok: boolean }>("/word-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang, norm, status }),
  });

// ---- AI（SSE 流式） ----

export type AiTask = "explain" | "examples" | "translate" | "fallback" | "complete" | "analyze";

export interface AiRunParams {
  task: AiTask;
  text: string;
  context?: unknown;
  provider_id: string;
  model?: string;
  /** 显式重新生成：绕过服务端缓存 */
  fresh?: boolean;
}

export interface AiStreamHandle {
  cancel: () => void;
  /** 正常结束 resolve，带服务端 done 事件的 cache_key（入库类任务存下来，删词条可连带清缓存）；取消/出错 resolve null */
  done: Promise<string | null>;
}

export function aiRun(
  params: AiRunParams,
  onDelta: (text: string) => void,
): AiStreamHandle {
  const controller = new AbortController();
  let taskId: string | null = null;
  let cacheKey: string | null = null;

  const done = (async () => {
    const resp = await fetch("/api/ai/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);

    await readSSE(resp, (ev) => {
      const e = ev as { type: string; text?: string; message?: string; task_id?: string; cache_key?: string };
      if (e.type === "start") taskId = e.task_id ?? null;
      else if (e.type === "delta") onDelta(e.text ?? "");
      else if (e.type === "error") throw new Error(e.message);
      else if (e.type === "done") cacheKey = e.cache_key ?? null;
      // done 结束本流
      if (e.type === "done") return "stop";
    });
    return cacheKey;
  })();

  return {
    cancel: () => {
      controller.abort();
      if (taskId) {
        fetch("/api/ai/cancel", {
          method: "POST",
          body: JSON.stringify({ task_id: taskId }),
          headers: { "Content-Type": "application/json" },
        }).catch(() => {});
      }
    },
    done,
  };
}
