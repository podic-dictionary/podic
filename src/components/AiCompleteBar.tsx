import { useRef, useState } from "react";
import { useSettings } from "../SettingsContext";
import { completeAndSave, wordish } from "../lib/aiComplete";
import ModelPicker from "./ModelPicker";

/// 模糊结果上方的 AI 补全入口：查询无精确词条（结果里没有 matched_by=exact/user，
/// 如错拼、未收的屈折形）时由父级渲染，点击对该查询词本身跑 AI 补全并入 AI 词典，
/// 成功后父级重查，由带「✦ AI 词典」徽标的词条接管。与零结果的 FallbackCard 分工：
/// 眼前已有近似结果，不自动触发，由用户决定要不要补。
export default function AiCompleteBar({
  query,
  lang,
  onSaved,
}: {
  query: string;
  lang: string;
  /** 入库成功后通知父级重查（AI 词条替换掉本条的入口语境） */
  onSaved: () => void;
}) {
  const { aiChoice, setAiChoice } = useSettings();
  // idle=待触发 | running=AI 生成中 | failed=失败（原因可见，可重试）
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const [errMsg, setErrMsg] = useState("");
  const inflightKey = useRef(""); // 在途请求的查询键（重复点击不重复发起）
  const qRef = useRef(query); // 过期回调防护：AI 返回时查询已变则只入库、不重查界面
  const q = query.trim();
  qRef.current = q;

  // 未配 Provider / 词形不适用（英/法的中文反查等）：不显示入口
  if (!aiChoice.providerId || !wordish(q, lang)) return null;

  const run = (fresh: boolean) => {
    const key = `${lang}:${q}`;
    if (inflightKey.current === key) return;
    inflightKey.current = key;
    setPhase("running");
    setErrMsg("");
    completeAndSave({
      lang,
      text: q,
      altNorm: q, // 服务端会做 norm 归一化再入屈折镜像
      context: { lang, sentence: "" }, // 缓存键参与字段：保持确定性最小（与 FallbackCard 一致）
      providerId: aiChoice.providerId,
      model: aiChoice.model,
      fresh, // 首次点击吃缓存；解析失败的重试 fresh 绕开坏缓存
    })
      .then((r) => {
        if (inflightKey.current === key) inflightKey.current = "";
        if (!r) {
          setErrMsg("AI 返回的结果解析失败");
          setPhase("failed");
          return;
        }
        // 期间查询已切走：词条已入库（下次查直接命中），但不把旧查询拉回界面
        if (qRef.current !== q) return;
        onSaved();
      })
      .catch((e) => {
        if (inflightKey.current === key) inflightKey.current = "";
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPhase("failed");
      });
  };

  return (
    <div className="rounded-xl border border-dashed border-violet-300 bg-violet-50/40 px-4 py-2.5 dark:border-violet-800 dark:bg-violet-950/20">
      {phase === "running" ? (
        <p className="text-sm text-violet-500 dark:text-violet-400">
          词典里没有「{q}」的精确词条，AI 补全中…
        </p>
      ) : (
        <div className="action-row">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            词典里没有「{q}」的精确词条，以下是近似结果
          </p>
          {phase === "failed" && (
            <p className="text-sm text-red-500 dark:text-red-400">{errMsg || "AI 补全失败"}</p>
          )}
          <button
            onClick={() => run(phase === "failed")}
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-400"
          >
            {phase === "failed" ? "重试" : "AI 补全"}
          </button>
          <ModelPicker
            providerId={aiChoice.providerId}
            model={aiChoice.model}
            onChange={setAiChoice}
          />
        </div>
      )}
    </div>
  );
}
