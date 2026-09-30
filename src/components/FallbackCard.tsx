import { useEffect, useRef, useState } from "react";
import { useSettings } from "../SettingsContext";
import { completeAndSave, isFailedWord } from "../lib/aiComplete";
import ModelPicker from "./ModelPicker";

/** 自动补全资格：按语种的词形判定（Unicode 字母，容忍撇号/连字符与空格短语）。
 * 英/法排除 CJK（含汉字的查询走中文反查，把中文串当英法词形入库是错误契约）；
 * 日语含汉字/假名。œ 等 Latin 扩展字母用 \p{L} 覆盖。 */
const WORDISH_LATIN = /^[\p{L}]+(['’-][\p{L}]+)*( [\p{L}]+(['’-][\p{L}]+)*)*$/u;
const WORDISH_JA = /^[\p{L}ー・]+$/u;
const wordish = (q: string, lang: string) =>
  (lang === "ja" ? WORDISH_JA : WORDISH_LATIN).test(q);

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
  // idle=未触发 | running=AI 生成中 | failed=失败（原因可见，可重试）
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const [errMsg, setErrMsg] = useState("");
  const startedKey = useRef(""); // 按查询键防双触发（StrictMode/依赖变化）
  const qRef = useRef(query); // 过期回调防护：AI 返回时查询已变则只入库、不重查界面

  const q = query.trim();
  qRef.current = q;
  const eligible = wordish(q, lang);
  const blacklisted = isFailedWord(lang, q);
  const auto = Boolean(aiChoice.providerId) && eligible && !blacklisted;

  const run = (fresh: boolean, myQ: string) => {
    if (!aiChoice.providerId) return;
    setPhase("running");
    setErrMsg("");
    completeAndSave({
      lang,
      text: myQ,
      altNorm: myQ, // 服务端会做 norm 归一化再入屈折镜像
      context: { lang, sentence: "" }, // 缓存键参与字段：保持确定性最小
      providerId: aiChoice.providerId,
      model: aiChoice.model,
      fresh,
    })
      .then((r) => {
        if (!r) {
          setErrMsg("AI 返回的结果解析失败");
          setPhase("failed");
          return;
        }
        // 期间查询已切走：词条已入库（下次查直接命中），但不把旧查询拉回界面
        if (qRef.current !== myQ) return;
        onSaved();
      })
      .catch((e) => {
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPhase("failed");
      });
  };

  useEffect(() => {
    const key = `${lang}:${q}`;
    if (!auto || startedKey.current === key) return;
    startedKey.current = key;
    run(false, q); // fresh:false 吃缓存；解析失败的重试才 fresh:true 绕开坏缓存
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, q, auto]);

  const canRetry = Boolean(aiChoice.providerId) && eligible;

  return (
    <div className="rounded-2xl border border-dashed border-violet-300 bg-violet-50/40 p-4 dark:border-violet-800 dark:bg-violet-950/20">
      {phase === "running" && (
        <p className="text-sm text-violet-500">词典里没有「{q}」，AI 补全中…</p>
      )}
      {phase === "failed" && (
        <div>
          <p className="text-sm text-zinc-500">
            {errMsg || `词典里没有「${q}」，AI 补全失败`}
          </p>
          {canRetry && (
            <div className="action-row mt-2">
              <button
                onClick={() => run(true, q)}
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
          )}
        </div>
      )}
      {phase === "idle" && (
        <>
          <p className="text-sm text-zinc-500">
            词典里没有「{q}」
            {!aiChoice.providerId
              ? eligible
                ? "（配置 AI Provider 后可自动补全，记入 AI 词典）"
                : ""
              : !eligible
                ? "（此类查询不适用 AI 补词）"
                : blacklisted
                  ? "（AI 补录失败过，可手动重试）"
                  : ""}
          </p>
          {/* 手动入口：黑名单词重进/自动资格受限时的恢复路径；黑名单只抑制自动，不抑制手动 */}
          {aiChoice.providerId && eligible && (
            <div className="action-row mt-2">
              <button
                onClick={() => run(true, q)}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-700"
              >
                AI 生成释义
              </button>
              <ModelPicker
                providerId={aiChoice.providerId}
                model={aiChoice.model}
                onChange={setAiChoice}
              />
            </div>
          )}
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
