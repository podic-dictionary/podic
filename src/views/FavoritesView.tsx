import { useCallback, useEffect, useState } from "react";
import { listFavorites, removeFavorite, type Favorite } from "../api";

const LANG_NAMES: Record<string, string> = { en: "英", fr: "法", ja: "日" };

export default function FavoritesView({
  active,
  onOpenWord,
}: {
  active: boolean;
  onOpenWord: (word: string, lang: string) => void;
}) {
  const [items, setItems] = useState<Favorite[]>([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [langFilter, setLangFilter] = useState<string>("all");

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

  // 变音折叠匹配：éleveur 也能被 "elev" 搜到
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const langs = [...new Set(items.map((i) => i.lang))];
  const shown = items.filter(
    (f) =>
      (langFilter === "all" || f.lang === langFilter) &&
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
                  {l === "all" ? "全部" : (LANG_NAMES[l] ?? l)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

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
                  {LANG_NAMES[f.lang] ?? f.lang}
                </span>
                {f.headword}
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
    </div>
  );
}
