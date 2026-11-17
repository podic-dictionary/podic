// 统一朗读控制器：隐藏 Android 同步桥 / 浏览器 Web Speech 的差异。
// 移动壳统一走 PodicAndroid.ttsRequest(json)（端侧引擎 + 系统 TTS，带速度与
// request_id），浏览器回退 Web Speech。模块级状态：一次只有一个朗读请求，
// 旧请求的迟到事件被 request_id 过滤
import type { Lang } from "../types";
import { getSettings, ttsModels, type TtsInstalled } from "../api";
import { makeSettingCache } from "../lib/settingCache";

export type SpeechSpeed = "normal" | "slow";

/// 壳桥对象（Android MainActivity 注入的 PodicAndroid）。
/// 注意：@JavascriptInterface 方法必须以对象方法形式调用（p.ttsRequest(...)），
/// 把函数拆下来单独调用会被 Chromium JavaBridge 判为 "non-injected object"
/// 同步抛错——曾导致查词页白屏（SpeakButton effect 里未捕获）
type Bridge = {
  ttsRequest?: (json: string) => void;
  ttsSpeak?: (text: string, lang: string) => void;
  ttsStop?: () => void;
  ttsAvailable?: (lang: string) => boolean;
};
const podicAndroid = (): Bridge | undefined =>
  (window as unknown as { PodicAndroid?: Bridge }).PodicAndroid;

/// 方法式调用桥方法；不存在或抛错（reload 竞态下桥失效）返回 undefined
function callBridge<T>(method: keyof Bridge, ...args: unknown[]): T | undefined {
  const p = podicAndroid();
  const fn = p?.[method];
  if (typeof fn !== "function") return undefined;
  try {
    return (p as Record<string, (...a: unknown[]) => T>)[method](...args);
  } catch {
    return undefined;
  }
}

/// 同 callBridge，但返回是否调用成功（void 方法用）
function tryBridge(method: keyof Bridge, ...args: unknown[]): boolean {
  const p = podicAndroid();
  const fn = p?.[method];
  if (typeof fn !== "function") return false;
  try {
    (p as Record<string, (...a: unknown[]) => unknown>)[method](...args);
    return true;
  } catch {
    return false;
  }
}

const hasTtsRequest = (): boolean => typeof podicAndroid()?.ttsRequest === "function";

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

// 持久化的默认语速（settings.tts.default_speed）：settingCache（版本守卫+广播）
const defaultSpeedCache = makeSettingCache<SpeechSpeed>(async () => {
  const s = await getSettings();
  return s.tts?.default_speed === "slow" ? "slow" : "normal";
}, "normal");
export function defaultSpeed(): Promise<SpeechSpeed> {
  return defaultSpeedCache.get();
}
/** 默认语速的已加载值（未加载完成时 null）——朗读点击即用时避免异步空窗 */
export function peekDefaultSpeed(): SpeechSpeed | null {
  return defaultSpeedCache.peek();
}
export function setDefaultSpeedCache(s: SpeechSpeed) {
  defaultSpeedCache.set(s);
}

// 持久化的慢速倍率（settings.tts.slow_rate，0.2~0.9）：settingCache（版本守卫+广播）。
// 慢速按钮的倍率标签订阅变更实时刷新，配置错了自己就能看出来
const slowRateCache = makeSettingCache<number>(async () => {
  const s = await getSettings();
  const r = s.tts?.slow_rate;
  return typeof r === "number" && r >= 0.2 && r <= 0.9 ? r : 0.75;
}, 0.75);
export function slowRate(): Promise<number> {
  return slowRateCache.get();
}
/** 慢速倍率的已加载值（未加载完成时 null）——慢速按钮点击即用时避免异步空窗 */
export function peekSlowRate(): number | null {
  return slowRateCache.peek();
}
export function setSlowRateCache(r: number) {
  slowRateCache.set(r);
}
/** 订阅慢速倍率变化（设置页保存成功时触发）；返回取消函数 */
export function onSlowRateChange(l: (r: number) => void): () => void {
  return slowRateCache.subscribe(l);
}

// 按语言引擎偏好（settings.tts.languages[lang].provider）：auto = 模型优先、
// 没装回系统；system = 强制系统 TTS（系统语音更好听时的选择）。SpeakButton
// 挂载即预热，设置页保存成功即 set，speak 时 peek 即时生效
export type TtsLangPrefs = Record<string, { provider: string }>;
const langPrefsCache = makeSettingCache<TtsLangPrefs>(async () => {
  const s = await getSettings();
  return s.tts?.languages ?? {};
}, {});
/** 预热/等待加载（SpeakButton effect 调，让首次点击前就有值） */
export function ensureLangPrefs(): Promise<TtsLangPrefs> {
  return langPrefsCache.get();
}
export function setLangPrefsCache(prefs: TtsLangPrefs) {
  langPrefsCache.set(prefs);
}
function resolveProvider(lang: string | Lang, provider?: string): string {
  if (provider !== "auto") return provider ?? "auto";
  return langPrefsCache.peek()?.[String(lang)]?.provider === "system" ? "system" : "auto";
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
  /** 本次实际倍速（慢速徽标显示用） */
  rate?: number;
}

/// 朗读一段文本。provider：auto = 有端侧模型用引擎，否则系统；
/// system = 强制系统 TTS（引擎试听走 speak 的 offline 路径）
export function speak(opts: {
  text: string;
  lang: Lang | string;
  speed: SpeechSpeed;
  provider?: "auto" | "system" | "offline";
  /** 慢速倍率（settings.tts.slow_rate）；缺省 0.75。调用方经 slowRate() 取后传入 */
  rate?: number;
}): SpeakHandle | null {
  const requestId = `sp${++seq}`;
  if (hasTtsRequest()) {
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
    const send = (op: string): boolean =>
      tryBridge("ttsRequest", JSON.stringify({ op, request_id: requestId, ...payload }));
    const rate = opts.speed === "slow" ? (opts.rate ?? 0.75) : 1.0;
    const payload = {
      text: opts.text,
      lang: String(opts.lang),
      speed: opts.speed,
      rate,
      provider: resolveProvider(opts.lang, opts.provider),
    };
    if (!send("speak")) {
      listeners.delete(on);
      resolvers.delete(requestId);
      return null;
    }
    return {
      requestId,
      done,
      cancel: () => void send("stop"),
      rate,
    };
  }
  // 旧壳：同步 ttsSpeak 桥（无 request 区分；podic:tts-end 即结束，速度由壳固定）
  const legacy = podicAndroid();
  if (typeof legacy?.ttsSpeak === "function") {
    wireEvents();
    const done = new Promise<TtsEvent["state"]>((resolve) => {
      const on = () => {
        window.removeEventListener("podic:tts-end", on);
        resolve("ended");
      };
      window.addEventListener("podic:tts-end", on);
    });
    if (!tryBridge("ttsSpeak", opts.text, LANG_TAGS[String(opts.lang)] ?? String(opts.lang))) {
      return null;
    }
    return { requestId, done, cancel: () => void tryBridge("ttsStop") };
  }
  // 浏览器：Web Speech（无 request_id，本地 Promise 近似）
  const synth = window.speechSynthesis;
  if (!synth) return null;
  const tag = LANG_TAGS[String(opts.lang)] ?? String(opts.lang);
  const u = new SpeechSynthesisUtterance(opts.text);
  u.lang = tag;
  u.rate = opts.speed === "slow" ? (opts.rate ?? 0.75) : 1.0;
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
  const p = podicAndroid();
  return typeof p?.ttsRequest === "function" || typeof p?.ttsSpeak === "function";
}

/// 请求壳卸载端侧引擎并释放使用引用（删除模型前调，避免后端 409）
export function unloadEngine() {
  void callBridge("ttsRequest", JSON.stringify({ op: "unload" }));
}

/// 系统 TTS 有没有该语言的语音（null = 无法判断）。壳走 ttsAvailable，
/// 浏览器走 Web Speech 的 voice 清单
export function systemVoiceAvailable(lang: string): boolean | null {
  const tag = LANG_TAGS[lang] ?? lang;
  if (typeof podicAndroid()?.ttsAvailable === "function") {
    return callBridge<boolean>("ttsAvailable", tag) ?? null;
  }
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return null;
  const voices = synth.getVoices();
  if (voices.length === 0) return null;
  return voices.some((v) => v.lang.replace("_", "-").toLowerCase().startsWith(tag.toLowerCase()));
}
