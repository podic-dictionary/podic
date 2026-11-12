import { useCallback, useEffect, useState } from "react";
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

  return (
    <div className="mx-auto max-w-2xl p-4">
      <h1 className="text-lg font-medium">生词本</h1>

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
                      : "border border-zinc-200 text-zinc-500 hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-700 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
                  }`}
                >
                  {l === "all" ? "全部" : (langName(l))}
                </button>
              ))}
            </div>
          )}
          {/* 等级筛选：数量按当前语言统计（不含等级），切级不掉数 */}
          <div className="flex gap-1.5">
            <button
              onClick={() => setMasteryFilter(0)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                masteryFilter === 0
                  ? "bg-emerald-600 text-white dark:bg-emerald-500"
                  : "border border-zinc-200 text-zinc-500 hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-700 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
              }`}
            >
              全部等级
            </button>
            {[1, 2, 3, 4].map((m, i) => (
              <button
                key={m}
                onClick={() => setMasteryFilter(m)}
                className={`rounded-full px-3 py-1 text-xs transition-colors ${
                  masteryFilter === m
                    ? "bg-emerald-600 text-white dark:bg-emerald-500"
                    : "border border-zinc-200 text-zinc-500 hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-700 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
                }`}
              >
                {MASTERY_LABELS[m]} {masteryCounts[i]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 练习 / 词汇自测入口：自测只依赖已装词典，零收藏也要能进（评审 R12） */}
      <div className={`flex gap-2 ${items.length > 0 ? "pt-1" : "mt-3"}`}>
        <button
          onClick={() => setSub("practice")}
          disabled={items.length === 0}
          title={items.length === 0 ? "先收藏几个生词" : undefined}
          className="flex-1 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-500 dark:hover:bg-emerald-600"
        >
          练习生词
        </button>
        <button
          onClick={() => setSub("vocab-test")}
          className="flex-1 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-600 transition-colors hover:border-emerald-300 hover:text-emerald-600 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
        >
          词汇自测
        </button>
      </div>

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

      {/* 练习 / 词汇自测全屏面板（active 由 App 的 display 切换控制显隐） */}
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
