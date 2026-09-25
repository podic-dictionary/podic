import { useEffect, useRef, useState } from "react";
import { useAiStream } from "../../hooks/useAiStream";
import { useSettings } from "../../SettingsContext";
import BottomSheet from "./BottomSheet";
import Markdown from "../Markdown";
import ModelPicker from "../ModelPicker";
import { copyText } from "../clipboard";
import { CopyIcon } from "../icons";

export default function AnalyzeDrawer({
  open,
  lang,
  text,
  onClose,
}: {
  open: boolean;
  lang: string;
  text: string;
  onClose: () => void;
}) {
  const { aiChoice, setAiChoice } = useSettings();
  const { text: out, running, error, run, cancel } = useAiStream();
  const started = useRef(false);
  const [copied, setCopied] = useState(false);

  // 打开即生成（仅一次）；未配 Provider 时给出引导文案
  useEffect(() => {
    if (!open || started.current) return;
    started.current = true;
    if (aiChoice.providerId) {
      run("analyze", text, {
        context: { lang },
        provider_id: aiChoice.providerId,
        model: aiChoice.model,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onCopy = async () => {
    if (await copyText(out)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="AI 解析">
      <div className="action-row mb-3 flex-wrap">
        <button
          onClick={() =>
            running
              ? cancel()
              : run("analyze", text, { context: { lang }, provider_id: aiChoice.providerId, model: aiChoice.model, fresh: true })
          }
          disabled={!aiChoice.providerId}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {running ? "停止" : out ? "重新生成" : "生成"}
        </button>
        <ModelPicker providerId={aiChoice.providerId} model={aiChoice.model} onChange={setAiChoice} />
        {!running && out && (
          <button
            onClick={onCopy}
            title="复制解析"
            className={`flex items-center gap-1 text-xs transition-colors ${
              copied ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            }`}
          >
            <CopyIcon size={12} />
            <span className="hidden sm:inline">{copied ? "已复制 ✓" : "复制"}</span>
          </button>
        )}
      </div>

      <blockquote className="mb-3 border-l-2 border-zinc-200 pl-3 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        {text}
      </blockquote>

      {error && <p className="mb-2 text-xs text-red-500">{error}</p>}
      {!aiChoice.providerId ? (
        <p className="py-4 text-center text-sm text-zinc-400">先在设置里配置 AI Provider</p>
      ) : (
        <Markdown text={out} />
      )}
    </BottomSheet>
  );
}
