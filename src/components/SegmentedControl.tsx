/** 分段单选控件（原 SettingsView 内的 Seg 上移，练习设置页复用） */
export default function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`flex-1 rounded-lg px-3 py-1.5 text-sm transition-colors ${
            value === o.id
              ? "bg-white text-emerald-600 shadow-sm dark:bg-zinc-950 dark:text-emerald-400"
              : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
