import { useEffect, useRef, useState } from "react";
import { useSettings } from "../SettingsContext";
import { completeAndSave, isFailedWord } from "../lib/aiComplete";
import ModelPicker from "./ModelPicker";

/** 词形查询（字母/变音字母/撇号/连字符，可含空格的短语）；CJK/数字/URL 不自动走 AI 补词 */
const WORDISH = /^[A-Za-zÀ-ÿ'’-]+( [A-Za-zÀ-ÿ'’-]+)*$/;

/// 查词完全无结果时的 AI 兜底：自动生成结构化词条并存入用户词典（AI 词典），
/// 父级重查后由带「✦ AI 词典」徽标的 EntryCard 接管；删除/覆盖走设置页 AI 词典
export default function FallbackCard({
  query,
  lang,
  onSaved,
}: {
  query: string;
  lang: string;
  /** 入库成功后通知父级重查（EntryCard 替换本卡） */
  onSaved: () => void;
}) {
  const { aiChoice, setAiChoice } = useSettings();
  // idle=未触发 | running=AI 生成中 | failed=坏输出（可手动重试）
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const started = useRef(false); // 防 StrictMode/重渲染双触发

  const q = query.trim();
  const auto = Boolean(aiChoice.providerId) && WORDISH.test(q) && !isFailedWord(lang, q);

  const run = (fresh: boolean) => {
    if (!aiChoice.providerId) return;
    setPhase("running");
    completeAndSave({
      lang,
      text: q,
      altNorm: q, // 服务端会做 norm 归一化再入屈折镜像
      context: { lang, sentence: "" }, // 缓存键参与字段：保持确定性最小
      providerId: aiChoice.providerId,
      model: aiChoice.model,
      fresh,
    })
      .then((r) => {
        if (!r) {
          setPhase("failed");
          return;
        }
        onSaved();
      })
      .catch(() => setPhase("idle"));
  };

  useEffect(() => {
    if (!auto || started.current) return;
    started.current = true;
    run(false); // fresh:false 吃缓存；解析失败的重试才 fresh:true 绕开坏缓存
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, q]);

  return (
    <div className="rounded-2xl border border-dashed border-violet-300 bg-violet-50/40 p-4 dark:border-violet-800 dark:bg-violet-950/20">
      {phase === "running" && (
        <p className="text-sm text-violet-500">词典里没有「{q}」，AI 补全中…</p>
      )}
      {phase === "failed" && (
        <div>
          <p className="text-sm text-zinc-400">AI 返回的结果解析失败</p>
          <div className="action-row mt-2">
            <button
              onClick={() => run(true)}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-700"
            >
              重试
            </button>
            <ModelPicker
              providerId={aiChoice.providerId}
              model={aiChoice.model}
              onChange={setAiChoice}
            />
          </div>
        </div>
      )}
      {phase === "idle" && (
        <>
          <p className="text-sm text-zinc-500">
            词典里没有「{q}」
            {!aiChoice.providerId && "（配置 AI Provider 后可自动补全，记入 AI 词典）"}
          </p>
          {!aiChoice.providerId && (
            <div className="action-row mt-2">
              <ModelPicker
                providerId={aiChoice.providerId}
                model={aiChoice.model}
                onChange={setAiChoice}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
