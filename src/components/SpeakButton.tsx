import { useEffect, useState } from "react";
import type { Lang } from "../types";

// TTS locale 映射（常见语言）；未命中回退语言原码，交给合成引擎自行匹配
const LANG_TAGS: Record<string, string> = {
  en: "en-US", fr: "fr-FR", ja: "ja-JP", zh: "zh-CN",
  de: "de-DE", es: "es-ES", pt: "pt-PT", it: "it-IT", ru: "ru-RU",
  ko: "ko-KR", ar: "ar-SA", hi: "hi-IN", th: "th-TH", vi: "vi-VN",
  nl: "nl-NL", pl: "pl-PL", tr: "tr-TR", sv: "sv-SE", uk: "uk-UA",
  el: "el-GR", he: "he-IL", id: "id-ID", ms: "ms-MY", la: "la",
  fa: "fa-IR", hu: "hu-HU", cs: "cs-CZ", da: "da-DK", fi: "fi-FI", no: "nb-NO",
};

/// Android WebView 不支持 Web Speech API：壳内经 PodicAndroid 桥走系统 TTS，
/// 浏览器/HarmonyOS 场景回退 Web Speech。两通道都按「系统有没有该语言语音」隐藏按钮
type NativeTts = {
  ttsAvailable: (lang: string) => boolean;
  ttsSpeak: (text: string, lang: string) => void;
  ttsStop: () => void;
};
const nativeTts = (): NativeTts | null =>
  (window as unknown as { PodicAndroid?: Partial<NativeTts> }).PodicAndroid?.ttsSpeak
    ? ((window as unknown as { PodicAndroid: NativeTts }).PodicAndroid)
    : null;

/// 系统 TTS 朗读按钮（原生桥 / Web Speech）：空闲显示喇叭，播放中显示声波跳动动画
export default function SpeakButton({ text, lang }: { text: string; lang: Lang }) {
  const [speaking, setSpeaking] = useState(false);
  // null = 系统没暴露语音清单，无从判断（默认展示）；false = 确认无该语言语音（隐藏）
  const [hasVoice, setHasVoice] = useState<boolean | null>(null);
  const webSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const native = nativeTts();
  const tag = LANG_TAGS[lang] ?? lang;

  useEffect(() => {
    if (native) {
      // 原生 TTS 异步初始化：先查一次，稍后再查一次兜底（首次安装语音包慢时）
      setHasVoice(native.ttsAvailable(tag));
      const t = setTimeout(() => setHasVoice((v) => v || native.ttsAvailable(tag)), 800);
      return () => clearTimeout(t);
    }
    if (!webSupported) return;
    const synth = window.speechSynthesis;
    const check = () => {
      const voices = synth.getVoices();
      if (voices.length === 0) {
        setHasVoice(null);
        return;
      }
      setHasVoice(voices.some((v) => v.lang.replace("_", "-").toLowerCase().startsWith(tag.toLowerCase())));
    };
    check();
    synth.addEventListener?.("voiceschanged", check);
    return () => {
      synth.removeEventListener?.("voiceschanged", check);
      synth.cancel();
    };
  }, [lang, webSupported, native, tag]);

  // 原生朗读结束：壳侧 dispatch podic:tts-end（QUEUE_FLUSH 打断也会触发）
  useEffect(() => {
    if (!native) return;
    const onEnd = () => setSpeaking(false);
    window.addEventListener("podic:tts-end", onEnd);
    return () => {
      window.removeEventListener("podic:tts-end", onEnd);
      native.ttsStop();
    };
  }, [native]);

  if (!text || hasVoice === false) return null;

  const speak = () => {
    if (speaking) {
      setSpeaking(false);
      if (native) native.ttsStop();
      else window.speechSynthesis?.cancel();
      return;
    }
    if (native) {
      native.ttsSpeak(text, tag);
      setSpeaking(true);
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = tag;
    u.rate = 0.9;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    synth.speak(u);
  };

  return (
    <button
      onClick={speak}
      title={speaking ? "停止朗读" : "朗读发音"}
      className={`inline-flex items-center gap-0.5 p-1.5 -m-1.5 align-middle transition-colors ${
        speaking
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400"
      }`}
    >
      <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
        <path d="M3 9v6h4l5 5V4L7 9H3z" />
        {!speaking && (
          <path d="M16.5 12a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z" />
        )}
      </svg>
      {speaking && (
        <span className="flex items-end gap-[2px]" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="podic-wave w-[2.5px] rounded-full bg-current"
              style={{ height: 13, animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
      )}
    </button>
  );
}
