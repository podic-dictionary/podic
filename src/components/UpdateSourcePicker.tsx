import { useState } from "react";
import { saveSettings, speedTest } from "../api";
import { useSettings } from "../SettingsContext";
import { SpinnerIcon } from "./icons";

/// 更新源选择器：预设（GitHub 直连 / gh-proxy 加速）+ 自定义 + 测速。
/// 默认用于词典（收在「词典 → 安装」里）；props 参数化后 TTS 源选择复用同一交互

const DICT_DEFAULT = "https://github.com/podic-dictionary/dict/releases/latest/download/";
const UPDATE_PRESETS: readonly SourcePreset[] = [
  { id: "github", label: "GitHub", value: "" }, // 空 = 后端默认源
  { id: "ghproxy", label: "GitHub（gh-proxy 加速）", value: "https://gh-proxy.com/" + DICT_DEFAULT },
];

export interface SourcePreset {
  id: string;
  label: string;
  /** 值语义由调用方定：词典 = manifest 目录 URL，TTS = 源模式（github/ghproxy） */
  value: string;
}

export default function UpdateSourcePicker({
  presets = UPDATE_PRESETS,
  value,
  onSave,
  probeUrl,
  hint = "点选项即保存；「测速」比较各源延迟后选择",
}: {
  presets?: readonly SourcePreset[];
  /** 当前值；缺省用词典设置的 manifest_url */
  value?: string;
  /** 保存回调；缺省走词典的 manifest_url 保存 */
  onSave?: (v: string) => Promise<void>;
  /** 由值算测速地址；缺省 = 值本身或词典默认目录 */
  probeUrl?: (v: string) => string;
  hint?: string;
}) {
  const settings = useSettings();
  const manifestUrl = value ?? settings.manifestUrl;
  const reload = settings.reload;
  const [speed, setSpeed] = useState<Record<string, number | "fail">>({});
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  // 自定义源的草稿（失焦/按钮提交；选项行点了即存）
  const [draft, setDraft] = useState<string | null>(null);

  const presetId = presets.find((p) => p.value === manifestUrl)?.id ?? "custom";
  const customUrl = presetId === "custom" ? manifestUrl : "";

  const onSpeedTest = async () => {
    setTesting(true);
    setSpeed({});
    const candidates: [string, string][] = presets.map((p) => [p.id, p.value]);
    if (presetId === "custom" && customUrl.trim()) candidates.push(["custom", customUrl.trim()]);
    const toUrl = probeUrl ?? ((v: string) => v || DICT_DEFAULT);
    await Promise.all(
      candidates.map(async ([id, v]) => {
        try {
          const ms = await speedTest(toUrl(v));
          setSpeed((s) => ({ ...s, [id]: ms }));
        } catch {
          setSpeed((s) => ({ ...s, [id]: "fail" }));
        }
      }),
    );
    setTesting(false);
  };

  const onSaveValue = onSave ?? (async (url: string) => {
    await saveSettings({ manifest_url: url });
    await reload();
  });
  const doSave = async (v: string) => {
    setSaving(true);
    setStatus("");
    try {
      await onSaveValue(v);
      setStatus("已保存 ✓");
      window.setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const fastest = Object.entries(speed)
    .filter(([, v]) => v !== "fail")
    .sort((a, b) => (a[1] as number) - (b[1] as number))[0]?.[0];

  const row = (id: string, label: string, url: string) => (
    <button
      key={id}
      onClick={() => void doSave(url)}
      disabled={saving}
      className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition-colors ${
        presetId === id
          ? "border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/30"
          : "border-zinc-200 bg-white/80 hover:border-emerald-300 dark:border-zinc-700 dark:bg-zinc-900/70"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className={presetId === id ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}>
          {presetId === id ? "●" : "○"}
        </span>
        {label}
        {fastest === id && <span className="text-xs text-emerald-600 dark:text-emerald-400">最快 ✓</span>}
      </span>
      {speed[id] !== undefined && (
        <span className={`text-xs ${speed[id] === "fail" ? "text-red-500" : "text-zinc-400"}`}>
          {speed[id] === "fail" ? "不可用" : `${speed[id]} ms`}
        </span>
      )}
    </button>
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-400">{hint}</p>
        <button
          onClick={() => void onSpeedTest()}
          disabled={testing}
          className="shrink-0 rounded-lg border border-emerald-500 px-3 py-1.5 text-xs text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
        >
          {testing ? (
            <span className="inline-flex items-center gap-1.5">
              <SpinnerIcon /> 测速中…
            </span>
          ) : (
            "测速"
          )}
        </button>
      </div>
      <div className="mt-2 space-y-2">
        {presets.map((p) => row(p.id, p.label, p.value))}
        {row("custom", "自定义源（manifest 直链或发布目录）", customUrl || "https://")}
        {presetId === "custom" && (
          <div className="flex items-center gap-2">
            <input
              value={draft ?? manifestUrl}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft !== null && draft !== manifestUrl) void doSave(draft);
                setDraft(null);
              }}
              placeholder="https://…/（manifest.json 直链或 release 下载目录）"
              style={{ flex: "1 1 auto", minWidth: 0 }}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              onClick={() => {
                if (draft !== null && draft !== manifestUrl) void doSave(draft);
                setDraft(null);
              }}
              disabled={saving || (draft !== null && draft === manifestUrl)}
              className="shrink-0 rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              保存
            </button>
          </div>
        )}
      </div>
      {status && <p className="mt-2 text-xs text-zinc-500">{status}</p>}
    </div>
  );
}
