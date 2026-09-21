import type { Lang } from "../types";

const LANGS: { id: Lang; label: string }[] = [
  { id: "en", label: "英" },
  { id: "fr", label: "法" },
  { id: "ja", label: "日" },
];

export default function LanguageSwitcher({
  value,
  onChange,
}: {
  value: Lang;
  onChange: (l: Lang) => void;
}) {
  return (
    <div className="flex gap-1">
      {LANGS.map((l) => (
        <button
          key={l.id}
          onClick={() => onChange(l.id)}
          aria-pressed={value === l.id}
          className={`rounded-lg px-4 py-1.5 text-[24px] leading-none md:px-3 md:py-1 md:text-sm transition-colors ${
            value === l.id
              ? "bg-emerald-600 text-white"
              : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
