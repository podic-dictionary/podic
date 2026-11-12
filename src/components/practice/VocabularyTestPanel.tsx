import { useEffect, useRef, useState } from "react";
import {
  createVocabTest, finishVocabTest, listPacks, listVocabTests,
  type VocabTestHistoryItem, type VocabTestPlan, type VocabTestResult,
} from "../../api";
import { useSettings } from "../../SettingsContext";
import Seg from "../SegmentedControl";
import ConfirmDialog from "../ConfirmDialog";
import SpeakButton from "../SpeakButton";
import { setPracticeActive } from "../../lib/practiceStore";
import type { Lang } from "../../types";

/** 单词量测试：抽样问「认识/不认识」，服务端分层估计认识数（见 vocab_test 模块）。
 * 与生词练习相互独立：不揭晓释义、不写熟练度，避免自报掌握度污染练习数据 */
type Answer = { item_id: string; known: boolean };

export default function VocabularyTestPanel({ onClose }: { onClose: () => void }) {
  const { languages } = useSettings();
  const langName = (code: string) => {
    const l = languages.find((x) => x.code === code);
    return l?.short?.trim() || l?.name || code;
  };

  const [phase, setPhase] = useState<"setup" | "run" | "done">("setup");
  const [packs, setPacks] = useState<{ lang: string; version: string }[]>([]);
  const [lang, setLang] = useState("");
  const [count, setCount] = useState<"60" | "120">("60");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [plan, setPlan] = useState<VocabTestPlan | null>(null);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<VocabTestResult | null>(null);
  const [history, setHistory] = useState<VocabTestHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyReqRef = useRef(0);
  const [exitAsk, setExitAsk] = useState(false);
  // 输入保护期：答完一题后 600ms 内的后续 click（双击/连点）直接忽略——
  // 布尔锁靠 idx effect 解锁挡不住跨事件的快速连点（评审 R14），时间窗与
  // 题目切换解耦，末题提交失败也自然恢复可答（评审 N01）
  const lockUntilRef = useRef(0);
  const langRef = useRef("");

  useEffect(() => {
    listPacks()
      .then((r) => setPacks(r.packs.map((p) => ({ lang: p.lang, version: p.version }))))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    setPracticeActive(phase === "run");
    return () => setPracticeActive(false);
  }, [phase]);

  const start = async () => {
    if (!lang) return;
    setLoading(true);
    setError("");
    try {
      const p = await createVocabTest(lang, Number(count) as 60 | 120);
      setPlan(p);
      setAnswers([]);
      setIdx(0);
      setPhase("run");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const answer = async (known: boolean) => {
    if (!plan || Date.now() < lockUntilRef.current || submitting) return;
    lockUntilRef.current = Date.now() + 600;
    const next = [...answers, { item_id: plan.items[idx].id, known }];
    setAnswers(next);
    if (idx + 1 < plan.items.length) {
      setIdx(idx + 1);
      return;
    }
    // 最后一题：提交全部答案
    setSubmitting(true);
    try {
      const r = await finishVocabTest(plan.id, next);
      setResult(r.result);
      setPhase("done");
    } catch (e) {
      // 提交失败：清保护期让用户立刻重按最后一题（答案仍在，服务端幂等）
      lockUntilRef.current = 0;
      setAnswers(answers);
      setError(e instanceof Error ? `提交未确认：${e.message}` : "提交未确认，请重答最后一题");
    } finally {
      setSubmitting(false);
    }
  };

  const undo = () => {
    if (submitting || answers.length === 0) return;
    // 撤销是明确意图：结束上一题的保护期，纠正后的首次作答不被吞（评审 T01）
    lockUntilRef.current = 0;
    setAnswers(answers.slice(0, -1));
    setIdx(idx - 1);
  };

  const requestClose = () => {
    if (phase !== "run") {
      onClose();
      return;
    }
    setExitAsk(true);
  };

  /** 历史按语言绑定：竞态时旧语言的迟到响应直接丢弃 */
  const openHistory = async (l: string) => {
    const req = ++historyReqRef.current;
    setHistory([]);
    setHistoryLoading(true);
    try {
      const items = await listVocabTests(l);
      if (historyReqRef.current === req && langRef.current === l) setHistory(items);
    } catch {
      if (historyReqRef.current === req && langRef.current === l) setHistory([]);
    } finally {
      if (historyReqRef.current === req) setHistoryLoading(false);
    }
  };

  // ---------------- setup ----------------
  if (phase === "setup") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-zinc-50 dark:bg-zinc-950">
        <PanelHeader title="单词量测试" onClose={requestClose} />
        <div className="mx-auto w-full max-w-xl flex-1 space-y-5 p-4">
          <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            从当前词典抽样一批词，逐个问「认识 / 不认识」，按词频分层估算你大概认识多少词。
            结果只代表本词典范围内的自报认识量，不是标准词汇量考试。
          </p>
          <div className="rounded-xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="eyebrow text-zinc-400">「认识」的判断标准</p>
            <ul className="mt-2 space-y-1 text-zinc-600 dark:text-zinc-300">
              <li>· 看到词后能独立说出至少一个常见意思，才算认识</li>
              <li>· 只眼熟、没把握，都请选「不认识」</li>
              <li>· 答题中不显示释义，答完才给结果</li>
            </ul>
          </div>
          <div>
            <p className="eyebrow text-zinc-400">语言（按已装词典）</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {packs.map((p) => (
                <button
                  key={p.lang}
                  onClick={() => { setLang(p.lang); langRef.current = p.lang; openHistory(p.lang); }}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    lang === p.lang
                      ? "bg-emerald-600 text-white dark:bg-emerald-500"
                      : "border border-zinc-200 text-zinc-500 hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
                  }`}
                >
                  {langName(p.lang)}
                </button>
              ))}
              {packs.length === 0 && <p className="text-sm text-zinc-400">没有已安装的词典</p>}
            </div>
          </div>
          <div>
            <p className="eyebrow text-zinc-400">题量</p>
            <div className="mt-2">
              <Seg value={count} options={[{ id: "60", label: "60 题" }, { id: "120", label: "120 题" }]} onChange={setCount} />
              <p className="mt-1.5 text-xs text-zinc-400">题越多区间越窄；120 题约需 5-8 分钟</p>
            </div>
          </div>
          {error && (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}
          <button
            onClick={start}
            disabled={!lang || loading}
            className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-500 dark:hover:bg-emerald-600"
          >
            {loading ? "正在抽样…" : lang ? `开始自测（${langName(lang)}）` : "先选语言"}
          </button>
          {lang && (historyLoading || history.length > 0) && (
            <div>
              <p className="eyebrow text-zinc-400">历史结果（{langName(lang)}）</p>
              {historyLoading && <p className="mt-2 text-xs text-zinc-400">加载历史…</p>}
              <ul className="mt-2 space-y-1.5">
                {history.slice(0, 5).map((h) => (
                  <li key={h.id} className="flex items-center justify-between rounded-xl bg-white px-3 py-2 text-xs dark:bg-zinc-900">
                    <span className="text-zinc-500 dark:text-zinc-400">{h.created_at.slice(0, 10)}</span>
                    <span className="font-medium">
                      约 {h.result?.estimate.toLocaleString()} 词
                      <span className="ml-1 text-zinc-400">
                        [{h.result?.low.toLocaleString()}–{h.result?.high.toLocaleString()}]
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-zinc-400">词典版本或范围不同时结果不可直接比较</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---------------- run ----------------
  if (phase === "run" && plan) {
    const item = plan.items[idx];
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-zinc-50 dark:bg-zinc-950">
        <PanelHeader
          title="单词量测试"
          onClose={requestClose}
          right={<span className="text-xs text-zinc-400">{answers.length} / {plan.items.length}</span>}
        />
        {/* 单列布局：题面居中偏上，认识/不认识落在页面中下方（验收反馈：别贴死在底栏） */}
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 pb-6">
          <div className="mt-3 h-1.5 shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-800" role="progressbar" aria-valuenow={answers.length} aria-valuemin={0} aria-valuemax={plan.items.length}>
            <div className="h-1.5 rounded-full bg-emerald-600 transition-all dark:bg-emerald-400" style={{ width: `${Math.round((answers.length / plan.items.length) * 100)}%` }} />
          </div>
          <div className="flex flex-1 flex-col items-center justify-center px-2 py-6 text-center">
            <p className="font-dict text-4xl leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">{item.headword}</p>
            <div className="mt-3 flex items-center justify-center gap-2">
              {item.ipa && <span className="text-sm text-emerald-700 dark:text-emerald-400">/{item.ipa}/</span>}
              <SpeakButton text={item.headword} lang={plan.lang as Lang} />
            </div>
            <p className="mt-2 text-sm text-zinc-400">能说出至少一个常见意思才算「认识」</p>
            {answers.length > 0 && (
              <button onClick={undo} className="mt-5 text-xs text-zinc-400 underline-offset-2 hover:text-emerald-600 hover:underline dark:hover:text-emerald-400">
                上一题选错了，改一下
              </button>
            )}
            {error && (
              <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
                {error}
              </p>
            )}
          </div>
          {/* 中下方答题区 */}
          <div className="flex shrink-0 items-center justify-center gap-3 pb-[16vh]">
            <button
              onClick={() => answer(false)}
              disabled={submitting}
              className="w-40 rounded-2xl border border-zinc-300 bg-white px-4 py-4 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-400 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-500"
            >
              不认识 / 没把握
            </button>
            <button
              onClick={() => answer(true)}
              disabled={submitting}
              className="w-40 rounded-2xl bg-emerald-600 px-4 py-4 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-40 dark:bg-emerald-500 dark:hover:bg-emerald-600"
            >
              {submitting ? "计算中…" : "认识"}
            </button>
          </div>
        </div>
        <ConfirmDialog
          open={exitAsk}
          title="放弃本次测试？"
          message="未提交的测试不会生成估计结果。"
          confirmText="放弃"
          onCancel={() => setExitAsk(false)}
          onConfirm={() => {
            setExitAsk(false);
            onClose();
          }}
        />
      </div>
    );
  }

  // ---------------- done ----------------
  if (!result) return null;
  const pct = result.population_size > 0 ? Math.round((result.estimate / result.population_size) * 100) : 0;
  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-zinc-50 dark:bg-zinc-950">
      <PanelHeader title="自测结果" onClose={onClose} />
      <div className="mx-auto w-full max-w-xl flex-1 p-4">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-3xl font-medium">
            约 {result.estimate.toLocaleString()}
            <span className="text-lg text-zinc-400"> 个词头</span>
          </p>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            本次范围 {result.population_size.toLocaleString()} 词 · 约 95% 抽样区间{" "}
            {result.low.toLocaleString()}–{result.high.toLocaleString()}
            {result.estimate > 0 && ` · 认识约 ${pct}%`}
          </p>
          <p className="mt-2 text-xs text-zinc-400">
            自报结果：区间不含自评偏差与词典覆盖偏差，答题数 {(answers.length).toLocaleString()}
          </p>
        </div>
        <div className="mt-4 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="eyebrow text-zinc-400">按词频层的认识比例</p>
          <ul className="mt-3 space-y-2.5">
            {result.bands.filter((b) => b.sample_size > 0).map((b) => {
              const r = b.sample_size > 0 ? Math.round((b.known / b.sample_size) * 100) : 0;
              return (
                <li key={b.id}>
                  <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400">
                    <span>
                      {b.id === 0 ? "最常用" : b.id === 1 ? "次常用" : b.id === 2 ? "中频" : "低频"}段
                      （{b.population.toLocaleString()} 词）
                    </span>
                    <span>
                      认识 {b.known}/{b.sample_size} · {r}%
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div className="h-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400" style={{ width: `${r}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-zinc-400">
            比例骤降的那一段大致就是你的词汇边界——在这段附近收词性价比最高
          </p>
        </div>
        <button
          onClick={onClose}
          className="mt-5 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-600 transition-colors hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
        >
          完成
        </button>
      </div>
    </div>
  );
}

function PanelHeader({ title, onClose, right }: { title: string; onClose: () => void; right?: React.ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200/70 bg-white/80 px-3 backdrop-blur-md dark:border-zinc-800/70 dark:bg-zinc-950/80">
      <button
        onClick={onClose}
        className="flex items-center gap-1 rounded-xl px-2 py-1.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
          <path d="M15 5l-7 7 7 7" />
        </svg>
        返回
      </button>
      <span className="text-sm font-medium">{title}</span>
      <div className="min-w-8 text-right">{right}</div>
    </div>
  );
}
