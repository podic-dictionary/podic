// 统一朗读控制器：隐藏 Android 同步桥 / 浏览器 Web Speech 的差异。
// 移动壳统一走 PodicAndroid.ttsRequest(json)（端侧引擎 + 系统 TTS，带速度与
// request_id），浏览器回退 Web Speech。模块级状态：一次只有一个朗读请求，
// 旧请求的迟到事件被 request_id 过滤
import type { Lang } from "../types";
import { getSettings, ttsModels, type TtsInstalled } from "../api";

export type SpeechSpeed = "normal" | "slow";

/// 壳桥协议（Android MainActivity.ttsRequest / iOS podicTts 同构）
type TtsRequest = (json: string) => void;
type LegacyTts = { ttsSpeak: (text: string, lang: string) => void; ttsStop: () => void };
const podicAndroid = (): { ttsRequest?: TtsRequest } & Partial<LegacyTts & { ttsAvailable: (lang: string) => boolean }> | undefined =>
  (window as unknown as { PodicAndroid?: {} }).PodicAndroid;
const bridge = (): TtsRequest | null => podicAndroid()?.ttsRequest ?? null;
/// 旧壳（无 ttsRequest）：同步 ttsSpeak 桥，结束事件无请求区分
const legacyTts = (): LegacyTts | null => {
  const b = podicAndroid();
  return b?.ttsSpeak && b?.ttsStop ? (b as LegacyTts) : null;
};

/// 引擎事件（壳经 evaluateJavascript 派发到 window）
export type TtsEvent = { request_id: string; state: "ended" | "cancelled" | "error"; message?: string };
const listeners = new Set<(e: TtsEvent) => void>();
let wired = false;
function wireEvents() {
  if (wired) return;
  wired = true;
  (window as unknown as { __podicTtsEvent?: (e: TtsEvent) => void }).__podicTtsEvent = (e) => {
    listeners.forEach((l) => l(e));
  };
}

// 已装模型缓存（SpeakButton 高频挂载，30s 内不重复请求）
let modelsCache: { at: number; models: TtsInstalled[] } | null = null;
export async function installedModels(force = false): Promise<TtsInstalled[]> {
  if (!force && modelsCache && Date.now() - modelsCache.at < 30_000) return modelsCache.models;
  try {
    const models = await ttsModels();
    modelsCache = { at: Date.now(), models };
    return models;
  } catch {
    return modelsCache?.models ?? [];
  }
}
export function invalidateModelsCache() {
  modelsCache = null;
}

/// 某语言是否有可用的端侧模型（已装且模型声明支持该语言）
export function offlineModelFor(models: TtsInstalled[], lang: string): TtsInstalled | null {
  return models.find((m) => m.languages.includes(lang)) ?? null;
}

// 会话级默认语速（朗读菜单切换；持久化默认在设置页）
let sessionSpeed: SpeechSpeed | null = null;
export function sessionDefaultSpeed(): SpeechSpeed | null {
  return sessionSpeed;
}
export function setSessionSpeed(s: SpeechSpeed) {
  sessionSpeed = s;
}

// 持久化的默认语速（settings.tts.default_speed）：读一次缓存，设置页保存时更新
let defaultSpeedCache: SpeechSpeed | null = null;
let defaultSpeedLoading: Promise<SpeechSpeed> | null = null;
export function defaultSpeed(): Promise<SpeechSpeed> {
  if (defaultSpeedCache) return Promise.resolve(defaultSpeedCache);
  defaultSpeedLoading ??= getSettings()
    .then((s) => {
      defaultSpeedCache = s.tts?.default_speed === "slow" ? "slow" : "normal";
      return defaultSpeedCache;
    })
    .catch(() => "normal" as SpeechSpeed);
  return defaultSpeedLoading;
}
export function setDefaultSpeedCache(s: SpeechSpeed) {
  defaultSpeedCache = s;
}

let seq = 0;
const resolvers = new Map<string, (s: TtsEvent["state"]) => void>();
function resolveActive(id: string, state: TtsEvent["state"]) {
  const r = resolvers.get(id);
  if (r) {
    resolvers.delete(id);
    r(state);
  }
}

export interface SpeakHandle {
  requestId: string;
  /** 播放结束/取消/出错时 resolve（state 字段区分） */
  done: Promise<TtsEvent["state"]>;
  cancel: () => void;
}

/// 朗读一段文本。provider：auto = 有端侧模型用引擎，否则系统；
/// system = 强制系统 TTS（引擎试听走 speak 的 offline 路径）
export function speak(opts: {
  text: string;
  lang: Lang | string;
  speed: SpeechSpeed;
  provider?: "auto" | "system" | "offline";
}): SpeakHandle | null {
  const requestId = `sp${++seq}`;
  const b = bridge();
  if (b) {
    wireEvents();
    const on = (e: TtsEvent) => {
      if (e.request_id !== requestId) return;
      listeners.delete(on);
      resolveActive(requestId, e.state);
    };
    const done = new Promise<TtsEvent["state"]>((resolve) => {
      resolvers.set(requestId, resolve);
      listeners.add(on);
    });
    // 桥对象在页面 reload 竞态下会变成 non-injected（调用同步抛错），
    // 绝不能让它冒泡——SpeakButton 的 effect 里炸了会白屏
    const call = (json: string): boolean => {
      try {
        b(json);
        return true;
      } catch {
        return false;
      }
    };
    const ok = call(JSON.stringify({
      op: "speak",
      request_id: requestId,
      text: opts.text,
      lang: String(opts.lang),
      speed: opts.speed,
      provider: opts.provider ?? "auto",
    }));
    if (!ok) {
      listeners.delete(on);
      resolvers.delete(requestId);
      return null;
    }
    return {
      requestId,
      done,
      cancel: () => void call(JSON.stringify({ op: "stop", request_id: requestId })),
    };
  }
  // 旧壳：同步 ttsSpeak 桥（无 request 区分；podic:tts-end 即结束，速度由壳固定）
  const legacy = legacyTts();
  if (legacy) {
    wireEvents();
    const done = new Promise<TtsEvent["state"]>((resolve) => {
      const on = () => {
        window.removeEventListener("podic:tts-end", on);
        resolve("ended");
      };
      window.addEventListener("podic:tts-end", on);
    });
    try {
      legacy.ttsSpeak(opts.text, LANG_TAGS[String(opts.lang)] ?? String(opts.lang));
    } catch {
      return null;
    }
    return { requestId, done, cancel: () => { try { legacy.ttsStop(); } catch { /* 壳已失效 */ } } };
  }
  // 浏览器：Web Speech（无 request_id，本地 Promise 近似）
  const synth = window.speechSynthesis;
  if (!synth) return null;
  const tag = LANG_TAGS[String(opts.lang)] ?? String(opts.lang);
  const u = new SpeechSynthesisUtterance(opts.text);
  u.lang = tag;
  u.rate = opts.speed === "slow" ? 0.75 : 1.0;
  const done = new Promise<TtsEvent["state"]>((resolve) => {
    u.onend = () => resolve("ended");
    u.onerror = () => resolve("error");
  });
  synth.cancel();
  synth.speak(u);
  return { requestId, done, cancel: () => synth.cancel() };
}

const LANG_TAGS: Record<string, string> = {
  en: "en-US", fr: "fr-FR", ja: "ja-JP", zh: "zh-CN",
  de: "de-DE", es: "es-ES", pt: "pt-PT", it: "it-IT", ru: "ru-RU",
  ko: "ko-KR", ar: "ar-SA", hi: "hi-IN", th: "th-TH", vi: "vi-VN",
  nl: "nl-NL", pl: "pl-PL", tr: "tr-TR", sv: "sv-SE", uk: "uk-UA",
};

/// 壳是否存在（决定「下载语音」CTA 是否显示：只有壳内能用端侧引擎）
export function hasShellBridge(): boolean {
  return bridge() !== null || legacyTts() !== null;
}

/// 请求壳卸载端侧引擎并释放使用引用（删除模型前调，避免后端 409）
export function unloadEngine() {
  bridge()?.(JSON.stringify({ op: "unload" }));
}

/// 系统 TTS 有没有该语言的语音（null = 无法判断）。壳走 ttsAvailable，
/// 浏览器走 Web Speech 的 voice 清单
export function systemVoiceAvailable(lang: string): boolean | null {
  const tag = LANG_TAGS[lang] ?? lang;
  const avail = podicAndroid()?.ttsAvailable;
  if (avail) {
    // reload 竞态下桥对象失效会同步抛错（non-injected）：吞掉当未知处理
    try {
      return avail(tag);
    } catch {
      return null;
    }
  }
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return null;
  const voices = synth.getVoices();
  if (voices.length === 0) return null;
  return voices.some((v) => v.lang.replace("_", "-").toLowerCase().startsWith(tag.toLowerCase()));
}
