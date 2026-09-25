import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "../icons";

/**
 * 底部抽屉：portal 到 body 渲染——与 ConfirmDialog 同层（都在 main 的 zoom 作用域之外），
 * 不吃字体缩放也不会 zoom² 叠加，还能逃出 main 的 overflow 裁剪。
 */
export default function BottomSheet({
  open,
  onClose,
  title,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** 常驻底栏（不随内容滚动）：主操作放这里，拇指好够到 */
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative flex max-h-[78dvh] w-full max-w-2xl flex-col rounded-t-2xl bg-white shadow-2xl dark:bg-zinc-900">
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
          <button
            onClick={onClose}
            className="-m-1 p-1 text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-200"
            aria-label="关闭"
          >
            <XIcon size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
