import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../SettingsContext";
import { useAiStream } from "../hooks/useAiStream";
import ModelPicker from "../components/ModelPicker";
import Markdown from "../components/Markdown";
import { copyText } from "../components/clipboard";



export default function TranslateView() {
  const { providers, aiChoice, setAiChoice, languages } = useSettings();
  // 翻译语言 = auto + 注册语言 ∪ zh（中文是默认目标语，即使未注册也保留）；源含 auto、目标不含
  const langs = useMemo(() => {
    const seen = new Set<string>();
    const reg = languages.filter((l) => {
      if (seen.has(l.code) || l.code === "zh") return false;
      seen.add(l.code);
      return true;
    });
    const zh = [{ id: "zh", label: "中文" }];
    return [
      { id: "auto", label: "自动" },
      ...reg.map((l) => ({ id: l.code, label: l.name })),
      ...zh,
    ];
  }, [languages]);
  const langLabel = (code: string) => langs.find((l) => l.id === code)?.label ?? code;
  const [from, setFrom] = useState<string>("auto");
  const [to, setTo] = useState<string>("zh");
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null); // 反馈复位定时器：连点时旧定时器不提前清掉新反馈
  const { text, running, error, run, cancel } = useAiStream();

  // 新译文开始流式输出时清掉上一份译文的「已复制」残留
  useEffect(() => {
    if (running) setCopied(false);
    return () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, [running]);

  const provider = providers.find((p) => p.id === aiChoice.providerId);

  const go = () => {
    if (running) {
      cancel();
      return;
    }
    if (!input.trim()) return;
    const hint =
      from === "auto"
        ? `翻译成${langLabel(to)}（自动识别源语言）：\n\n`
        : `把下面的${langLabel(from)}翻译成${langLabel(to)}：\n\n`;
    run("translate", hint + input, { provider_id: aiChoice.providerId, model: aiChoice.model });
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-4">
      <div className="flex flex-wrap items-center justify-center gap-3">
        <select
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="min-w-28 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-center text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {langs.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="text-zinc-400">→</span>
        <select
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="min-w-28 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-center text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {langs.filter((l) => l.id !== "auto").map((l) => (
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
        <div className="flex h-36 w-full flex-col rounded-2xl border border-zinc-200/80 bg-white/80 backdrop-blur lg:h-full dark:border-zinc-700/70 dark:bg-zinc-900/70">
          {/* 工具行：复制按钮固定在顶部，不遮正文、不随滚动走 */}
          <div className="flex h-8 shrink-0 items-center justify-end px-3">
            {text && !running && (
              <button
                onClick={async () => {
                  if (await copyText(text)) {
                    setCopied(true);
                    if (copyTimer.current) window.clearTimeout(copyTimer.current);
                    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
                  }
                }}
                className="rounded-lg border border-zinc-200/80 bg-white/90 px-2.5 py-1 text-xs text-zinc-500 backdrop-blur hover:text-emerald-600 dark:border-zinc-700/70 dark:bg-zinc-900/90 dark:text-zinc-400 dark:hover:text-emerald-400"
              >
                {copied ? "已复制 ✓" : "复制"}
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {error && <p className="text-sm text-red-500">{error}</p>}
            {text ? (
              <Markdown text={text} />
            ) : (
              !running && <p className="text-sm text-zinc-400">译文将显示在这里</p>
            )}
          </div>
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
