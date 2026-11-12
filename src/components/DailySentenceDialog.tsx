import { useCallback, useEffect, useRef, useState } from "react";
import { dailySentence, getSettings, saveSettings, type DailySentenceResult } from "../api";
import { useSettings } from "../SettingsContext";
import Seg from "./SegmentedControl";
import SpeakButton from "./SpeakButton";
import type { Lang } from "../types";

/** 词频层显示名（与单词量测试结果页一致）；超出四层的层号兜底「层N」 */
const BAND_LABELS = ["最常用", "次常用", "中频", "低频"];
const bandLabel = (id: number) => BAND_LABELS[id] ?? `层${id}`;

/** 每日一句弹层：点「典」印章触发。随机抽词 → 词典例句优先 → AI 单句兜底。
 * 临时 history 条目由 App 管理（返回键关弹层），本组件只管取数与展示 */
export default function DailySentenceDialog({ lang, onClose, onOpenWord }: {
  lang: Lang;
  onClose: () => void;
  onOpenWord: (word: string, lang: string) => void;
}) {
  const { aiChoice, languages } = useSettings();
  const langName = languages.find((l) => l.code === lang)?.name ?? lang;

  const [data, setData] = useState<DailySentenceResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showZh, setShowZh] = useState(false);
  // 难度选择（Seg 的 id："auto" | 层号字符串）；levelsByLang 是服务端整份偏好
  const [levelsByLang, setLevelsByLang] = useState<Record<string, { mode: string; band?: number }>>({});
  // 偏好读取完成前禁用难度选择：迟到的 GET 覆盖刚选的状态（复核 R8 单端竞态）
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  // 偏好保存状态："ok" | "pending" | "error"——pending 不能显示成失败
  const [prefSaveState, setPrefSaveState] = useState<"ok" | "pending" | "error">("ok");
  const reqSeq = useRef(0);
  // 保存串行链：快速换层时按发起顺序落盘，旧请求后到不会覆盖新选择
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());

  // 读按语言存的偏好（GET /api/settings 的 daily_sentence 字段）
  useEffect(() => {
    getSettings()
      .then((s) => {
        setLevelsByLang(s.daily_sentence?.levels_by_lang ?? {});
        setPrefsLoaded(true);
      })
      .catch(() => setPrefsLoaded(true));
  }, []);

  const fetchOne = useCallback(
    async (opts?: { exclude?: string; level?: { mode: "auto" | "manual"; band?: number } }) => {
      const seq = ++reqSeq.current;
      setLoading(true);
      setError("");
      setShowZh(false);
      try {
        // level 显式传入（换层场景），否则读当前偏好
        const pref = opts?.level ?? levelsByLang[lang];
        const r = await dailySentence({
          lang,
          level: pref ? { mode: pref.mode as "auto" | "manual", band: pref.band } : undefined,
          exclude_headword: opts?.exclude,
          provider_id: aiChoice.providerId || undefined,
          model: aiChoice.model || undefined,
        });
        if (reqSeq.current === seq) setData(r);
      } catch (e) {
        if (reqSeq.current === seq) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (reqSeq.current === seq) setLoading(false);
      }
    },
    [lang, levelsByLang, aiChoice.providerId, aiChoice.model],
  );

  useEffect(() => {
    fetchOne();
    // levelsByLang 初值到位前先按无偏好请求；偏好到达后不需要自动重抽（下次换一句才生效）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const pickLevel = (id: string) => {
    const pref = id === "auto" ? { mode: "auto" } : { mode: "manual", band: Number(id) };
    const next = { ...levelsByLang, [lang]: pref };
    setLevelsByLang(next);
    // 换层立刻换词（排除当前词），显式传新偏好——此时 fetchOne 闭包里的
    // levelsByLang 还是旧值（复核 R6）
    fetchOne({ exclude: data?.word.headword, level: pref as { mode: "auto" | "manual"; band?: number } });
    // 保存走串行链：快速连点换层按发起顺序落盘；pending 不显示成失败
    setPrefSaveState("pending");
    saveChain.current = saveChain.current
      .then(() => saveSettings({ daily_sentence: { levels_by_lang: next } }))
      .then(() => setPrefSaveState("ok"))
      .catch(() => setPrefSaveState("error"));
  };

  const bands = data?.bands.filter((b) => b.count > 0) ?? [];
  const segValue = levelsByLang[lang]?.mode === "manual" ? String(levelsByLang[lang]?.band ?? 0) : "auto";
  const word = data?.word;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-950/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="每日一句" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-zinc-200/80 bg-zinc-50 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex h-12 items-center justify-between border-b border-zinc-200/70 px-4 dark:border-zinc-800/70">
          <span className="text-sm font-medium">每日一句</span>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <p className="text-xs text-zinc-400">{langName} · 随机学一句</p>

          {/* 难度层：推荐 + 非空层；单层词典只显示推荐 */}
          {bands.length > 1 && (
            <div>
              <Seg
                value={segValue}
                options={[{ id: "auto", label: "推荐" }, ...bands.map((b) => ({ id: String(b.id), label: bandLabel(b.id) }))]}
                onChange={pickLevel}
                disabled={!prefsLoaded}
              />
              <p className="mt-1.5 text-xs text-zinc-400">
                {loading ? "…" : data?.level.note || data?.level.reason || "按你选的层随机抽词"}
                {prefSaveState === "pending" && <span className="ml-1 text-zinc-400">（保存偏好中…）</span>}
                {prefSaveState === "error" && <span className="ml-1 text-amber-500">（偏好保存失败，本次仍生效）</span>}
              </p>
            </div>
          )}

          {/* 词 + 句子 */}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              正在抽词取句…
            </div>
          ) : error ? (
            <div className="space-y-3 py-6 text-center">
              <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
            </div>
          ) : word ? (
            <>
              <div className="text-center">
                <p className="font-dict text-3xl leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">{word.headword}</p>
                <div className="mt-2 flex items-center justify-center gap-2">
                  {word.ipa && <span className="text-sm text-emerald-700 dark:text-emerald-400">/{word.ipa}/</span>}
                  <SpeakButton text={word.headword} lang={lang} />
                </div>
              </div>
              {data?.sentence ? (
                <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
                  <p className="text-[15px] leading-relaxed text-zinc-800 dark:text-zinc-100">{data.sentence.text}</p>
                  {data.sentence.translation.length > 0 && (
                    showZh ? (
                      <p className="mt-2 border-t border-zinc-100 pt-2 text-sm leading-relaxed text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                        {data.sentence.translation.join("；")}
                      </p>
                    ) : (
                      <button
                        onClick={() => setShowZh(true)}
                        className="mt-2 text-xs text-emerald-600 hover:underline dark:text-emerald-400"
                      >
                        显示译文
                      </button>
                    )
                  )}
                  <p className="mt-2 text-[11px] text-zinc-400">
                    {data.sentence.source === "pack" ? "词典例句" : `AI 生成${data.sentence.cached ? "（缓存）" : ""}`}
                  </p>
                </div>
              ) : (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400">
                  {data?.message ?? "这个词暂无例句。"}
                </p>
              )}
            </>
          ) : null}
        </div>

        {/* 底部动作 */}
        <div className="flex gap-3 border-t border-zinc-200/70 px-4 py-3 dark:border-zinc-800/70">
          <button
            onClick={() => fetchOne({ exclude: word?.headword })}
            disabled={loading}
            className="flex-1 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-600 transition-colors hover:border-emerald-300 hover:text-emerald-600 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
          >
            换一句
          </button>
          <button
            onClick={() => word && onOpenWord(word.headword, lang)}
            disabled={loading || !word}
            className="flex-1 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-500 dark:hover:bg-emerald-600"
          >
            查看单词
          </button>
        </div>
      </div>
    </div>
  );
}
