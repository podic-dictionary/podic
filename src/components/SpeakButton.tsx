import { useEffect, useState } from "react";
import type { Lang } from "../types";

const LANG_TAGS: Record<Lang, string> = { en: "en-US", fr: "fr-FR", ja: "ja-JP" };

/// 系统 TTS 朗读按钮（Web Speech API）：空闲显示喇叭，播放中显示声波跳动动画
export default function SpeakButton({ text, lang }: { text: string; lang: Lang }) {
  const [speaking, setSpeaking] = useState(false);
  // null = 系统没暴露语音清单，无从判断（默认展示）；false = 确认无该语言语音（隐藏）
  const [hasVoice, setHasVoice] = useState<boolean | null>(null);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const check = () => {
      const voices = synth.getVoices();
      if (voices.length === 0) {
        setHasVoice(null);
        return;
      }
      const prefix = (LANG_TAGS[lang] ?? "en-US").slice(0, 2);
      setHasVoice(voices.some((v) => v.lang.replace("_", "-").toLowerCase().startsWith(prefix)));
    };
    check();
    synth.addEventListener?.("voiceschanged", check);
    return () => {
      synth.removeEventListener?.("voiceschanged", check);
      synth.cancel();
    };
  }, [lang, supported]);

  if (!supported || !text || hasVoice === false) return null;

  const speak = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANG_TAGS[lang] ?? "en-US";
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
