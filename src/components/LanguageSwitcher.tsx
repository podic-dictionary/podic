import { useEffect, useRef, useState } from "react";
import type { Lang, LanguageConfig } from "../types";

/** tab 简写：short 优先，缺省取 name 前两字符 */
export const langShort = (l: LanguageConfig) => l.short?.trim() || l.name.slice(0, 2);

/** 常见语言预设（添加语言下拉用；与后端 prompt LANG_NAMES 同源语义） */
export const LANG_PRESETS: LanguageConfig[] = [
  { code: "de", name: "德语", short: "德" },
  { code: "es", name: "西班牙语", short: "西" },
  { code: "ko", name: "韩语", short: "韩" },
  { code: "zh", name: "中文", short: "中" },
  { code: "ru", name: "俄语", short: "俄" },
  { code: "pt", name: "葡萄牙语", short: "葡" },
  { code: "it", name: "意大利语", short: "意" },
  { code: "ar", name: "阿拉伯语", short: "阿" },
  { code: "tr", name: "土耳其语", short: "土" },
  { code: "vi", name: "越南语", short: "越" },
  { code: "th", name: "泰语", short: "泰" },
  { code: "hi", name: "印地语", short: "印" },
  { code: "id", name: "印尼语", short: "尼" },
  { code: "nl", name: "荷兰语", short: "荷" },
  { code: "pl", name: "波兰语", short: "波" },
  { code: "sv", name: "瑞典语", short: "瑞" },
  { code: "uk", name: "乌克兰语", short: "乌" },
  { code: "el", name: "希腊语", short: "希" },
  { code: "la", name: "拉丁语", short: "拉" },
  { code: "he", name: "希伯来语", short: "伯" },
];

/** 顶栏语言切换：前 3 个注册语言作快捷 tab（当前语言不在其中时顶替末位），
 * 其余收进「更多」下拉；下拉里明确标示当前语言 */
export default function LanguageSwitcher({
  value,
  onChange,
  languages,
}: {
  value: Lang;
  onChange: (l: Lang) => void;
  languages: LanguageConfig[];
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  if (languages.length === 0) return null;

  const QUICK = 3;
  // 当前语言不在快捷位时顶替末位，保证当前语言永远可见
  const current = languages.find((l) => l.code === value) ?? languages[0];
  let quick = languages.slice(0, QUICK);
  if (!quick.some((l) => l.code === current.code)) {
    quick = [...quick.slice(0, QUICK - 1), current];
  }
  const rest = languages.filter((l) => !quick.some((q) => q.code === l.code));

  const tabCls = (active: boolean) =>
    `rounded-lg px-4 py-1.5 text-[24px] leading-none md:px-3 md:py-1 md:text-sm transition-colors ${
      active
        ? "bg-emerald-600 text-white"
        : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
    }`;

  return (
    <div ref={boxRef} className="relative flex items-center gap-1">
      {quick.map((l) => (
        <button
          key={l.code}
          onClick={() => onChange(l.code)}
          aria-pressed={value === l.code}
          title={l.name}
          className={tabCls(value === l.code)}
        >
          {langShort(l)}
        </button>
      ))}
      {rest.length > 0 && (
        <button
          onClick={() => setOpen(!open)}
          title="更多语言"
          aria-expanded={open}
          className={`rounded-lg px-3 py-1.5 text-[20px] leading-none transition-colors md:py-1 md:text-sm ${
            open
              ? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              : "text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          }`}
        >
          ⋯
        </button>
      )}
      {open && (
        <div
          className="podic-card absolute right-0 top-full z-30 mt-2 w-44 overflow-hidden rounded-2xl bg-white/95 py-1 backdrop-blur-md dark:bg-zinc-900/95"
        >
          {languages.map((l) => (
            <button
              key={l.code}
              onClick={() => {
                onChange(l.code);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors ${
                value === l.code
                  ? "bg-emerald-50/80 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
              }`}
            >
              <span className="text-sm">{l.name}</span>
              {value === l.code && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
