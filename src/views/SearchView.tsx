import { useCallback, useEffect, useState } from "react";
import { lookup, reverse } from "../api";
import { addHistory } from "../history";
import EntryCard from "../components/EntryCard";
import FallbackCard from "../components/FallbackCard";
import SearchBar from "../components/SearchBar";
import type { Entry, Lang } from "../types";

export default function SearchView({ lang, onLangChange }: { lang: Lang; onLangChange: (l: Lang) => void }) {
  const [results, setResults] = useState<Entry[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // 切语言：输入框有内容就用新语言重查，否则清空结果
  useEffect(() => {
    if (query.trim()) {
      onSearch(query);
    } else {
      setResults(null);
      setError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const onSearch = useCallback(
    async (q: string, l?: Lang) => {
      if (!q.trim()) return;
      // 点了别的语言的历史词条：切语言后由 [lang] effect 用新语言重查
      if (l && l !== lang) {
        setQuery(q);
        onLangChange(l);
        return;
      }
      setLoading(true);
      setQuery(q);
      setError("");
      try {
        // 路由：日语查询走正向（假名/汉字表记都在 entry/form 里）；
        // 英/法查询含汉字时走中文反查；日语无结果且含汉字再尝试反查（中文→日语）
        const hasKanji = /[一-鿿]/.test(q);
        let items: Entry[];
        if (lang === "ja") {
          items = await lookup(q, lang);
          if (items.length === 0 && hasKanji) items = await reverse(q, lang);
        } else {
          items = hasKanji ? await reverse(q, lang) : await lookup(q, lang);
        }
        setResults(items);
        // 有结果的查询记入历史（词头 + 首条释义摘要）
        if (items.length > 0) {
          const first = items[0];
          const gloss = (first.senses?.find((s) => s.zh)?.zh ?? "").slice(0, 40);
          addHistory({ lang, q, headword: first.headword, gloss, ts: Date.now() });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setResults(null);
      } finally {
        setLoading(false);
      }
    },
    [lang, onLangChange],
  );

  // 其他视图发起的查词（如生词本点词）：切语言逻辑由 onSearch 内部处理
  useEffect(() => {
    const onExternal = (e: Event) => {
      const { q, lang: l } = (e as CustomEvent<{ q: string; lang?: Lang }>).detail;
      if (q) onSearch(q, l);
    };
    window.addEventListener("podic:search", onExternal);
    return () => window.removeEventListener("podic:search", onExternal);
  }, [onSearch]);

  return (
    <div className="mx-auto max-w-2xl p-4">
      <SearchBar langs={lang} onSearch={onSearch} />

      <div className="mt-6 space-y-7">
        {/* 空态落款：竖排「拾字为舟」+ 小印 */}
        {results === null && !query.trim() && !loading && !error && (
          <div className="podic-enter flex justify-center pt-16">
            <div className="motto-col text-2xl">
              <span>拾</span>
              <span>字</span>
              <span>为</span>
              <span>舟</span>
              <span
                className="seal mt-4"
                style={{ width: "1.75rem", height: "1.75rem", fontSize: "1rem", borderRadius: "0.3rem" }}
                aria-hidden
              >
                典
              </span>
            </div>
          </div>
        )}
        {loading && <p className="text-sm text-zinc-400">查询中…</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}
        {results !== null && results.length === 0 && !loading && (
          <FallbackCard query={query} lang={lang} />
        )}
        {results?.map((e, i) => (
          <div key={`${e.lang}-${e.entry_id}-${i}`} className="podic-enter" style={{ animationDelay: `${Math.min(i, 8) * 55}ms` }}>
            <EntryCard entry={e} autoExamples={i < 2} />
          </div>
        ))}
      </div>
    </div>
  );
}
