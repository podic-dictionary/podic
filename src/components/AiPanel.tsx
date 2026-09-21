import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../SettingsContext";
import { useAiStream } from "../hooks/useAiStream";
import { deleteOverlay, getOverlay, saveOverlay, type OverlayEntry } from "../api";
import ConfirmDialog from "./ConfirmDialog";
import ModelPicker from "./ModelPicker";
import Markdown from "./Markdown";
import { TrashIcon } from "./icons";
import type { Entry } from "../types";
import { entrySummary } from "./entrySummary";

/// 复制到剪贴板。iOS WKWebView 里 navigator.clipboard 常缺失或被拒，
/// 统一走「clipboard API → 隐藏 textarea + execCommand」两级兜底
async function copyText(t: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch {
    // 落入 execCommand 兜底
  }
  const ta = document.createElement("textarea");
  ta.value = t;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

const TABS: { id: "explain" | "examples" | "fallback"; label: string; hint: string }[] = [
  { id: "explain", label: "深度讲解", hint: "词义 · 词源 · 辨析 · 搭配" },
  { id: "examples", label: "生成例句", hint: "5 个例句 + 中文翻译" },
  { id: "fallback", label: "补全释义", hint: "词典缺释义时兜底" },
];

function tryParseExamples(text: string): { text: string; zh?: string }[] | null {
  let t = text.trim();
  if (t.startsWith("```")) {
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    t = m ? m[1].trim() : t.replace(/```/g, "");
  }
  try {
    const data: { sentences?: { text: string; zh?: string }[] } = JSON.parse(t);
    if (Array.isArray(data.sentences)) {
      return data.sentences.filter((s) => s && typeof s.text === "string");
    }
  } catch {
    // JSON 不完整（输出被截断等）：抢救其中已完整的句子对象，不整段回退原文
    const saved = [...t.matchAll(/\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"zh"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g)]
      .map((m) => ({ text: JSON.parse(`"${m[1]}"`) as string, zh: JSON.parse(`"${m[2]}"`) as string }));
    if (saved.length > 0) return saved;
  }
  return null;
}

function ExamplesView({ text }: { text: string }) {
  const list = useMemo(() => tryParseExamples(text), [text]);
  if (!list) return <Markdown text={text} />;
  return (
    <ol className="mt-1 space-y-2">
      {list.map((s, i) => (
        <li
          key={i}
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <p className="text-zinc-800 dark:text-zinc-100">{s.text}</p>
          {s.zh && <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">{s.zh}</p>}
        </li>
      ))}
    </ol>
  );
}

export default function AiPanel({ entry }: { entry: Entry }) {
  const { aiChoice, setAiChoice } = useSettings();
  // 折叠态只渲染一行触发条：查词 20 条结果若每张卡都挂载面板，
  // 会各自立刻发 getOverlay，一次查词放大出几十个请求
  const [openPanel, setOpenPanel] = useState(false);
  const [tab, setTab] = useState<"explain" | "examples" | "fallback">("explain");
  const [extra, setExtra] = useState("");
  const { text, running, error, run, cancel, reset, setText } = useAiStream();
  // 已持久化的 AI 产出：lang+headword+kind -> {content, created_at}
  const [overlays, setOverlays] = useState<Record<string, OverlayEntry>>({});
  const [fromCache, setFromCache] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const onCopy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
    }
  };

  const onDelete = () => {
    deleteOverlay(entry.lang, entry.headword, tab)
      .then(() => {
        setOverlays((o) => {
          const next = { ...o };
          delete next[tab];
          return next;
        });
        reset();
        setFromCache(false);
      })
      .catch(() => {});
  };

  // 展开/词条变化：加载已生成的 AI 内容
  useEffect(() => {
    if (!openPanel) return;
    let alive = true;
    setOverlays({});
    setFromCache(false);
    getOverlay(entry.lang, entry.headword)
      .then((r) => {
        if (!alive) return;
        setOverlays(r.overlays ?? {});
        // 默认 tab 有历史产出则直接展示
        if (r.overlays?.explain) {
          setText(r.overlays.explain.content);
          setFromCache(true);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanel, entry.lang, entry.headword]);

  if (!openPanel) {
    return (
      <button
        onClick={() => setOpenPanel(true)}
        className="mt-4 flex w-full items-center gap-2 rounded-xl border border-dashed border-violet-300/80 px-3 py-2.5 text-left text-xs text-violet-600 transition-colors hover:border-violet-400 hover:bg-violet-50/50 dark:border-violet-800 dark:text-violet-400 dark:hover:bg-violet-950/30"
      >
        <span aria-hidden>✦</span> AI 讲解 · 例句 · 兜底
      </button>
    );
  }

  const switchTab = (t: typeof tab) => {
    setTab(t);
    const saved = overlays[t];
    if (saved) {
      setText(saved.content);
      setFromCache(true);
    } else {
      reset();
      setFromCache(false);
    }
  };

  const go = () => {
    if (running) {
      cancel();
      return;
    }
    // 已有生成结果：确认后覆盖重生成（fresh 绕过服务端缓存）
    if (overlays[tab]) {
      setConfirmRegen(true);
      return;
    }
    start();
  };

  const start = () => {
    setFromCache(false);
    run(
      tab,
      extra || entry.headword,
      {
        context: entrySummary(entry),
        provider_id: aiChoice.providerId,
        model: aiChoice.model,
        fresh: true,
      },
      // 生成完成：持久化，叠加到词条上，下次查看直接加载
      (full) => {
        if (!full.trim()) return;
        saveOverlay({
          lang: entry.lang,
          headword: entry.headword,
          kind: tab,
          content: full,
          model: aiChoice.model,
        })
          .then(() =>
            setOverlays((o) => ({
              ...o,
              [tab]: { content: full, created_at: new Date().toISOString() },
            })),
          )
          .catch(() => {});
      },
    );
  };

  return (
    <section className="mt-4 rounded-xl border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-900 dark:bg-violet-950/20">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              title={t.hint}
              aria-pressed={tab === t.id}
              className={`rounded-lg px-2.5 py-2 text-xs transition-colors ${
                tab === t.id
                  ? "bg-violet-600 text-white"
                  : "text-violet-600 hover:bg-violet-100 dark:text-violet-400 dark:hover:bg-violet-950"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <input
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        placeholder={`补充要求（可选，默认针对「${entry.headword}」）`}
        className="mt-2 w-full rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-400 dark:border-zinc-700 dark:bg-zinc-900"
      />

      <div className="action-row mt-2">
        <button
          onClick={go}
          disabled={!aiChoice.providerId}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {running ? "停止" : tab === "fallback" ? "AI 补全" : "生成"}
        </button>
        <ModelPicker
          providerId={aiChoice.providerId}
          model={aiChoice.model}
          onChange={setAiChoice}
        />
        {running && <span className="text-xs text-zinc-400">生成中…</span>}
        {!running && fromCache && overlays[tab] && (
          <span className="text-xs text-violet-500/80 dark:text-violet-400/70" title="AI 生成的结果已保存在本机，再次查看直接加载">
            ✦ 已保存<span className="hidden sm:inline"> {overlays[tab].created_at.slice(0, 10)}</span>
          </span>
        )}
        {!running && text && (
          <button
            onClick={onCopy}
            className={`text-xs transition-colors ${
              copied
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            }`}
          >
            {copied ? "已复制 ✓" : "复制"}
          </button>
        )}
        {!running && overlays[tab] && (
          <button
            onClick={() => setConfirmDelete(true)}
            title="删除这条 AI 生成结果"
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-red-500"
          >
            <TrashIcon size={12} /> 删除
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      {text && (
        <div className="mt-2">
          {tab === "examples" ? <ExamplesView text={text} /> : <Markdown text={text} />}
        </div>
      )}

      <ConfirmDialog
        open={confirmRegen}
        title="重新生成？"
        message={`「${entry.headword}」已有 AI 生成结果，重新生成将覆盖旧内容。`}
        confirmText="重新生成"
        onConfirm={() => {
          setConfirmRegen(false);
          start();
        }}
        onCancel={() => setConfirmRegen(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="删除这条 AI 结果？"
        message={`「${entry.headword}」的${TABS.find((t) => t.id === tab)?.label ?? ""}结果将从本机删除，需要时可重新生成。`}
        confirmText="删除"
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}
