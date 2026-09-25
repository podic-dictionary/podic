// 唯一的 HTTP 出口：所有后端调用都从这里走
import type { ArticleFull, ArticleMeta, Entry, PackInfo, Sentence, SuggestItem, UserDictEntry, WordStatus } from "./types";

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

export const lookup = (q: string, langs: string, limit = 20) =>
  api<{ items: Entry[] }>(`/lookup?${qs({ q, langs, limit })}`).then((r) => r.items);

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
  url: string;
  sha256: string;
  size: number;
  file: string;
}

export const checkUpdates = () => api<{ updates: PackUpdate[] }>("/packs/updates").then((r) => r.updates);

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
}

export const getSettings = () => api<SettingsView>("/settings");

export const saveSettings = (settings: {
  providers: (Partial<ProviderView> & { id: string; name: string; protocol: string })[];
  manifest_url: string;
}) => api<{ ok: boolean }>("/settings", { method: "POST", body: JSON.stringify(settings), headers: { "Content-Type": "application/json" } });

export const testProvider = (provider_id: string, model?: string) =>
  api<{ ok: boolean; latency_ms?: number; error?: string }>("/settings/test-provider", {
    method: "POST",
    body: JSON.stringify({ provider_id, model }),
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
  created_at: string;
}

export const listFavorites = () => api<{ items: Favorite[] }>("/favorites").then((r) => r.items);

export const addFavorite = (f: {
  lang: string;
  headword: string;
  norm: string;
  snapshot?: unknown;
}) => api<{ id: number }>("/favorites", { method: "POST", body: JSON.stringify(f), headers: { "Content-Type": "application/json" } });

export const removeFavorite = (id: number) =>
  api<{ ok: boolean }>(`/favorites/${id}`, { method: "DELETE" });

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
