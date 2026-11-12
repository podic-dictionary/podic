import { useCallback, useEffect, useRef, useState } from "react";
import { listFavorites, removeFavorite, type Favorite } from "../api";
import { useSettings } from "../SettingsContext";
import { langDisplayName } from "../langNames";
import PracticePanel from "../components/practice/PracticePanel";
import VocabularyTestPanel from "../components/practice/VocabularyTestPanel";
import { MASTERY_LABELS } from "../lib/practice";

export type FavoritesSub = "practice" | "vocab-test" | null;

export default function FavoritesView({
  active,
  onOpenWord,
  sub,
  setSub,
}: {
  active: boolean;
  onOpenWord: (word: string, lang: string) => void;
  sub: FavoritesSub;
  setSub: (s: FavoritesSub) => void;
}) {
  const { languages } = useSettings();
  const langName = (code: string) => {
    const l = languages.find((x) => x.code === code);
    return l?.short?.trim() || l?.name.slice(0, 1) || langDisplayName(code).slice(0, 1);
  };
  const [items, setItems] = useState<Favorite[]>([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [langFilter, setLangFilter] = useState<string>("all");
  const [masteryFilter, setMasteryFilter] = useState<number>(0); // 0 = 全部等级

  const refresh = useCallback(async () => {
    try {
      setItems(await listFavorites());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // tab 常驻挂载：切到本页时刷新（收藏后进来能看到新词）
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  const onRemove = async (id: number) => {
    try {
      await removeFavorite(id);
    } catch {
      // 离线/服务不可达时静默，下次刷新还能看到
    }
    await refresh();
  };

  // 练习判分回调：就地更新该词熟练度（列表不整页刷新，避免答题页背后跳动）
  const onLevelChange = useCallback((id: number, mastery: number) => {
    setItems((prev) => prev.map((f) => (f.id === id ? { ...f, mastery } : f)));
  }, []);

  // 变音折叠匹配：éleveur 也能被 "elev" 搜到
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const langs = [...new Set(items.map((i) => i.lang))];
  const masteryCounts = [1, 2, 3, 4].map(
    (m) => items.filter((f) => f.mastery === m && (langFilter === "all" || f.lang === langFilter)).length,
  );
  const shown = items.filter(
    (f) =>
      (langFilter === "all" || f.lang === langFilter) &&
      (masteryFilter === 0 || f.mastery === masteryFilter) &&
      (!q.trim() || fold(f.headword).includes(fold(q))),
  );

  // 「测验」下拉：练习生词 + 单词量测试 收在一个入口（验收反馈：别占一排大按钮）
  const [quizOpen, setQuizOpen] = useState(false);
  const quizBoxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (quizBoxRef.current && !quizBoxRef.current.contains(e.target as Node)) setQuizOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="mx-auto max-w-2xl p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">生词本</h1>
        <div ref={quizBoxRef} className="relative">
          <button
            onClick={() => setQuizOpen((v) => !v)}
            className="rounded-xl border border-zinc-300 bg-white px-3.5 py-1.5 text-sm text-zinc-600 transition-colors hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
          >
            测验
          </button>
          {quizOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-36 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              <button
                onClick={() => { setQuizOpen(false); setSub("practice"); }}
                disabled={items.length === 0}
                className="block w-full px-4 py-2.5 text-left text-sm text-zinc-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-emerald-950/40"
              >
                练习生词
              </button>
              <button
                onClick={() => { setQuizOpen(false); setSub("vocab-test"); }}
                className="block w-full px-4 py-2.5 text-left text-sm text-zinc-700 transition-colors hover:bg-emerald-50 dark:text-zinc-200 dark:hover:bg-emerald-950/40"
              >
                单词量测试
              </button>
            </div>
          )}
        </div>
      </div>

      {items.length > 0 && (
        <div className="mt-3 space-y-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="过滤生词…"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-emerald-600"
          />
          {langs.length > 1 && (
            <div className="flex gap-1.5">
              {["all", ...langs].map((l) => (
                <button
                  key={l}
                  onClick={() => setLangFilter(l)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    langFilter === l
                      ? "bg-emerald-600 text-white dark:bg-emerald-500"
                      : "border border-zinc-200 text-zinc-500 hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
                  }`}
                >
                  {l === "all" ? "全部" : (langName(l))}
                </button>
              ))}
            </div>
          )}
          {/* 等级筛选：下拉（验收反馈：一排按钮窄屏会换行挤烂） */}
          <div>
            <select
              value={masteryFilter}
              onChange={(e) => setMasteryFilter(Number(e.target.value))}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600 outline-none transition-colors focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:focus:border-emerald-600"
            >
              <option value={0}>全部等级</option>
              {[1, 2, 3, 4].map((m, i) => (
                <option key={m} value={m}>
                  {MASTERY_LABELS[m]}（{masteryCounts[i]}）
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500 dark:text-red-400">{error}</p>}

      <div className="mt-4 space-y-2">
        {items.length === 0 && (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-400 dark:border-zinc-700">
            还没有收藏。查词时点 ★ 收藏生词。
          </p>
        )}
        {items.length > 0 && shown.length === 0 && (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-400 dark:border-zinc-700">
            没有匹配的生词
          </p>
        )}
        {shown.map((f) => (
          <div
            key={f.id}
            className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <button
              onClick={() => onOpenWord(f.headword, f.lang)}
              className="min-w-0 flex-1 text-left"
              title="去查词"
            >
              <div>
              <p className="font-medium">
                <span className="mr-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">
                  {langName(f.lang)}
                </span>
                {f.headword}
                <span
                  title={`熟练度：${MASTERY_LABELS[f.mastery]}`}
                  className={`ml-2 rounded px-1.5 py-0.5 text-xs ${
                    f.mastery >= 3
                      ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"
                      : "bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400"
                  }`}
                >
                  {MASTERY_LABELS[f.mastery]}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-zinc-400">收藏于 {f.created_at.slice(0, 10)}</p>
              </div>
            </button>
            <button
              onClick={() => onRemove(f.id)}
              className="shrink-0 rounded-lg px-3 py-2.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
            >
              移除
            </button>
          </div>
        ))}
      </div>

      {/* 练习 / 单词量测试全屏面板（active 由 App 的 display 切换控制显隐） */}
      {sub === "practice" && (
        <PracticePanel
          items={items}
          defaultLang={langFilter === "all" ? "" : langFilter}
          onLevelChange={onLevelChange}
          onClose={() => setSub(null)}
        />
      )}
      {sub === "vocab-test" && <VocabularyTestPanel onClose={() => setSub(null)} />}
    </div>
  );
}
