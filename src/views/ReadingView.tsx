import { useCallback, useEffect, useRef, useState } from "react";
import {
  createArticle,
  deleteArticle,
  extractFromHtml,
  fetchArticleFromUrl,
  getArticle,
  getWordStatus,
  listArticles,
  setWordStatus,
} from "../api";
import type { ArticleFull, ArticleMeta, Lang, WordStatus } from "../types";
import { useSettings } from "../SettingsContext";
import ArticleReader, { type ArticleReaderHandle } from "../components/reader/ArticleReader";
import ConfirmDialog from "../components/ConfirmDialog";
import { PlusIcon, TrashIcon } from "../components/icons";

const LANG_OPTS: { id: Lang; label: string }[] = [
  { id: "en", label: "英语" },
  { id: "fr", label: "法语" },
  { id: "ja", label: "日语" },
];

const inputCls =
  "rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-emerald-600";

const fmtDate = (s: string) => s.replace("T", " ").slice(0, 16);

// 粘贴草稿：切页签/切文章不丢（sessionStorage，保存成功后清除）
const DRAFT_KEY = "podic.reader.draft";
// 阅读进度：每篇文章的滚动位置持久化（重启 app 恢复）
const scrollKey = (id: number) => `podic.reading.scroll.${id}`;

// ---- SPA 页面原生渲染 ----
// 协议：JS 调 PodicAndroid.renderHtml(url, token)（Android）或
// webkit.messageHandlers.podicRender.postMessage({url, token})（iOS）；
// 壳渲染完成后回 window.__podicRenderResult(token, html)
interface PodicWindow {
  PodicAndroid?: { renderHtml?: (url: string, token: string) => void };
  webkit?: { messageHandlers?: { podicRender?: { postMessage: (m: unknown) => void } } };
  __podicRenderWait?: Record<string, (html: string) => void>;
  __podicRenderResult?: (token: string, html: string) => void;
}

const PW = window as unknown as PodicWindow;
PW.__podicRenderResult = (token, html) => {
  PW.__podicRenderWait?.[token]?.(html);
};

function hasNativeRender(): boolean {
  return Boolean(PW.PodicAndroid?.renderHtml || PW.webkit?.messageHandlers?.podicRender);
}

function nativeRenderHtml(url: string): Promise<string> {
  const token = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return new Promise((resolve, reject) => {
    const wait = (PW.__podicRenderWait ??= {});
    const timer = window.setTimeout(() => {
      delete wait[token];
      reject(new Error("原生渲染超时"));
    }, 25000);
    wait[token] = (html) => {
      window.clearTimeout(timer);
      delete wait[token];
      if (html) resolve(html);
      else reject(new Error("原生渲染失败"));
    };
    if (PW.PodicAndroid?.renderHtml) PW.PodicAndroid.renderHtml(url, token);
    else if (PW.webkit?.messageHandlers?.podicRender) PW.webkit.messageHandlers.podicRender.postMessage({ url, token });
    else {
      window.clearTimeout(timer);
      delete wait[token];
      reject(new Error("当前环境不支持原生渲染"));
    }
  });
}

export default function ReadingView({
  lang,
  articleId,
  setArticleId,
}: {
  lang: Lang;
  /** number=文章 id | "new"=粘贴 | null=列表 */
  articleId: number | "new" | null;
  setArticleId: (v: number | "new" | null) => void;
}) {
  const { aiChoice } = useSettings();
  const [articles, setArticles] = useState<ArticleMeta[] | null>(null);
  const [article, setArticle] = useState<ArticleFull | null>(null);
  // 生词标记不走 React 状态：标记时 DOM 直改 + ref 更新，长文不做全量重渲染
  const statusesRef = useRef<Record<string, WordStatus>>({});
  const readerRef = useRef<ArticleReaderHandle>(null);
  const [form, setForm] = useState<{ lang: Lang; title: string; content: string } | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [saveErr, setSaveErr] = useState("");
  const [saving, setSaving] = useState(false);
  // URL 导入
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<number | undefined>(undefined);
  const restoredFor = useRef<number | null>(null);

  const loadList = useCallback(() => {
    listArticles().then(setArticles).catch(() => setArticles([]));
  }, []);

  useEffect(loadList, [loadList]);

  // 文章载入（列表 → 点开）
  useEffect(() => {
    if (typeof articleId !== "number") {
      setArticle(null);
      return;
    }
    let alive = true;
    setArticle(null);
    getArticle(articleId)
      .then((a) => alive && setArticle(a))
      .catch(() => alive && setArticleId(null));
    return () => {
      alive = false;
    };
  }, [articleId, setArticleId]);

  // 阅读进度：文章打开后恢复上次滚动位置；滚动时节流保存（仅在本 tab 可见时记录，
  // 滚动容器是 App 的 main，切到其他 tab 后的滚动不能算进本文进度）
  useEffect(() => {
    if (!article || typeof articleId !== "number") return;
    const main = rootRef.current?.closest("main");
    if (!main) return;
    const raf = requestAnimationFrame(() => {
      const saved = Number(localStorage.getItem(scrollKey(article.id)) ?? 0);
      if (saved > 0) main.scrollTo(0, saved);
      restoredFor.current = article.id;
    });
    const onScroll = () => {
      if (restoredFor.current !== article.id) return;
      if (!rootRef.current || (rootRef.current as HTMLElement).offsetParent === null) return;
      window.clearTimeout(scrollTimer.current);
      scrollTimer.current = window.setTimeout(() => {
        try {
          localStorage.setItem(scrollKey(article.id), String(main.scrollTop));
        } catch { /* 静默 */ }
      }, 300);
    };
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(scrollTimer.current);
      main.removeEventListener("scroll", onScroll);
    };
  }, [article, articleId]);

  // 生词标记按文章语种加载
  useEffect(() => {
    if (!article) return;
    getWordStatus(article.lang)
      .then((m) => {
        statusesRef.current = m;
        readerRef.current?.refresh();
      })
      .catch(() => {});
  }, [article?.lang, article?.id]);

  // 粘贴态：进表单时恢复草稿
  useEffect(() => {
    if (articleId === "new") {
      let d = { lang, title: "", content: "" };
      try {
        const raw = sessionStorage.getItem(DRAFT_KEY);
        if (raw) {
          d = { ...d, ...(JSON.parse(raw) as typeof d) };
          setDraftRestored(Boolean(d.content.trim()));
        }
      } catch {
        /* 坏草稿当没有 */
      }
      setForm(d);
    } else {
      setForm(null);
      setDraftRestored(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId]);

  const patchForm = (f: { lang: Lang; title: string; content: string }) => {
    setForm(f);
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(f));
    } catch {
      /* 存不下就算了 */
    }
  };

  const onMark = useCallback(
    (norm: string, s: WordStatus | "none") => {
      const m = { ...(statusesRef.current ?? {}) };
      if (s === "none") delete m[norm];
      else m[norm] = s;
      statusesRef.current = m;
      readerRef.current?.refresh();
      const l = article?.lang;
      if (l) setWordStatus(l, norm, s).catch(() => {});
    },
    [article?.lang],
  );

  const saveNew = async () => {
    if (!form || !form.content.trim() || saving) return;
    setSaving(true);
    setSaveErr("");
    try {
      const art = await createArticle(form.lang, form.title.trim(), form.content);
      sessionStorage.removeItem(DRAFT_KEY);
      setForm(null);
      setArticleId(art.id);
      loadList();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const grabUrl = async () => {
    const u = url.trim();
    if (!u || fetching || !form) return;
    setFetching(true);
    setFetchMsg("");
    setSaveErr("");
    try {
      const r = await fetchArticleFromUrl(u);
      patchForm({ ...form, title: r.title.trim() || form.title, content: r.content });
      setFetchMsg(`已导入 ${r.chars} 字，可编辑后保存`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 422 = 源码里没正文（疑似 SPA）：移动壳里用原生 WebView 渲染后再提一次
      if (msg.startsWith("422") && hasNativeRender()) {
        setFetchMsg("页面需要 JS 渲染，原生 WebView 渲染中…");
        try {
          const html = await nativeRenderHtml(u);
          const r = await extractFromHtml(u, html);
          patchForm({ ...form, title: r.title.trim() || form.title, content: r.content });
          setFetchMsg(`已导入 ${r.chars} 字（原生渲染），可编辑后保存`);
        } catch (e2) {
          setFetchMsg(e2 instanceof Error ? e2.message : String(e2));
        }
      } else {
        setFetchMsg(msg);
      }
    } finally {
      setFetching(false);
    }
  };

  // ---- 粘贴表单 ----
  if (articleId === "new" && form) {
    return (
      // flex 列布局：textarea 占剩余空间（小屏按需缩小），保存按钮钉在阅读区底部不挤进 tab 栏
      <div className="mx-auto flex h-full max-w-2xl flex-col p-4">
        <div className="flex gap-2">
          <select
            value={form.lang}
            onChange={(e) => patchForm({ ...form, lang: e.target.value as Lang })}
            className={`${inputCls} w-24 shrink-0`}
          >
            {LANG_OPTS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            value={form.title}
            onChange={(e) => patchForm({ ...form, title: e.target.value })}
            placeholder="标题（可留空）"
            className={`${inputCls} min-w-0 flex-1`}
          />
        </div>
        <div className="mt-2 flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && grabUrl()}
            placeholder="或粘贴文章链接（公众号 / 新闻页），自动抓正文"
            className={`${inputCls} min-w-0 flex-1`}
          />
          <button
            onClick={grabUrl}
            disabled={!url.trim() || fetching}
            className="shrink-0 rounded-xl border border-emerald-500/60 px-4 text-sm text-emerald-600 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
          >
            {fetching ? "抓取中…" : "抓取"}
          </button>
        </div>
        {fetchMsg && <p className="mt-1 text-xs text-zinc-400">{fetchMsg}</p>}
        <textarea
          value={form.content}
          onChange={(e) => patchForm({ ...form, content: e.target.value })}
          placeholder="粘贴文章正文…（每个换行分段，保存后逐词可点读）"
          className={`${inputCls} mt-2 min-h-0 w-full flex-1 resize-none leading-relaxed`}
        />
        {draftRestored && (
          <p className="mt-1 shrink-0 text-xs text-amber-600 dark:text-amber-400">已恢复上次未保存的草稿</p>
        )}
        <div className="action-row mt-3 shrink-0 flex-wrap">
          <button
            onClick={saveNew}
            disabled={!form.content.trim() || saving}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存并阅读"}
          </button>
          <span className="text-xs text-zinc-400">{form.content.length} 字符</span>
          {saveErr && <span className="text-xs text-red-500">{saveErr}</span>}
        </div>
      </div>
    );
  }

  // ---- 阅读器 ----
  if (typeof articleId === "number") {
    return (
      <div ref={rootRef} className="mx-auto max-w-2xl p-4">
        {article ? (
          <>
            <h1 className="mb-1 text-lg font-medium leading-snug">{article.title || "未命名"}</h1>
            <p className="mb-1 text-xs text-zinc-400">
              {LANG_OPTS.find((o) => o.id === article.lang)?.label} · {article.token_count} 词 · 点词查词典，划选 AI 解析
            </p>
            {/* 状态图例：底色=没读过的词，金虚线=生词，标「认识」清掉底色 */}
            <p className="mb-4 text-xs text-zinc-400">
              <span className="rounded-sm bg-emerald-50/90 px-0.5 underline decoration-emerald-300 decoration-dotted decoration-[1.5px] underline-offset-4 dark:decoration-emerald-700 dark:bg-emerald-950/60">
                没读过的词
              </span>
              <span className="ml-3 underline decoration-amber-400 decoration-dotted decoration-2 underline-offset-4 dark:decoration-amber-500">
                生词
              </span>
              <span className="ml-3">认识 → 清掉底色</span>
            </p>
            <ArticleReader
              ref={readerRef}
              article={article}
              statusesRef={statusesRef}
              onMark={onMark}
              aiReady={Boolean(aiChoice.providerId)}
            />
          </>
        ) : (
          <p className="py-10 text-center text-sm text-zinc-400">加载中…</p>
        )}
      </div>
    );
  }

  // ---- 文章列表 ----
  return (
    <div className="mx-auto max-w-2xl p-4">
      <div className="action-row flex-wrap">
        <button
          onClick={() => setArticleId("new")}
          className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700"
        >
          <PlusIcon size={15} /> 粘贴文章
        </button>
        <span className="text-xs text-zinc-400">粘一段外文，逐词点读；缺词让 AI 补进词典</span>
      </div>

      {articles === null && <p className="py-10 text-center text-sm text-zinc-400">加载中…</p>}
      {articles !== null && articles.length === 0 && (
        <p className="py-10 text-center text-sm text-zinc-400">还没有文章</p>
      )}

      <ul className="mt-4 space-y-2">
        {(articles ?? []).map((a) => (
          <li key={a.id}>
            <div className="flex items-center gap-3 rounded-2xl border border-zinc-200/80 bg-white/85 px-4 py-3 backdrop-blur transition-all duration-300 hover:border-emerald-300/70 dark:border-zinc-800 dark:bg-zinc-900/80 dark:hover:border-emerald-700/60">
              <button onClick={() => setArticleId(a.id)} className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm">{a.title || "未命名"}</p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  {LANG_OPTS.find((o) => o.id === a.lang)?.label ?? a.lang} · {a.token_count} 词 · {fmtDate(a.created_at)}
                </p>
              </button>
              <button
                onClick={() => setConfirmDel(a.id)}
                title="删除文章"
                className="p-2 text-zinc-300 transition-colors hover:text-red-500 dark:text-zinc-600"
              >
                <TrashIcon size={15} />
              </button>
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={confirmDel !== null}
        title="删除这篇文章？"
        message="删除后不可恢复（生词标记和用户词典不受影响）。"
        confirmText="删除"
        onConfirm={() => {
          if (confirmDel !== null) deleteArticle(confirmDel).then(loadList).catch(() => {});
          setConfirmDel(null);
        }}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  );
}
