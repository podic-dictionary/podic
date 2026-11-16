import { useEffect, useRef, useState } from "react";
import type { Lang } from "../types";
import {
  hasShellBridge, installedModels, offlineModelFor, onSlowRateChange, slowRate, speak,
  systemVoiceAvailable, type SpeakHandle,
} from "../tts/speech";

/// 朗读按钮组：喇叭 = 默认语速；带倍率标的喇叭 = 慢速（跟读学习）。
/// 播放中再点同一按钮停止。通道由 speech 控制器决定：壳内端侧引擎（已装该
/// 语言模型时）/ 系统 TTS / 浏览器 Web Speech；系统没语音且无模型时壳内显示
/// 「下载语音」入口（跳设置页），浏览器隐藏。
/// 慢速按钮的倍率标签实时订阅设置变更（设置页保存成功即刷新，不再出现
/// 「设置改了 0.5 按钮还是 0.75」这种无从发现的陈旧缓存）
export default function SpeakButton({ text, lang }: { text: string; lang: Lang }) {
  // 播放中的按钮：null = 未播放 | "normal" | "slow"
  const [speaking, setSpeaking] = useState<"normal" | "slow" | null>(null);
  // null = 系统没暴露语音清单，无从判断（默认展示）；false = 确认无该语言语音
  const [hasVoice, setHasVoice] = useState<boolean | null>(null);
  const [hasModel, setHasModel] = useState(false);
  // 慢速倍率标签（0.75 兜底展示，slowRate() 到位后刷新；订阅保存变更）
  const [rate, setRate] = useState(0.75);
  const handleRef = useRef<SpeakHandle | null>(null);
  // 卸载后异步语速才返回时，不得再开播
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
    void slowRate().then((r) => {
      if (alive) setRate(r);
    });
    const unsubRate = onSlowRateChange((r) => {
      if (alive) setRate(r);
    });
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
      unsubRate();
      synth?.removeEventListener?.("voiceschanged", recheck);
    };
  }, [lang, inShell]);

  // 卸载时停止播放
  useEffect(
    () => () => {
      aliveRef.current = false;
      handleRef.current?.cancel();
    },
    [],
  );

  if (!text) return null;

  // 壳内有模型 → 必显示；否则有/未知系统语音 → 显示；确认都没有 → 壳内给下载入口，浏览器隐藏
  const showDownload = inShell && hasVoice === false && !hasModel;
  if (hasVoice === false && !hasModel && !inShell) return null;

  const start = async (speed: "normal" | "slow") => {
    if (!aliveRef.current) return;
    // 慢速倍率取当前 state（订阅刷新过），不等待异步——点了就要响
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

  const onClick = (speed: "normal" | "slow") => {
    if (speaking) stop();
    else void start(speed);
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
    <span className="inline-flex items-center align-middle" role="group" aria-label="朗读发音">
      <button
        onClick={() => onClick("normal")}
        title={speaking === "normal" ? "停止朗读" : "按默认语速朗读"}
        aria-label="朗读发音"
        className={`inline-flex select-none items-center p-1.5 -m-1.5 align-middle transition-colors ${
          speaking === "normal"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400"
        }`}
      >
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
          <path d="M3 9v6h4l5 5V4L7 9H3z" />
          {speaking !== "normal" && (
            <path d="M16.5 12a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z" />
          )}
        </svg>
        {speaking === "normal" && (
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
      <button
        onClick={() => onClick("slow")}
        title={speaking === "slow" ? "停止慢速朗读" : `慢速朗读（当前 ${rate}×，可在 设置→语音引擎 调整）`}
        aria-label="慢速朗读"
        className={`inline-flex select-none items-center gap-0.5 rounded-md px-1 py-0.5 align-middle transition-colors ${
          speaking === "slow"
            ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
            : "text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800 dark:hover:text-emerald-400"
        }`}
      >
        {/* 慢速 icon：喇叭 + 蜗牛壳旋纹（与默认喇叭区分；数字倍率直接可见 */}
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
          <path d="M3 9v6h4l5 5V4L7 9H3z" />
          {speaking !== "slow" ? (
            <path d="M15.6 8.2a4.3 4.3 0 1 0 3.4 6.9l-1.1-1a2.8 2.8 0 1 1-.6-4.2l.9-1.3a4.3 4.3 0 0 0-2.6-.9z" />
          ) : (
            <path d="M14.5 7.5a5 5 0 1 0 3.9 8.1l-1.3-1a3.3 3.3 0 1 1-.7-5l1-1.4a5 5 0 0 0-2.9-.7z" />
          )}
        </svg>
        <span className="text-[10px] font-medium leading-none tabular-nums">{rate}×</span>
      </button>
    </span>
  );
}
