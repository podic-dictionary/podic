import { useCallback, useEffect, useRef, useState } from "react";
import { lookup, reverse } from "../api";
import { addHistory } from "../history";
import AiCompleteBar from "../components/AiCompleteBar";
import EntryCard from "../components/EntryCard";
import FallbackCard from "../components/FallbackCard";
import SearchBar from "../components/SearchBar";
import type { Entry, Lang } from "../types";

export default function SearchView({ lang, onLangChange }: { lang: Lang; onLangChange: (l: Lang) => void }) {
  const [results, setResults] = useState<Entry[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // 当前结果是否允许 AI 自动补全（用户主动查词才允许；切语言自动重查/AI 入库后的
  // 重查不允许——后者曾与 FallbackCard 卸载重挂组成回路，结果区反复闪烁）
  const [aiAutoAllowed, setAiAutoAllowed] = useState(true);
  // 已自动补全过的查询键：FallbackCard 随 loading 卸载重挂，键必须由父级持有
  const autoTried = useRef(new Set<string>());
  const reqSeq = useRef(0); // 主查询竞态防护：慢响应/清空/切语言后旧请求不得写状态

  // 切语言：输入框有内容就用新语言重查，否则清空结果
  useEffect(() => {
    if (query.trim()) {
      onSearch(query, undefined, false, "auto");
    } else {
      setResults(null);
      setError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const onSearch = useCallback(
    async (q: string, l?: Lang, exact = false, origin: "user" | "auto" = "user") => {
      if (!q.trim()) return;
      // 点了别的语言的历史词条：切语言后由 [lang] effect 用新语言重查
      if (l && l !== lang) {
        setQuery(q);
        onLangChange(l);
        return;
      }
      const mine = ++reqSeq.current;
      setAiAutoAllowed(origin === "user");
      setLoading(true);
      setQuery(q);
      setError("");
      try {
        // 路由：日语及新注册语言先走正向（假名/汉字/user_dict 表记都在正向路径里，
        // 无包语言的 AI 补录词条只有正向能命中），空且含汉字再反查兜底；
        // en/fr 保持旧行为：含汉字直接中文反查。
        // exact（候选选定/历史点击）：只查该词，跳过前缀/模糊扩散
        const hasKanji = /[一-鿿]/.test(q);
        const forwardFirst = lang === "ja" || !["en", "fr"].includes(lang);
        let items: Entry[];
        if (exact) {
          items = await lookup(q, lang, 20, true);
        } else if (forwardFirst) {
          items = await lookup(q, lang);
          if (items.length === 0 && hasKanji) items = await reverse(q, lang);
        } else {
          items = hasKanji ? await reverse(q, lang) : await lookup(q, lang);
        }
        if (mine !== reqSeq.current) return; // 期间已切查询/清空/切语言：丢弃
        setResults(items);
        // 有结果的查询记入历史（词头 + 首条释义摘要）
        if (items.length > 0) {
          const first = items[0];
          const gloss = (first.senses?.find((s) => s.zh)?.zh ?? "").slice(0, 40);
          addHistory({ lang, q, headword: first.headword, gloss, ts: Date.now() });
        }
      } catch (e) {
        if (mine !== reqSeq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setResults(null);
      } finally {
        if (mine === reqSeq.current) setLoading(false);
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
    // 返回键从词条详情退回：清查询回到空查词页（App 的词条条目被消费时派发）
    const onClose = () => {
      ++reqSeq.current; // 作废在途查询，旧结果不得在清空后回填
      setLoading(false);
      setResults(null);
      setError("");
      setQuery("");
    };
    window.addEventListener("podic:close-word", onClose);
    return () => {
      window.removeEventListener("podic:search", onExternal);
      window.removeEventListener("podic:close-word", onClose);
    };
  }, [onSearch]);

  // 精确命中 = 包内 exact / 日语读音 reading（假名是词的读法，同音多词条是常态）/
  // AI 补录 user；form（屈折表指向词根）不算——查询词没有独立词条时才给 AI 补全入口
  const hasExact = results?.some((e) => e.matched_by === "exact" || e.matched_by === "reading" || e.matched_by === "user") ?? false;
  // 读音匹配组：日语假名查词的第一条 reading 结果前给分组标签（同音词都在这组）
  const firstReading = results?.findIndex((e) => e.matched_by === "reading") ?? -1;

  return (
    <div className="mx-auto max-w-2xl p-4">
      <SearchBar
        langs={lang}
        onSearch={onSearch}
        onClear={() => {
          ++reqSeq.current; // 作废在途主查询，旧结果不得在清空后回填
          setLoading(false);
          setResults(null);
          setError("");
          setQuery("");
        }}
      />

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
          <FallbackCard
            query={query}
            lang={lang}
            allowAuto={aiAutoAllowed}
            triedRef={autoTried}
            onSaved={() => onSearch(query, undefined, false, "auto")}
          />
        )}
        {!loading && !error && results !== null && results.length > 0 && !hasExact && (
          <AiCompleteBar query={query} lang={lang} onSaved={() => onSearch(query, undefined, false, "auto")} />
        )}
        {results?.map((e, i) => (
          <div key={`${e.lang}-${e.entry_id}-${i}`} className="podic-enter" style={{ animationDelay: `${Math.min(i, 8) * 55}ms` }}>
            {i === firstReading && (
              <p className="mb-3 flex items-center gap-2 text-xs text-zinc-400">
                <span className="inline-block h-px flex-1 bg-zinc-200 dark:bg-zinc-700" aria-hidden />
                读音「{query}」匹配的词条
                <span className="inline-block h-px flex-1 bg-zinc-200 dark:bg-zinc-700" aria-hidden />
              </p>
            )}
            <EntryCard entry={e} autoExamples={i < 2} />
          </div>
        ))}
      </div>
    </div>
  );
}
