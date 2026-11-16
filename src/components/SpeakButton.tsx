import { useEffect, useRef, useState } from "react";
import type { Lang } from "../types";
import {
  defaultSpeed, hasShellBridge, installedModels, offlineModelFor, slowRate, speak,
  systemVoiceAvailable, type SpeakHandle, type SpeechSpeed,
} from "../tts/speech";

/// 朗读按钮：点 = 按默认语速读，再点停止；长按 = 慢速读（学习用）。
/// 通道由 speech 控制器决定：壳内端侧引擎（已装该语言模型时）/ 系统 TTS / 浏览器 Web Speech。
/// 系统没语音且无模型时，壳内显示「下载语音」入口（跳设置页），浏览器隐藏
export default function SpeakButton({ text, lang }: { text: string; lang: Lang }) {
  // 播放中记录当前语速（慢速时展示 0.75× 小标）
  const [speaking, setSpeaking] = useState<SpeechSpeed | null>(null);
  // null = 系统没暴露语音清单，无从判断（默认展示）；false = 确认无该语言语音
  const [hasVoice, setHasVoice] = useState<boolean | null>(null);
  const [hasModel, setHasModel] = useState(false);
  const handleRef = useRef<SpeakHandle | null>(null);
  // 长按已触发慢速：随后的 click 事件要吞掉（长按结束必发 click）
  const slowFiredRef = useRef(false);
  const pressTimer = useRef<number | undefined>(undefined);
  // 卸载后异步语速（defaultSpeed/slowRate 首次要拉设置）才返回时，不得再开播
  const aliveRef = useRef(true);
  const inShell = hasShellBridge();

  useEffect(() => {
    let alive = true;
    // 端侧模型只对壳有意义（浏览器无引擎可播）；模型装好后 30s 缓存内即可见
    if (inShell) {
      void installedModels().then((ms) => {
        if (alive) setHasModel(Boolean(offlineModelFor(ms, lang)));
      });
    }
    // 系统 TTS 异步初始化：先查一次，稍后再查一次兜底（首次安装语音包慢时）
    setHasVoice(systemVoiceAvailable(lang));
    const recheck = () => {
      if (systemVoiceAvailable(lang)) alive && setHasVoice(true);
    };
    const t = window.setTimeout(recheck, 800);
    const synth = window.speechSynthesis;
    synth?.addEventListener?.("voiceschanged", recheck);
    return () => {
      alive = false;
      window.clearTimeout(t);
      synth?.removeEventListener?.("voiceschanged", recheck);
    };
  }, [lang, inShell]);

  // 卸载时停止播放；长按计时器与异步 start 请求一并作废
  useEffect(
    () => () => {
      aliveRef.current = false;
      window.clearTimeout(pressTimer.current);
      handleRef.current?.cancel();
    },
    [],
  );

  if (!text) return null;

  // 壳内有模型 → 必显示；否则有/未知系统语音 → 显示；确认都没有 → 壳内给下载入口，浏览器隐藏
  const showDownload = inShell && hasVoice === false && !hasModel;
  if (hasVoice === false && !hasModel && !inShell) return null;

  const start = async (speed: SpeechSpeed, rate?: number) => {
    if (!aliveRef.current) return; // 语速异步返回时组件已卸载：不开播
    const h = speak({ text, lang, speed, rate, provider: "auto" });
    if (!h) return;
    handleRef.current?.cancel();
    handleRef.current = h;
    setSpeaking(speed);
    const state = await h.done;
    if (handleRef.current === h) {
      handleRef.current = null;
      setSpeaking(null);
      if (state === "error") setHasVoice(systemVoiceAvailable(lang));
    }
  };

  const stop = () => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setSpeaking(null);
  };

  const onPointerDown = () => {
    window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => {
      slowFiredRef.current = true;
      // 慢速倍率可调（设置→语音引擎）：异步取缓存值再播，徽标用 handle.rate
      void slowRate().then((r) => { if (aliveRef.current) start("slow", r); });
    }, 450);
  };
  const clearPress = () => window.clearTimeout(pressTimer.current);
  const onClick = () => {
    if (slowFiredRef.current) {
      slowFiredRef.current = false;
      return;
    }
    if (speaking) stop();
    else void defaultSpeed().then((sp) => { if (aliveRef.current) start(sp); });
  };

  // 「下载语音」入口：系统无语音也没装模型，引导去 TTS 引擎页
  if (showDownload) {
    return (
      <button
        onClick={() => { window.location.hash = "#/settings/tts"; }}
        title="系统没有该语言的语音，点此下载端侧语音模型"
        className="inline-flex items-center gap-0.5 p-1.5 -m-1.5 align-middle text-zinc-400 transition-colors hover:text-emerald-600 dark:hover:text-emerald-400"
      >
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
          <path d="M3 9v6h4l5 5V4L7 9H3z" />
          <path d="M16.5 12a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12z" opacity="0.4" />
          <path d="M17 15.6V18h1.5v-2.4H17zM18.75 11.6h1.5v5h-1.5z" />
        </svg>
        <span className="text-[10px] font-medium leading-none">下载</span>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={clearPress}
      onPointerLeave={clearPress}
      onPointerCancel={clearPress}
      onContextMenu={(e) => e.preventDefault()}
      title={speaking ? "停止朗读（长按慢速）" : "朗读发音（长按慢速）"}
      aria-label="朗读发音"
      className={`inline-flex select-none items-center gap-0.5 p-1.5 -m-1.5 align-middle transition-colors ${
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
        <>
          <span className="flex items-end gap-[2px]" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="podic-wave w-[2.5px] rounded-full bg-current"
                style={{ height: 13, animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </span>
          {speaking === "slow" && (
            <span className="text-[10px] font-medium leading-none">{handleRef.current?.rate ?? 0.75}×</span>
          )}
        </>
      )}
    </button>
  );
}
