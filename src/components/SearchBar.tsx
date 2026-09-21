import { useEffect, useRef, useState } from "react";
import { suggest } from "../api";
import { getHistory, type HistoryItem } from "../history";
import type { Lang, SuggestItem } from "../types";

const LANG_LABEL: Record<string, string> = { en: "英", fr: "法", ja: "日" };

export default function SearchBar({
  langs,
  onSearch,
}: {
  langs: string;
  onSearch: (q: string, lang?: Lang) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SuggestItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const seq = useRef(0); // 竞态防护：响应回来时输入已变则丢弃
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // 最近查询里前缀匹配当前输入的条目（保留在联想前面）
  const matchedHistory = (v: string) => {
    const p = v.trim().toLowerCase();
    if (!p) return [];
    return history.filter((h) => h.headword.toLowerCase().startsWith(p) || h.q.toLowerCase().startsWith(p));
  };

  const onChange = (v: string) => {
    setQuery(v);
    window.clearTimeout(timer.current);
    if (!v.trim()) {
      setItems([]);
      setHistory(getHistory());
      setOpen(true); // 清空输入回到最近查询
      return;
    }
    timer.current = window.setTimeout(async () => {
      const hist = matchedHistory(v);
      const mine = ++seq.current;
      try {
        const r = await suggest(v, langs);
        if (mine !== seq.current) return; // 慢网络的旧响应不覆盖新输入
        setItems(r);
        setOpen(r.length > 0 || hist.length > 0);
      } catch {
        if (mine !== seq.current) return;
        setItems([]);
        setOpen(hist.length > 0);
      }
    }, 200);
  };

  const go = (q: string, lang?: Lang) => {
    window.clearTimeout(timer.current); // 取消未触发的联想请求，避免下拉在回车后又弹开
    setOpen(false);
    (document.activeElement as HTMLElement | null)?.blur(); // 收起手机键盘
    setQuery(q);
    onSearch(q, lang);
  };

  const v = query.trim().toLowerCase();
  const histShown = v ? matchedHistory(query).slice(0, 3) : history.slice(0, 10);
  const sugShown = items.filter((it) => !histShown.some((h) => h.headword === it.headword));

  return (
    <div ref={boxRef} className="relative">
      <input
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go(query)}
        onFocus={() => {
          setHistory(getHistory());
          setOpen(true);
        }}
        placeholder="查一个词…"
        className="font-dict w-full border-0 border-b-2 border-zinc-300 bg-transparent px-1 py-2.5 text-2xl tracking-tight outline-none
                   transition-colors placeholder:text-zinc-300 focus:border-emerald-600
                   dark:border-zinc-700 dark:placeholder:text-zinc-600 dark:focus:border-emerald-400"
      />
      {(histShown.length > 0 || sugShown.length > 0) && (
        <ul
          className="podic-card absolute z-10 mt-1.5 w-full overflow-hidden rounded-2xl bg-white/95 backdrop-blur-md
                     divide-y divide-zinc-100 dark:bg-zinc-900/95 dark:divide-zinc-800/70"
          style={{ display: open ? undefined : "none" }}
        >
          {histShown.map((h) => (
            <li key={`h-${h.lang}-${h.q}`}>
              <button
                onClick={() => go(h.headword, h.lang as Lang)}
                title={h.gloss}
                className="flex w-full items-center gap-2 px-5 py-2.5 text-left transition-colors hover:bg-emerald-50/80 dark:hover:bg-emerald-950/40"
              >
                <span aria-hidden className="text-xs text-zinc-300 dark:text-zinc-600">
                  🕘
                </span>
                <span className="font-dict text-zinc-900 dark:text-zinc-100">{h.headword}</span>
                <span className="rounded border border-zinc-200 px-1 text-xs leading-4 text-zinc-400 dark:border-zinc-700">
                  {LANG_LABEL[h.lang] ?? h.lang}
                </span>
                <span className="ml-auto max-w-[45%] truncate text-sm text-zinc-400">{h.gloss}</span>
              </button>
            </li>
          ))}
          {sugShown.map((it) => (
            <li key={`s-${it.lang}-${it.headword}`}>
              <button
                onClick={() => go(it.headword)}
                className="flex w-full items-baseline gap-2 px-5 py-2.5 text-left transition-colors hover:bg-emerald-50/80 dark:hover:bg-emerald-950/40"
              >
                <span className="font-dict text-zinc-900 dark:text-zinc-100">{it.headword}</span>
                {it.reading && <span className="text-sm text-zinc-400">{it.reading}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
