import { useSettings } from "../SettingsContext";

/// 模型下拉：所有 Provider 的模型合成 "provider/model" 单选，随时切换
export default function ModelPicker({
  providerId,
  model,
  onChange,
}: {
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
}) {
  const { providers, loaded } = useSettings();

  if (loaded && providers.length === 0) {
    return (
      <span className="text-xs text-zinc-400">
        未配置 AI Provider，请到「设置」页添加
      </span>
    );
  }

  const opts = providers.flatMap((p) =>
    (p.models.length ? p.models : p.active_model ? [p.active_model] : []).map((m) => ({
      v: `${p.id}::${m}`,
      // 填了展示名称就只显示别名（真实模型名见 title）
      label: `${p.name}/${p.labels?.[m] || m}`,
    })),
  );
  // 当前组合不在列表里时（如模型刚被删）补一项兜底，避免下拉显示错位
  const cur = `${providerId}::${model}`;
  if (providerId && !opts.some((o) => o.v === cur)) {
    opts.unshift({ v: cur, label: `${providerId}/${model}` });
  }

  return (
    <select
      value={cur}
      title={model || undefined}
      onChange={(e) => {
        const v = e.target.value;
        const idx = v.indexOf("::");
        onChange(v.slice(0, idx), v.slice(idx + 2));
      }}
      className="w-auto min-w-24 max-w-[60vw] rounded-lg border border-zinc-200 bg-transparent px-1.5 py-1 text-xs dark:border-zinc-700"
    >
      {opts.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
