import { useEffect, useMemo, useRef, useState } from "react";
import { reviewFavorite, type Favorite } from "../../api";
import { useSettings } from "../../SettingsContext";
import Seg from "../SegmentedControl";
import ConfirmDialog from "../ConfirmDialog";
import SpeakButton from "../SpeakButton";
import {
  buildQuestions, MASTERY_LABELS, MODE_LABELS, newSessionId, pickWords,
  type PracticeMode, type PracticeQuestion,
} from "../../lib/practice";
import { setPracticeActive } from "../../lib/practiceStore";
import type { Lang } from "../../types";

/** 判分接口返回（首答升降级；retry 只判分） */
type Outcome = {
  correct: boolean;
  expected_headword: string;
  mastery_before: number;
  mastery_after: number;
  applied: boolean;
  duplicate: boolean;
};

/** 结束页每词明细 */
type WordResult = {
  q: PracticeQuestion;
  firstCorrect: boolean;
  retryCorrect: boolean | null; // null = 首轮就对，没进重练
  before: number;
  after: number;
};

const COUNT_OPTS: { id: "10" | "20"; label: string }[] = [
  { id: "10", label: "10 词" },
  { id: "20", label: "20 词" },
];

const MODE_ORDER: PracticeMode[] = ["word_meaning", "meaning_word", "meaning_type", "audio_meaning"];

export default function PracticePanel({
  items,
  defaultLang,
  onLevelChange,
  onClose,
}: {
  items: Favorite[];
  /** 进入时的语言筛选（"all" 时由用户在面板里选） */
  defaultLang: string;
  onLevelChange: (id: number, mastery: number) => void;
  onClose: () => void;
}) {
  const { languages } = useSettings();
  const langName = (code: string) => {
    const l = languages.find((x) => x.code === code);
    return l?.short?.trim() || l?.name || code;
  };

  const [phase, setPhase] = useState<"setup" | "run" | "done">("setup");
  // 会话内快照：出题后不跟随列表刷新，避免答题中途题目被偷换
  const [lang, setLang] = useState(defaultLang === "all" ? "" : defaultLang);
  const [count, setCount] = useState<"10" | "20">("10");
  const [modes, setModes] = useState<PracticeMode[]>(["word_meaning", "meaning_word", "meaning_type"]);
  const [preparing, setPreparing] = useState(false);
  const [prepMsg, setPrepMsg] = useState("");

  const [queue, setQueue] = useState<PracticeQuestion[]>([]);
  const [retryQueue, setRetryQueue] = useState<PracticeQuestion[]>([]);
  const [round, setRound] = useState<"first" | "retry">("first"); // 显式轮次：不再用 results.length 推断（末题反馈页会误判）
  const [retryTotal, setRetryTotal] = useState(0); // 转入重练那一刻的错词总数（之后错词进 queue，retryQueue 只剩未答的）
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState<PracticeQuestion | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [feedback, setFeedback] = useState<Outcome | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [results, setResults] = useState<WordResult[]>([]);
  const [exitAsk, setExitAsk] = useState(false);
  const sessionId = useRef(newSessionId());

  const langs = useMemo(() => [...new Set(items.map((i) => i.lang))], [items]);
  const langCount = useMemo(() => (lang ? items.filter((i) => i.lang === lang).length : 0), [items, lang]);

  // 会话进行中标记：App 返回键据此弹「结束练习」确认
  useEffect(() => {
    setPracticeActive(phase === "run");
    return () => setPracticeActive(false);
  }, [phase]);

  const stats = useMemo(
    () => ({
      answered: results.length,
      correct: results.filter((r) => r.firstCorrect).length,
      retryDone: results.filter((r) => r.retryCorrect !== null).length,
      retryCorrect: results.filter((r) => r.retryCorrect === true).length,
      up: results.filter((r) => r.after > r.before).length,
      down: results.filter((r) => r.after < r.before).length,
    }),
    [results],
  );

  const start = async () => {
    if (!lang || modes.length === 0) return;
    setPreparing(true);
    setPrepMsg("");
    try {
      const picked = pickWords(items, lang, Number(count));
      const built = await buildQuestions(picked, modes, lang);
      if (built.questions.length === 0) {
        setPrepMsg(
          built.skipped.length > 0
            ? `没能出题：${built.skipped.map((s) => `${s.headword}（${s.reason}）`).join("、")}`
            : "没能出题：词太少，先多收藏几个生词",
        );
        return;
      }
      sessionId.current = newSessionId();
      setResults([]);
      setRetryQueue([]);
      setRound("first");
      setRetryTotal(0);
      setTotal(built.questions.length);
      setCurrent(built.questions[0]);
      setQueue(built.questions.slice(1));
      setFeedback(null);
      setSelected(null);
      setTyped("");
      setSubmitError("");
      setPhase("run");
    } catch (e) {
      setPrepMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setPreparing(false);
    }
  };

  const toggleMode = (m: PracticeMode) =>
    setModes((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  const nextQuestion = () => {
    setFeedback(null);
    setSelected(null);
    setTyped("");
    setSubmitError("");
    if (queue.length > 0) {
      setCurrent(queue[0]);
      setQueue(queue.slice(1));
      return;
    }
    if (retryQueue.length > 0) {
      // 重练轮：选择题重排选项；重练只判分不动等级
      const reshuffled = retryQueue.map((q) =>
        q.options ? { ...q, options: [...q.options].sort(() => Math.random() - 0.5) } : q,
      );
      setRound("retry");
      setRetryTotal(retryQueue.length);
      setCurrent(reshuffled[0]);
      setQueue(reshuffled.slice(1));
      setRetryQueue([]);
      return;
    }
    setPhase("done");
  };

  /** 提交答案。重练轮判定 = 首轮已答满；提交失败留在本题可重试 */
  const submit = async (answer: { kind: "choice"; selected_key: string } | { kind: "typed"; text: string } | { kind: "surrender" }) => {
    if (!current || submitting || feedback) return;
    setSubmitting(true);
    setSubmitError("");
    const isRetry = round === "retry";
    try {
      const o = await reviewFavorite(current.favId, {
        session_id: sessionId.current,
        phase: isRetry ? "retry" : "first",
        answer,
      });
      onLevelChange(current.favId, o.mastery_after);
      setResults((prev) => {
        const i = prev.findIndex((r) => r.q.favId === current.favId);
        if (isRetry) {
          if (i < 0) return prev; // 防御：重练必来自首轮明细
          const next = [...prev];
          next[i] = { ...next[i], retryCorrect: o.correct };
          return next;
        }
        return [
          ...prev,
          { q: current, firstCorrect: o.correct, retryCorrect: null, before: o.mastery_before, after: o.mastery_after },
        ];
      });
      setFeedback(o);
      if (!o.correct && !isRetry) setRetryQueue((prev) => [...prev, current]);
    } catch (e) {
      // 提交未确认（超时/服务异常）：留在本题重试，不推进
      setSubmitError(e instanceof Error ? `提交未确认：${e.message}` : "提交未确认，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  const requestClose = () => {
    // setup / done 直接退出；run 中有会话 → 确认丢弃（首答等级已保存，丢的只是剩余题目）
    if (phase !== "run") {
      onClose();
      return;
    }
    setExitAsk(true);
  };

  // ---------------- 渲染 ----------------

  if (phase === "setup") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-zinc-50 dark:bg-zinc-950">
        <PanelHeader title="生词练习" onClose={requestClose} />
        <div className="mx-auto w-full max-w-xl flex-1 space-y-5 p-4">
          <div>
            <p className="eyebrow text-zinc-400">语言</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {langs.map((l) => (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    lang === l
                      ? "bg-emerald-600 text-white dark:bg-emerald-500"
                      : "border border-zinc-200 text-zinc-500 hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
                  }`}
                >
                  {langName(l)} · {items.filter((i) => i.lang === l).length} 词
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="eyebrow text-zinc-400">题量</p>
            <div className="mt-2">
              <Seg value={count} options={COUNT_OPTS} onChange={setCount} />
            </div>
          </div>
          <div>
            <p className="eyebrow text-zinc-400">题型（可多选，低熟练度优先出题）</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {MODE_ORDER.map((m) => (
                <button
                  key={m}
                  onClick={() => toggleMode(m)}
                  aria-pressed={modes.includes(m)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    modes.includes(m)
                      ? "bg-emerald-600 text-white dark:bg-emerald-500"
                      : "border border-zinc-200 text-zinc-500 hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
                  }`}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-zinc-400">
              词→义：给单词选意思 · 义→词：给意思选单词 · 拼写：给意思写单词 · 听音：只听发音选意思
            </p>
          </div>
          {prepMsg && <p className="text-sm text-red-500 dark:text-red-400">{prepMsg}</p>}
          <button
            onClick={start}
            disabled={!lang || modes.length === 0 || preparing}
            className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-500 dark:hover:bg-emerald-600"
          >
            {preparing
              ? "准备题目…"
              : lang
                ? `开始练习（${Math.min(langCount, Number(count))} 词）`
                : "先选语言"}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "run" && current) {
    const retryRound = round === "retry";
    const answeredShown = retryRound ? stats.retryDone : results.length;
    const totalShown = retryRound ? retryTotal : total;
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-zinc-50 dark:bg-zinc-950">
        <PanelHeader
          title="生词练习"
          onClose={requestClose}
          right={<span className="text-xs text-zinc-400">{answeredShown} / {totalShown}</span>}
        />
        <div className="mx-auto w-full max-w-xl flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          <Progress answered={answeredShown} total={totalShown} />
          {retryRound && <p className="mt-3 text-center text-xs text-amber-600 dark:text-amber-400">错词重练：只判分，熟练度不变</p>}
          <QuestionView q={current} revealed={feedback !== null} selected={selected} onSelect={setSelected} />
          {feedback && <FeedbackNote o={feedback} q={current} />}
          {submitError && (
            <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
              {submitError}
            </p>
          )}
        </div>
        {/* 底部答题栏：固定，上面内容区滚动 */}
        <div className="action-row shrink-0 border-t border-zinc-200/70 bg-white/80 px-4 py-3 backdrop-blur-md dark:border-zinc-800/70 dark:bg-zinc-950/80">
          {feedback ? (
            <button
              onClick={nextQuestion}
              className="flex-1 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600"
            >
              {queue.length > 0 || retryQueue.length > 0 ? "下一题" : "看结果"}
            </button>
          ) : current.mode === "meaning_type" ? (
            <>
              <TypedInput
                value={typed}
                disabled={submitting}
                overLimit={new TextEncoder().encode(typed.trim()).length > 128}
                onSubmit={() => submit({ kind: "typed", text: typed.trim() })}
                onChange={setTyped}
              />
              <button
                onClick={() => submit({ kind: "typed", text: typed.trim() })}
                disabled={submitting || !typed.trim()}
                className="flex-1 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-500 dark:hover:bg-emerald-600"
              >
                {submitting ? "判分中…" : "提交"}
              </button>
              <button
                onClick={() => submit({ kind: "surrender" })}
                disabled={submitting}
                className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-600 transition-colors hover:border-zinc-400 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-500"
              >
                不会
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => submit({ kind: "surrender" })}
                disabled={submitting}
                className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-600 transition-colors hover:border-zinc-400 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-500"
              >
                不会
              </button>
              <button
                onClick={() => selected && submit({ kind: "choice", selected_key: selected })}
                disabled={!selected || submitting}
                className="flex-1 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-500 dark:hover:bg-emerald-600"
              >
                {submitting ? "判分中…" : "确认"}
              </button>
            </>
          )}
        </div>
        <ConfirmDialog
          open={exitAsk}
          title="结束本次练习？"
          message="已答题目的熟练度变化已保存，剩余题目将丢弃。"
          confirmText="结束练习"
          onCancel={() => setExitAsk(false)}
          onConfirm={() => {
            setExitAsk(false);
            onClose();
          }}
        />
      </div>
    );
  }

  // done：结果页
  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-zinc-50 dark:bg-zinc-950">
      <PanelHeader title="练习结果" onClose={onClose} />
      <div className="mx-auto w-full max-w-xl flex-1 p-4">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-3xl font-medium">
            {stats.correct}
            <span className="text-lg text-zinc-400"> / {total}</span>
          </p>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">首轮正确率</p>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-xl bg-zinc-50 py-2 dark:bg-zinc-800/60">
              <p className="text-lg">{stats.retryCorrect}<span className="text-zinc-400">/{stats.retryDone}</span></p>
              <p className="text-zinc-400">重练答对</p>
            </div>
            <div className="rounded-xl bg-emerald-50 py-2 dark:bg-emerald-950/40">
              <p className="text-lg text-emerald-600 dark:text-emerald-400">↑ {stats.up}</p>
              <p className="text-zinc-400 dark:text-zinc-500">升级</p>
            </div>
            <div className="rounded-xl bg-red-50 py-2 dark:bg-red-950/40">
              <p className="text-lg text-red-500 dark:text-red-400">↓ {stats.down}</p>
              <p className="text-zinc-400 dark:text-zinc-500">降级</p>
            </div>
          </div>
        </div>
        <ul className="mt-4 space-y-2">
          {results.map((r) => (
            <li
              key={r.q.favId}
              className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  <span className={r.firstCorrect ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}>
                    {r.firstCorrect ? "✓" : "✗"}
                  </span>{" "}
                  {r.q.headword}
                </p>
                <p className="truncate text-xs text-zinc-400">{r.q.gloss}</p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                  r.after > r.before
                    ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
                    : r.after < r.before
                      ? "bg-red-50 text-red-500 dark:bg-red-950 dark:text-red-400"
                      : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                }`}
              >
                {r.retryCorrect === false && !r.firstCorrect
                  ? `${MASTERY_LABELS[r.after]} · 未巩固`
                  : MASTERY_LABELS[r.after]}
              </span>
            </li>
          ))}
        </ul>
        <button
          onClick={onClose}
          className="mt-5 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-600 transition-colors hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
        >
          回生词本
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

function Progress({ answered, total }: { answered: number; total: number }) {
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
  return (
    <div className="mt-3 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-1.5 rounded-full bg-emerald-600 transition-all dark:bg-emerald-400" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * 题面 + 选项。
 * 词→义 / 听音：题面单词（听音只给发音按钮，答完或点「看词」才显示）；
 * 义→词 / 拼写：题面是释义，词头答完才揭晓（发音按钮也在揭晓后出现，避免泄露）
 */
function QuestionView({ q, revealed, selected, onSelect }: {
  q: PracticeQuestion;
  revealed: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const [wordShown, setWordShown] = useState(false);
  useEffect(() => setWordShown(false), [q.favId, q.mode]);

  const faceIsWord = q.mode === "word_meaning";
  const faceIsAudio = q.mode === "audio_meaning";
  // 词头可见性：词→义题、已揭晓、或用户主动点了「看单词」——听音题答前绝不自动露词
  const showWord = faceIsWord || revealed || wordShown;

  return (
    <div className="mt-6 text-center">
      {faceIsWord && <p className="font-dict text-4xl leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">{q.headword}</p>}
      {faceIsAudio &&
        (showWord ? (
          <p className="font-dict text-4xl leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">{q.headword}</p>
        ) : (
          <>
            <p className="text-sm text-zinc-400">听发音，选意思</p>
            <div className="mt-3 flex justify-center">
              <SpeakButton text={q.headword} lang={q.lang as Lang} />
            </div>
            <button
              onClick={() => setWordShown(true)}
              className="mt-2 text-xs text-zinc-400 underline-offset-2 transition-colors hover:text-emerald-600 hover:underline dark:hover:text-emerald-400"
            >
              听不到？看单词（不计入听音练习）
            </button>
          </>
        ))}
      {!faceIsWord && !faceIsAudio && (
        <p className="text-balance px-2 text-2xl leading-snug text-zinc-900 dark:text-zinc-50">{q.gloss}</p>
      )}
      {showWord && !faceIsWord && (
        <div className="mt-3 flex items-center justify-center gap-2">
          {q.ipa && <span className="text-sm text-emerald-700 dark:text-emerald-400">/{q.ipa}/</span>}
          <SpeakButton text={q.headword} lang={q.lang as Lang} />
        </div>
      )}
      {faceIsWord && (
        <div className="mt-2 flex items-center justify-center gap-2">
          {q.ipa && <span className="text-sm text-emerald-700 dark:text-emerald-400">/{q.ipa}/</span>}
          <SpeakButton text={q.headword} lang={q.lang as Lang} />
        </div>
      )}
      <p className="mt-1 text-sm text-zinc-400">
        {q.mode === "word_meaning" && "选出最合适的意思"}
        {q.mode === "meaning_word" && "选出对应的单词"}
        {q.mode === "meaning_type" && "写出这个单词（重音、变音符要写对）"}
      </p>
      {q.options && (
        <div className="mt-5 space-y-2 text-left">
          {q.options.map((o) => (
            <button
              key={o.key}
              onClick={() => onSelect(o.key)}
              className={`block w-full rounded-xl border px-4 py-3 text-[15px] leading-relaxed transition-colors ${
                selected === o.key
                  ? "border-emerald-500 bg-emerald-50 text-emerald-800 dark:border-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-200"
                  : "border-zinc-200 bg-white text-zinc-700 hover:border-emerald-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-emerald-700"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 拼写题输入框：Enter 提交（IME 组合中不触发）；超 128 UTF-8 字节禁提交并提示 */
function TypedInput({ value, disabled, overLimit, onSubmit, onChange }: {
  value: string;
  disabled: boolean;
  overLimit: boolean;
  onSubmit: () => void;
  onChange: (v: string) => void;
}) {
  const [composing, setComposing] = useState(false);
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !composing && value.trim() && !overLimit) onSubmit();
      }}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      disabled={disabled}
      autoFocus
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      maxLength={128}
      aria-invalid={overLimit}
      placeholder={overLimit ? "超长（上限 128 字节）" : "输入单词…"}
      className="min-w-0 flex-1 rounded-xl border border-zinc-300 bg-white px-4 py-3 text-base outline-none transition-colors focus:border-emerald-400 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:focus:border-emerald-600"
    />
  );
}

/** 答题反馈：正误 + 正确答案（题面没展示词时揭晓）+ 熟练度变化 */
function FeedbackNote({ o, q }: { o: Outcome; q: PracticeQuestion }) {
  const lc =
    o.mastery_before === o.mastery_after
      ? null
      : `${MASTERY_LABELS[o.mastery_before]} → ${MASTERY_LABELS[o.mastery_after]}`;
  const wordHidden = q.mode !== "word_meaning";
  return (
    <div
      className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
        o.correct
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
          : "border-red-200 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400"
      }`}
    >
      <p className="font-medium">{o.correct ? "✓ 答对了" : "✗ 答错了"}</p>
      {wordHidden && (
        <p className="mt-1">
          {o.correct ? "单词：" : "正确答案："}
          <span className="font-dict mx-1 font-medium">{o.expected_headword}</span>
        </p>
      )}
      {!o.correct && <p className="mt-1">意思：{q.gloss}</p>}
      {lc ? (
        <p className="mt-1 text-xs opacity-80">熟练度 {lc}</p>
      ) : (
        <p className="mt-1 text-xs opacity-80">熟练度不变{o.duplicate ? "（重试回放首次结果）" : ""}</p>
      )}
    </div>
  );
}
