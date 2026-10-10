import { useState } from "react";
import { saveSettings, speedTest } from "../api";
import { useSettings } from "../SettingsContext";
import { SpinnerIcon } from "./icons";

/// 更新源选择器：两个预设（GitHub 直连 / gh-proxy 加速）+ 自定义 + 测速。
/// 收在「词典 → 安装」里，避免用户在设置列表与词典页之间来回跳
const UPDATE_PRESETS = [
  { id: "github", label: "GitHub", url: "" }, // 空 = 后端默认源
  { id: "ghproxy", label: "GitHub（gh-proxy 加速）", url: "https://gh-proxy.com/https://github.com/podic-dictionary/dict/releases/latest/download/" },
] as const;

export default function UpdateSourcePicker() {
  const { manifestUrl, reload } = useSettings();
  const [speed, setSpeed] = useState<Record<string, number | "fail">>({});
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  // 自定义源的草稿（失焦/按钮提交；选项行点了即存）
  const [draft, setDraft] = useState<string | null>(null);

  const presetId = UPDATE_PRESETS.find((p) => p.url === manifestUrl)?.id ?? "custom";
  const customUrl = presetId === "custom" ? manifestUrl : "";

  const onSpeedTest = async () => {
    setTesting(true);
    setSpeed({});
    const candidates: [string, string][] = UPDATE_PRESETS.map((p) => [p.id, p.url]);
    if (presetId === "custom" && customUrl.trim()) candidates.push(["custom", customUrl.trim()]);
    await Promise.all(
      candidates.map(async ([id, url]) => {
        const probe = url || "https://github.com/podic-dictionary/dict/releases/latest/download/";
        try {
          const ms = await speedTest(probe);
          setSpeed((s) => ({ ...s, [id]: ms }));
        } catch {
          setSpeed((s) => ({ ...s, [id]: "fail" }));
        }
      }),
    );
    setTesting(false);
  };

  const onSave = async (url: string) => {
    setSaving(true);
    setStatus("");
    try {
      await saveSettings({ manifest_url: url });
      await reload();
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
      onClick={() => void onSave(url)}
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
        <p className="text-xs text-zinc-400">点选项即保存；「测速」比较各源延迟后选择</p>
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
        {UPDATE_PRESETS.map((p) => row(p.id, p.label, p.url))}
        {row("custom", "自定义源（manifest 直链或发布目录）", customUrl || "https://")}
        {presetId === "custom" && (
          <div className="flex items-center gap-2">
            <input
              value={draft ?? manifestUrl}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (draft !== null && draft !== manifestUrl) void onSave(draft);
                setDraft(null);
              }}
              placeholder="https://…/（manifest.json 直链或 release 下载目录）"
              style={{ flex: "1 1 auto", minWidth: 0 }}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button
              onClick={() => {
                if (draft !== null && draft !== manifestUrl) void onSave(draft);
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
