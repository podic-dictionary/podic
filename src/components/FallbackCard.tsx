import { useEffect, useState } from "react";
import { getOverlay, saveOverlay } from "../api";
import { useSettings } from "../SettingsContext";
import { useAiStream } from "../hooks/useAiStream";
import ConfirmDialog from "./ConfirmDialog";
import ModelPicker from "./ModelPicker";
import Markdown from "./Markdown";

/// 查词无结果（或结果过稀）时的 AI 兜底卡片；生成结果持久化，再次查看直接加载
export default function FallbackCard({ query, lang }: { query: string; lang: string }) {
  const { aiChoice, setAiChoice } = useSettings();
  const { text, running, error, run, cancel, setText } = useAiStream();
  const [hasSaved, setHasSaved] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);

  // 词条变化：有历史产出直接展示
  useEffect(() => {
    let alive = true;
    setHasSaved(false);
    getOverlay(lang, query)
      .then((r) => {
        if (alive && r.overlays?.fallback) {
          setText(r.overlays.fallback.content);
          setHasSaved(true);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, query]);

  const go = () => {
    if (running) {
      cancel();
      return;
    }
    // 已有生成结果：确认后覆盖重生成
    if (hasSaved) {
      setConfirmRegen(true);
      return;
    }
    start();
  };

  const start = () => {
    setHasSaved(false);
    run(
      "fallback",
      query,
      {
        context: { lang, headword: query },
        provider_id: aiChoice.providerId,
        model: aiChoice.model,
        fresh: true,
      },
      (full) => {
        if (!full.trim()) return;
        saveOverlay({
          lang,
          headword: query,
          kind: "fallback",
          content: full,
          model: aiChoice.model,
        })
          .then(() => setHasSaved(true))
          .catch(() => {});
      },
    );
  };

  return (
    <div className="rounded-2xl border border-dashed border-violet-300 bg-violet-50/40 p-4 dark:border-violet-800 dark:bg-violet-950/20">
      <p className="text-sm text-zinc-500">
        词典里没有「{query}」，可以让 AI 补一个释义（标注为 AI 生成，不入库）
      </p>
      <div className="action-row mt-2">
        <button
          onClick={go}
          disabled={!aiChoice.providerId}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {running ? "停止" : "AI 生成释义"}
        </button>
        <ModelPicker
          providerId={aiChoice.providerId}
          model={aiChoice.model}
          onChange={setAiChoice}
        />
        {running && <span className="text-xs text-zinc-400">生成中…</span>}
      </div>
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      {text && (
        <div className="mt-2">
          <Markdown text={text} />
        </div>
      )}

      <ConfirmDialog
        open={confirmRegen}
        title="重新生成？"
        message={`「${query}」已有 AI 生成结果，重新生成将覆盖旧内容。`}
        confirmText="重新生成"
        onConfirm={() => {
          setConfirmRegen(false);
          start();
        }}
        onCancel={() => setConfirmRegen(false)}
      />
    </div>
  );
}
