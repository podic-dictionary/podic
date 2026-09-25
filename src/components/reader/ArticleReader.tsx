import { Fragment, forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ArticleFull, ReaderToken, WordStatus } from "../../types";
import { useTextSelection } from "../../hooks/useTextSelection";
import WordDrawer from "./WordDrawer";
import AnalyzeDrawer from "./AnalyzeDrawer";

/** AI 上下文：以被点词为锚的窗口句 + 前后文（前端各截 240 字，保证 ai_cache key 稳定） */
export interface AiContext {
  lang: string;
  sentence: string;
  before: string;
  after: string;
}

const CTX_CHARS = 240;
const WORD_CLS = "cursor-pointer rounded-sm";

function clsOf(status: WordStatus | undefined): string {
  // 未标记 = 待处理（reader-builder 的 fresh）：浅底 + 淡虚线下划线提示「还没打扫」，点认识的词清理
  if (!status) {
    return "underline decoration-emerald-300 decoration-dotted decoration-[1.5px] underline-offset-4 bg-emerald-50/90 active:bg-emerald-100 dark:decoration-emerald-700 dark:bg-emerald-950/60 dark:active:bg-emerald-900/70";
  }
  // 生词 = 复探关注（probe）：金虚线更醒目
  if (status === "new") {
    return "underline decoration-amber-400 decoration-dotted decoration-2 underline-offset-4 active:bg-amber-100/70 dark:decoration-amber-500 dark:active:bg-amber-950/50";
  }
  // 认识 = 打扫干净：恢复正常墨色
  return "";
}

export interface ArticleReaderHandle {
  /** statuses 变化后重刷词 class（DOM 直改，不触发 React 重渲染——长文下每次标记省一次全量 diff） */
  refresh: () => void;
}

export default forwardRef<ArticleReaderHandle, {
  article: ArticleFull;
  statusesRef: React.RefObject<Record<string, WordStatus>>;
  onMark: (norm: string, s: WordStatus | "none") => void;
  aiReady: boolean;
}>(function ArticleReader({ article, statusesRef, onMark, aiReady }, ref) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const sel = useTextSelection(bodyRef);
  const [word, setWord] = useState<{ norm: string; surface: string; ctx: AiContext; status?: WordStatus } | null>(null);
  const [analyze, setAnalyze] = useState<string | null>(null);

  const paragraphs = article.paragraphs;

  const refresh = () => {
    const root = bodyRef.current;
    if (!root) return;
    const st = statusesRef.current ?? {};
    root.querySelectorAll<HTMLElement>("span[data-norm]").forEach((el) => {
      el.className = `${WORD_CLS} ${clsOf(st[el.dataset.norm ?? ""])}`;
    });
  };
  useImperativeHandle(ref, () => ({ refresh }), []);
  // 文章上屏后刷一遍初始标记状态
  useLayoutEffect(refresh, [article]);

  // 以被点词为锚截 ±CTX_CHARS：单段落长文（PDF/网页复制常无换行）不能把整篇发给 AI
  const buildCtx = (pi: number, ti: number): AiContext => {
    const toks: ReaderToken[] = paragraphs[pi] ?? [];
    let lo = ti;
    let hi = ti;
    let n = 0;
    while (lo > 0 && n < CTX_CHARS) {
      lo--;
      n += toks[lo].t.length;
    }
    let m = 0;
    while (hi < toks.length - 1 && m < CTX_CHARS) {
      hi++;
      m += toks[hi].t.length;
    }
    return {
      lang: article.lang,
      sentence: toks.slice(lo, hi + 1).map((t) => t.t).join(""),
      before: paragraphs.slice(0, pi).map((p) => p.map((t) => t.t).join("")).join("\n").slice(-CTX_CHARS),
      after: paragraphs
        .slice(pi + 1)
        .map((p) => p.map((t) => t.t).join(""))
        .join("\n")
        .slice(0, CTX_CHARS),
    };
  };

  // 单容器事件委托：与划选互斥（选区未折叠时不触发点词）
  const onClick = (e: React.MouseEvent) => {
    const s = window.getSelection();
    if (s && !s.isCollapsed) return;
    const el = (e.target as HTMLElement).closest("[data-norm]") as HTMLElement | null;
    if (!el) return;
    const norm = el.getAttribute("data-norm") ?? "";
    if (!norm) return;
    const pEl = el.closest("[data-p]") as HTMLElement | null;
    const pi = pEl ? Number(pEl.getAttribute("data-p")) : 0;
    // 段落 DOM children 与 toks 一一对应（Fragment 不产生元素节点）
    const ti = pEl ? Array.prototype.indexOf.call(pEl.children, el) : 0;
    setWord({
      norm,
      surface: el.textContent ?? "",
      ctx: buildCtx(pi, ti),
      status: statusesRef.current?.[norm],
    });
  };

  return (
    <div>
      <div
        ref={bodyRef}
        onClick={onClick}
        className="space-y-4 font-dict text-[17px] leading-loose text-zinc-800 dark:text-zinc-200"
      >
        {paragraphs.map((toks, pi) => (
          <p
            key={pi}
            data-p={pi}
            // 长文兜底：浏览器跳过屏外段落的布局渲染
            className="[content-visibility:auto] [contain-intrinsic-size:auto 10em]"
          >
            {toks.map((t, ti) => {
              const node = t.is_word ? (
                <span key={ti} data-norm={t.norm} className={WORD_CLS}>
                  {t.t}
                </span>
              ) : (
                <span key={ti}>{t.t}</span>
              );
              return t.space_after ? (
                <Fragment key={ti}>
                  {node}{" "}
                </Fragment>
              ) : (
                node
              );
            })}
          </p>
        ))}
      </div>

      {/* 划选浮钮：portal 外的 fixed + 视口坐标（getBoundingClientRect 即视口系） */}
      {sel && (
        <button
          onPointerDown={(e) => e.preventDefault()} // 防止点按时丢选区
          onClick={() => {
            setAnalyze(sel.text);
            window.getSelection()?.removeAllRanges();
          }}
          style={{ top: Math.max(8, sel.rect.top - 40), left: Math.max(8, sel.rect.left) }}
          className="fixed z-40 rounded-full bg-violet-600 px-3.5 py-1.5 text-xs text-white shadow-lg hover:bg-violet-700"
        >
          ✦ AI 解析
        </button>
      )}

      <WordDrawer
        key={word?.norm ?? "none"}
        open={word !== null}
        lang={article.lang}
        surface={word?.surface ?? ""}
        norm={word?.norm ?? ""}
        ctx={word?.ctx ?? null}
        initialStatus={word?.status}
        onMark={onMark}
        aiReady={aiReady}
        onClose={() => setWord(null)}
      />

      <AnalyzeDrawer
        key={analyze ?? "none"}
        open={analyze !== null}
        lang={article.lang}
        text={analyze ?? ""}
        onClose={() => setAnalyze(null)}
      />
    </div>
  );
});

