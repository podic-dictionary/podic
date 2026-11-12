/** 分段单选控件（原 SettingsView 内的 Seg 上移，练习设置页复用）。
 * 窄屏五段选项放不下时不换行字（验收反馈：三字标签被挤成两行） */
export default function Seg<T extends string>({
  value,
  options,
  onChange,
  disabled,
  fill = true,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  /** 整组禁用（如每日一句的偏好还没从服务端读到） */
  disabled?: boolean;
  /** 选项是否拉伸填满整行（两段选项保持旧观感）；false = 按内容宽度左对齐，
   * 末项不贴容器边（验收反馈：每日一句五段难度「低频」贴右缘） */
  fill?: boolean;
}) {
  const grow = fill ? "flex-1" : "shrink-0";
  return (
    <div className={`flex gap-1 overflow-x-auto rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800 ${disabled ? "opacity-50" : ""}`}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          disabled={disabled}
          aria-pressed={value === o.id}
          className={`${grow} min-w-fit rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors disabled:cursor-not-allowed ${
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
