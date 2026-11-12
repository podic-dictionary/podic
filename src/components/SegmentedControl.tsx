/** 分段单选控件（原 SettingsView 内的 Seg 上移，练习设置页复用） */
export default function Seg<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  /** 整组禁用（如每日一句的偏好还没从服务端读到） */
  disabled?: boolean;
}) {
  return (
    <div className={`flex gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800 ${disabled ? "opacity-50" : ""}`}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          disabled={disabled}
          aria-pressed={value === o.id}
          className={`flex-1 rounded-lg px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed ${
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
