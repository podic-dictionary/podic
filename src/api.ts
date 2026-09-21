// 唯一的 HTTP 出口：所有后端调用都从这里走
import type { Entry, PackInfo, Sentence, SuggestItem } from "./types";

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

// ---- AI（SSE 流式） ----

export interface AiRunParams {
  task: "explain" | "examples" | "translate" | "fallback";
  text: string;
  context?: unknown;
  provider_id: string;
  model?: string;
  /** 显式重新生成：绕过服务端缓存 */
  fresh?: boolean;
}

export interface AiStreamHandle {
  cancel: () => void;
  done: Promise<void>;
}

export function aiRun(
  params: AiRunParams,
  onDelta: (text: string) => void,
): AiStreamHandle {
  const controller = new AbortController();
  let taskId: string | null = null;

  const done = (async () => {
    const resp = await fetch("/api/ai/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);

    await readSSE(resp, (ev) => {
      const e = ev as { type: string; text?: string; message?: string; task_id?: string };
      if (e.type === "start") taskId = e.task_id ?? null;
      else if (e.type === "delta") onDelta(e.text ?? "");
      else if (e.type === "error") throw new Error(e.message);
      // done 结束本流
      if (e.type === "done") return "stop";
    });
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
