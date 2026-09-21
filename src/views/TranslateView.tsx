import { useState } from "react";
import { useSettings } from "../SettingsContext";
import { useAiStream } from "../hooks/useAiStream";
import ModelPicker from "../components/ModelPicker";
import Markdown from "../components/Markdown";
import type { Lang } from "../types";

const LANGS: { id: "auto" | Lang | "zh"; label: string }[] = [
  { id: "auto", label: "自动" },
  { id: "en", label: "英语" },
  { id: "fr", label: "法语" },
  { id: "ja", label: "日语" },
  { id: "zh", label: "中文" },
];

export default function TranslateView() {
  const { providers, aiChoice, setAiChoice } = useSettings();
  const [from, setFrom] = useState<string>("auto");
  const [to, setTo] = useState<string>("zh");
  const [input, setInput] = useState("");
  const { text, running, error, run, cancel } = useAiStream();

  const provider = providers.find((p) => p.id === aiChoice.providerId);

  const go = () => {
    if (running) {
      cancel();
      return;
    }
    if (!input.trim()) return;
    const hint =
      from === "auto"
        ? `翻译成${LANGS.find((l) => l.id === to)?.label}（自动识别源语言）：\n\n`
        : `把下面的${LANGS.find((l) => l.id === from)?.label}翻译成${LANGS.find((l) => l.id === to)?.label}：\n\n`;
    run("translate", hint + input, { provider_id: aiChoice.providerId, model: aiChoice.model });
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="text-zinc-400">→</span>
        <select
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {LANGS.filter((l) => l.id !== "auto").map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      {/* 输入/译文：手机固定高度让按钮留在首屏，桌面铺满 */}
      <div className="mt-3 grid grid-rows-2 gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-2 lg:grid-rows-1">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
          }}
          placeholder="输入要翻译的文本…（Ctrl+Enter 翻译）"
          className="h-36 w-full resize-none rounded-2xl border border-zinc-200/80 bg-white/80 p-4 text-[15px] outline-none backdrop-blur transition-all duration-300 focus:border-emerald-400/70 focus:bg-white focus:shadow-[0_0_0_4px_rgb(16_185_129/0.08)] lg:h-full dark:border-zinc-700/70 dark:bg-zinc-900/70 dark:focus:bg-zinc-900 dark:focus:shadow-[0_0_0_4px_rgb(16_185_129/0.1)]"
        />
        <div className="h-36 w-full overflow-y-auto rounded-2xl border border-zinc-200/80 bg-white/80 p-4 backdrop-blur lg:h-full dark:border-zinc-700/70 dark:bg-zinc-900/70">
          {error && <p className="text-sm text-red-500">{error}</p>}
          {text ? (
            <Markdown text={text} />
          ) : (
            !running && <p className="text-sm text-zinc-400">译文将显示在这里</p>
          )}
        </div>
      </div>

      {/* 动作行：输入框下方、贴手性侧 */}
      <div className="action-row mt-3">
        <button
          onClick={go}
          disabled={!provider || (!input.trim() && !running)}
          className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {running ? "停止" : "翻译"}
        </button>
        <ModelPicker
          providerId={aiChoice.providerId}
          model={aiChoice.model}
          onChange={setAiChoice}
        />
        {running && <span className="text-xs text-zinc-400">翻译中…</span>}
      </div>
    </div>
  );
}
