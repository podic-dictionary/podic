import { useEffect, useState, type RefObject } from "react";

export interface SelInfo {
  text: string;
  /** 视口坐标（fixed 定位用） */
  rect: DOMRect;
}

/**
 * 划选检测：selectionchange 拖选过程中高频触发（WKWebView 尤甚），
 * 250ms 防抖只取最终态；滚动即隐藏。选区锚点必须在容器内才算数。
 * 注意滚动容器是 <main>（App 布局），不是 window。
 */
export function useTextSelection(
  containerRef: RefObject<HTMLElement | null>,
  minLen = 2,
): SelInfo | null {
  const [sel, setSel] = useState<SelInfo | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const read = () => {
      const root = containerRef.current;
      const s = window.getSelection();
      if (!root || !s || s.isCollapsed || !s.anchorNode || !root.contains(s.anchorNode)) {
        setSel(null);
        return;
      }
      const text = s.toString();
      if (text.trim().length < minLen) {
        setSel(null);
        return;
      }
      setSel({ text, rect: s.getRangeAt(0).getBoundingClientRect() });
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(read, 250);
    };
    document.addEventListener("selectionchange", schedule);
    // 滚动容器是 main：滚动即隐藏浮钮
    const main = containerRef.current?.closest("main");
    const hide = () => {
      window.clearTimeout(timer);
      setSel(null);
    };
    main?.addEventListener("scroll", hide, { passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", schedule);
      main?.removeEventListener("scroll", hide);
    };
  }, [containerRef, minLen]);

  return sel;
}
