import { useEffect, useRef, useState } from "react";
import type { Lang } from "../types";
import {
  defaultSpeed, hasShellBridge, installedModels, offlineModelFor, onSlowRateChange,
  peekDefaultSpeed, peekSlowRate, slowRate, speak, systemVoiceAvailable,
  type SpeakHandle, type SpeechSpeed,
} from "../tts/speech";

/** 单个朗读按钮（普通/慢速共用）。speaking = 正在播的这一档 */
function SpeakBtn({
  speed, speaking, rate, onClick,
}: {
  speed: SpeechSpeed;
  speaking: boolean;
  /** 慢速实际倍率（标签显示）；普通档无标 */
  rate?: number;
  onClick: (speed: SpeechSpeed) => void;
}) {
  const isSlow = speed === "slow";
  return (
    <button
      onClick={() => onClick(speed)}
      title={
        speaking
          ? `停止${isSlow ? "慢速" : ""}朗读`
          : isSlow
            ? `慢速朗读（当前 ${rate}×，可在 设置→语音引擎 调整）`
            : "按默认语速朗读"
      }
      aria-label={isSlow ? "慢速朗读" : "朗读发音"}
      className={`inline-flex select-none items-center gap-0.5 align-middle transition-colors ${
        isSlow ? "rounded-md px-1 py-0.5" : "p-1.5 -m-1.5"
      } ${
        speaking
          ? isSlow
            ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
            : "text-emerald-600 dark:text-emerald-400"
          : "text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400"
      } ${isSlow && !speaking ? "hover:bg-zinc-100 dark:hover:bg-zinc-800" : ""}`}
    >
      <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
        <path d="M3 9v6h4l5 5V4L7 9H3z" />
        {isSlow ? (
          /* 蜗牛壳旋纹：逐圈放大的四分之一圆弧，与普通喇叭的声波明显区分 */
          speaking ? (
            <path d="M16.2 9.7a3 3 0 1 0 3 4.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          ) : (
            <path
              d="M15.6 12.6a1 1 0 0 1 1-1 1.8 1.8 0 0 1 1.8 1.8 2.6 2.6 0 0 1-2.6 2.6 3.4 3.4 0 0 1-3.4-3.4 4.2 4.2 0 0 1 4.2-4.2 5 5 0 0 1 5 5"
              fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
            />
          )
        ) : (
          speaking ? null : (
            <path d="M16.5 12a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z" />
          )
        )}
      </svg>
      {isSlow && <span className="text-[10px] font-medium leading-none tabular-nums">{rate}×</span>}
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

/// 朗读按钮组：喇叭 = 默认语速（设置里的「默认语速」为慢速时同样生效）；
/// 蜗牛纹喇叭 + 倍率标（如 0.75×）= 慢速。同一按钮播放中再点停止，点另一个
/// 按钮直接切换。通道由 speech 控制器决定：壳内端侧引擎（已装该语言模型时）/
/// 系统 TTS / 浏览器 Web Speech；系统没语音且无模型时壳内显示「下载语音」入口。
/// 慢速倍率标签实时订阅设置变更（设置页保存成功即刷新，不再出现
/// 「设置改了 0.5 按钮还是 0.75」这种无从发现的陈旧缓存）
export default function SpeakButton({ text, lang }: { text: string; lang: Lang }) {
  // 播放中的档位：null = 未播放（与实际语速解耦：普通按钮也可能按设置的默认慢速播）
  const [speaking, setSpeaking] = useState<SpeechSpeed | null>(null);
  // null = 系统没暴露语音清单，无从判断（默认展示）；false = 确认无该语言语音
  const [hasVoice, setHasVoice] = useState<boolean | null>(null);
  const [hasModel, setHasModel] = useState(false);
  // 慢速倍率标签：先取已加载值（无则 0.75 兜底展示），订阅保存变更刷新
  const [rate, setRate] = useState(() => peekSlowRate() ?? 0.75);
  const handleRef = useRef<SpeakHandle | null>(null);
  // 卸载后异步返回不得再开播；StrictMode 会 setup→cleanup→setup 重放，
  // setup 必须复位（否则开发模式一次重放就把按钮永久废掉）
  const aliveRef = useRef(true);
  const inShell = hasShellBridge();

  useEffect(() => {
    aliveRef.current = true;
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
      aliveRef.current = false;
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

  const start = async (speed: SpeechSpeed) => {
    if (!aliveRef.current) return;
    // 语速/倍率先取已加载值，未加载完成才等异步（首挂载极小窗口）；
    // 期间组件卸载/再点由 aliveRef 与 handleRef 校验兜住
    const ds = peekDefaultSpeed() ?? (await defaultSpeed());
    const useSpeed = speed === "normal" ? ds : "slow";
    const useRate = useSpeed === "slow" ? (peekSlowRate() ?? (await slowRate())) : undefined;
    if (!aliveRef.current) return;
    // 先停旧再播新：浏览器路径 synth.cancel() 是全局的，先 speak 后 cancel 会把新句一并杀掉
    handleRef.current?.cancel();
    handleRef.current = null;
    const h = speak({ text, lang, speed: useSpeed, rate: useRate, provider: "auto" });
    if (!h) return;
    handleRef.current = h;
    setSpeaking(speed);
    const state = await h.done;
    if (handleRef.current === h) {
      handleRef.current = null;
      setSpeaking(null);
      if (state === "error") setHasVoice(systemVoiceAvailable(lang));
    }
  };

  const onClick = (speed: SpeechSpeed) => {
    if (speaking === speed) {
      handleRef.current?.cancel();
      handleRef.current = null;
      setSpeaking(null);
    } else {
      void start(speed); // 播放另一档：直接切换（start 内先停旧句）
    }
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
      <SpeakBtn speed="normal" speaking={speaking === "normal"} onClick={onClick} />
      <SpeakBtn speed="slow" speaking={speaking === "slow"} rate={rate} onClick={onClick} />
    </span>
  );
}
