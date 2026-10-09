import type { Lang, LanguageConfig } from "../types";

/** 顶栏语言切换：注册语言动态列表；无包语言（纯 user_dict/LLM 补全）正常可选 */
export default function LanguageSwitcher({
  value,
  onChange,
  languages,
}: {
  value: Lang;
  onChange: (l: Lang) => void;
  languages: LanguageConfig[];
}) {
  return (
    <div className="flex gap-1">
      {languages.map((l) => (
        <button
          key={l.code}
          onClick={() => onChange(l.code)}
          aria-pressed={value === l.code}
          title={l.name}
          className={`rounded-lg px-4 py-1.5 text-[24px] leading-none md:px-3 md:py-1 md:text-sm transition-colors ${
            value === l.code
              ? "bg-emerald-600 text-white"
              : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          }`}
        >
          {l.name.slice(0, 2)}
        </button>
      ))}
    </div>
  );
}
