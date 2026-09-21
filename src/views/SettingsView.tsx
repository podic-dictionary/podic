import { useEffect, useState } from "react";
import { attributions, saveSettings, testProvider } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import {
  ChevronLeftIcon, EyeIcon, EyeOffIcon, PlusIcon, TrashIcon, XIcon, ZapIcon,
} from "../components/icons";
import PacksView from "./PacksView";
import { useSettings, type FontScale, type Hand, type ThemeMode } from "../SettingsContext";

interface Draft {
  id: string;
  name: string;
  protocol: "openai" | "anthropic";
  base_url: string;
  api_key: string;
  models: string[]; // 逐行列表输入
  active_model: string; // 不在表单展示，保存时透传
}

const emptyDraft = (): Draft => ({
  id: `p-${Date.now()}`,
  name: "",
  protocol: "openai",
  base_url: "",
  api_key: "",
  models: [],
  active_model: "",
});

const inputCls =
  "w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-emerald-600";

const THEME_OPTS: { id: ThemeMode; label: string }[] = [
  { id: "light", label: "亮色" },
  { id: "dark", label: "暗色" },
  { id: "system", label: "跟随系统" },
];

const FONT_OPTS: { id: FontScale; label: string }[] = [
  { id: "small", label: "小" },
  { id: "default", label: "标准" },
  { id: "large", label: "大" },
];

const HAND_OPTS: { id: Hand; label: string }[] = [
  { id: "right", label: "右手" },
  { id: "left", label: "左手" },
];

function Seg<T extends string>({
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

function Row({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-2xl border border-zinc-200/80 bg-white/85 px-4 py-3.5 text-left backdrop-blur transition-all duration-300 hover:border-emerald-300/70 hover:shadow-[0_10px_28px_-18px_rgb(5_150_105/0.35)] dark:border-zinc-800 dark:bg-zinc-900/80 dark:hover:border-emerald-700/60"
    >
      <span className="text-sm">{label}</span>
      <span className="flex items-center gap-1 text-xs text-zinc-400">
        {hint}
        <span aria-hidden>›</span>
      </span>
    </button>
  );
}

/// 二级页头部：返回按钮独立一行、样式醒目（系统返回手势/返回键同语义）
function SubHeader({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack: () => void;
  right?: React.ReactNode;
}) {
  return (
    <>
      <button
        onClick={onBack}
        className="flex w-full items-center gap-2 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50/60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-emerald-700 dark:hover:bg-emerald-950/40"
      >
        <ChevronLeftIcon size={16} className="text-emerald-600 dark:text-emerald-400" />
        返回设置
      </button>
      <div className="mt-3 flex items-center gap-2">
        <h1 className="text-lg font-medium">{title}</h1>
        {right}
      </div>
    </>
  );
}

export type SettingsSub = null | "ai" | "about" | "updates" | "packs";

export default function SettingsView({
  sub,
  setSub,
}: {
  sub: SettingsSub;
  setSub: (s: SettingsSub) => void;
}) {
  const {
    providers, manifestUrl, loaded, reload,
    theme, setTheme, fontScale, setFontScale,
    hand, setHand,
  } = useSettings();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [manifest, setManifest] = useState("");
  const [status, setStatus] = useState("");
  const [testing, setTesting] = useState<string>("");
  const [testRes, setTestRes] = useState<Record<string, { ok: boolean; msg: string } | undefined>>({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [sources, setSources] = useState<{ name: string; url: string; license: string }[]>([]);

  useEffect(() => {
    if (loaded) {
      setDrafts(
        providers.map((p) => ({
          ...p,
          api_key: p.has_key ? "••••••••" : "",
          models: [...p.models],
        })),
      );
      setManifest(manifestUrl);
    }
  }, [loaded, providers, manifestUrl]);

  // 只在进入「关于」时拉取致谢数据（本视图常驻挂载，别在启动期白发请求）
  useEffect(() => {
    if (sub !== "about") return;
    attributions().then((r) => setSources(r.sources)).catch(() => {});
  }, [sub]);

  const patch = (id: string, kv: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...kv } : d)));

  const onSave = async (): Promise<boolean> => {
    // 校验：填了内容的 Provider 必须有名称；全空的草稿静默跳过
    // （api_key 为掩码 "••••" 时表示已存有 key，要算作有内容，避免丢配置）
    const nonEmpty = (d: Draft) =>
      Boolean(d.name.trim() || d.base_url.trim() || d.api_key.trim() || d.models.some((m) => m.trim()));
    for (const d of drafts) {
      if (nonEmpty(d) && !d.name.trim()) {
        setStatus("请先填写 Provider 名称再保存");
        return false;
      }
    }
    setStatus("保存中…");
    try {
      await saveSettings({
        providers: drafts
          .filter(nonEmpty)
          .map((d) => {
            const models = d.models.map((m) => m.trim()).filter(Boolean);
            return {
              id: d.id,
              name: d.name.trim(),
              protocol: d.protocol,
              base_url: d.base_url.trim(),
              api_key: d.api_key.includes("•") ? "" : d.api_key,
              models,
              // 表单没有单独的默认模型入口：跟随模型列表第一项
              active_model: models[0] ?? "",
            };
          }),
        manifest_url: manifest,
      });
      await reload();
      setStatus("已保存 ✓");
      setTimeout(() => setStatus(""), 2000);
      return true;
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const onTest = async (id: string) => {
    setTesting(id);
    try {
      const d = drafts.find((x) => x.id === id)!;
      // 先保存再测试，确保用最新配置；模型显式取当前输入列表的第一项
      // （active_model 只在保存时同步，测试不能依赖它，否则新填的模型发不出去）
      if (!(await onSave())) return;
      setStatus("");
      const model = d.models.map((m) => m.trim()).filter(Boolean)[0];
      const r = await testProvider(id, model);
      setTestRes((m) => ({
        ...m,
        [id]: r.ok
          ? { ok: true, msg: `已连通，${model || "（未指定模型）"} · ${r.latency_ms}ms` }
          : { ok: false, msg: `失败：${r.error}` },
      }));
    } catch (e) {
      setTestRes((m) => ({
        ...m,
        [id]: { ok: false, msg: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setTesting("");
    }
  };

  // ---- 二级页：AI Provider ----
  if (sub === "ai") {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <SubHeader
          title="AI Provider"
          onBack={() => setSub(null)}
          right={
            <button
              onClick={() => setDrafts((ds) => [...ds, emptyDraft()])}
              className="ml-auto flex shrink-0 items-center gap-1 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700"
            >
              <PlusIcon size={13} /> 添加
            </button>
          }
        />
        <p className="mt-1 text-xs text-zinc-400">OpenAI 兼容 / Anthropic 双协议</p>

        <div className="mt-3 space-y-3">
          {drafts.map((d) => {
            const tr = testRes[d.id];
            return (
              <div
                key={d.id}
                className="podic-card rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80"
              >
                {/* 头部：名称做标题 + 协议 + 删除 */}
                <div className="flex items-center gap-2">
                  <input
                    value={d.name}
                    onChange={(e) => patch(d.id, { name: e.target.value })}
                    placeholder="未命名 Provider"
                    className="min-w-0 flex-1 border-none bg-transparent p-0 text-base font-medium outline-none placeholder:font-normal placeholder:text-zinc-300 dark:placeholder:text-zinc-600"
                  />
                  <select
                    value={d.protocol}
                    onChange={(e) => patch(d.id, { protocol: e.target.value as "openai" | "anthropic" })}
                    className="shrink-0 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs outline-none dark:border-zinc-700 dark:bg-zinc-950"
                  >
                    <option value="openai">OpenAI 兼容</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                  <button
                    onClick={() => setConfirmDelete(d.id)}
                    title="删除"
                    className="shrink-0 rounded-lg p-2 text-zinc-300 transition-colors hover:bg-red-50 hover:text-red-500 dark:text-zinc-600 dark:hover:bg-red-950"
                  >
                    <TrashIcon size={16} />
                  </button>
                </div>

                <div className="mt-3 space-y-2.5">
                  <div>
                    <p className="mb-1 text-xs text-zinc-400">Base URL</p>
                    <input
                      value={d.base_url}
                      onChange={(e) => patch(d.id, { base_url: e.target.value })}
                      placeholder={d.protocol === "anthropic" ? "留空 = 官方 api.anthropic.com" : "如 https://api.openai.com/v1"}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-zinc-400">API Key</p>
                    <div className="relative">
                      <input
                        value={d.api_key}
                        onChange={(e) => patch(d.id, { api_key: e.target.value })}
                        placeholder="sk-…"
                        type={showKey[d.id] ? "text" : "password"}
                        className={`${inputCls} pr-10`}
                      />
                      <button
                        onClick={() => setShowKey((s) => ({ ...s, [d.id]: !s[d.id] }))}
                        title={showKey[d.id] ? "隐藏" : "显示"}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400"
                      >
                        {showKey[d.id] ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-zinc-400">模型列表</p>
                    <div className="space-y-1.5">
                      {d.models.map((m, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <input
                            value={m}
                            onChange={(e) =>
                              patch(d.id, { models: d.models.map((x, j) => (j === i ? e.target.value : x)) })
                            }
                            placeholder="model-name"
                            className={inputCls}
                          />
                          <button
                            onClick={() => patch(d.id, { models: d.models.filter((_, j) => j !== i) })}
                            title="移除"
                            className="shrink-0 rounded-lg p-2 text-zinc-300 transition-colors hover:bg-red-50 hover:text-red-500 dark:text-zinc-600 dark:hover:bg-red-950"
                          >
                            <XIcon size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => patch(d.id, { models: [...d.models, ""] })}
                      className="mt-1.5 flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
                    >
                      <PlusIcon size={12} /> 添加模型
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                  <button
                    onClick={() => onTest(d.id)}
                    disabled={testing === d.id}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-500/70 px-3 py-1.5 text-xs text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
                  >
                    <ZapIcon size={13} />
                    {testing === d.id ? "测试中…" : "测试连接"}
                  </button>
                  {tr && (
                    <span className={`min-w-0 flex-1 text-xs ${tr.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}`}>
                      {tr.msg}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {drafts.length === 0 && (
            <p className="py-6 text-center text-sm text-zinc-400">还没有配置，点右上角「添加」</p>
          )}
        </div>

        <div className="action-row mt-4">
          <button
            onClick={onSave}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700"
          >
            保存设置
          </button>
          {status && <span className="text-xs text-zinc-500">{status}</span>}
        </div>

        <ConfirmDialog
          open={confirmDelete !== null}
          title="删除这个 AI Provider？"
          message="删除并保存后该配置不可恢复（API Key 需重新填写）。"
          onConfirm={() => {
            setDrafts((ds) => ds.filter((x) => x.id !== confirmDelete));
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      </div>
    );
  }

  // ---- 二级页：词典包管理 ----
  if (sub === "packs") {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <SubHeader title="词典包管理" onBack={() => setSub(null)} />
        <div className="mt-3">
          <PacksView />
        </div>
      </div>
    );
  }

  // ---- 二级页：词典包更新源 ----
  if (sub === "updates") {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <SubHeader title="词典包更新源" onBack={() => setSub(null)} />
        <p className="mt-1 text-xs text-zinc-400">
          指向 manifest.json 的直链，用于「词典包」页的在线检查更新（如 GitHub/Gitea release 直链）
        </p>
        <input
          value={manifest}
          onChange={(e) => setManifest(e.target.value)}
          placeholder="manifest.json 直链"
          className="mt-3 w-full rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
        />
        <div className="action-row mt-4">
          <button
            onClick={onSave}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700"
          >
            保存设置
          </button>
          {status && <span className="text-xs text-zinc-500">{status}</span>}
        </div>
      </div>
    );
  }

  // ---- 二级页：关于 ----
  if (sub === "about") {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <SubHeader title="关于" onBack={() => setSub(null)} />

        <div className="mt-4 podic-card rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
          <div className="flex items-center justify-between">
            <span className="text-sm">Podic 词典</span>
            <span className="text-xs text-zinc-400">版本 v{__APP_VERSION__}</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-zinc-400">
            英 / 法 / 日 ↔ 中文开源词典。离线词典包 + 可自配 LLM 的 AI 能力（讲解 / 例句 / 翻译 / 兜底）。
          </p>
        </div>

        <section className="mt-4 rounded-2xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="font-medium">数据来源与致谢</h2>
          <ul className="mt-2 space-y-1 text-zinc-500">
            {sources.map((s) => (
              <li key={s.name}>
                {s.name}（{s.license}）—{" "}
                <a href={s.url} target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline dark:text-emerald-400">
                  {s.url}
                </a>
              </li>
            ))}
            {sources.length === 0 && <li>未安装词典包</li>}
          </ul>
        </section>
      </div>
    );
  }

  // ---- 主页面 ----
  return (
    <div className="mx-auto max-w-2xl p-4">
      <h1 className="text-lg font-medium">设置</h1>

      {/* 外观 */}
      <section className="mt-4 space-y-4 podic-card rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
        <div>
          <h2 className="text-sm font-medium text-zinc-500">色彩模式</h2>
          <div className="mt-2">
            <Seg value={theme} options={THEME_OPTS} onChange={setTheme} />
          </div>
        </div>
        <div>
          <h2 className="text-sm font-medium text-zinc-500">页面字体大小</h2>
          <div className="mt-2">
            <Seg value={fontScale} options={FONT_OPTS} onChange={setFontScale} />
          </div>
        </div>
        <div>
          <h2 className="text-sm font-medium text-zinc-500">操作手性</h2>
          <p className="mt-0.5 text-xs text-zinc-400">按钮与高频入口靠哪一侧（右手时底部 tab 中「查词」在最右）</p>
          <div className="mt-2">
            <Seg value={hand} options={HAND_OPTS} onChange={setHand} />
          </div>
        </div>
      </section>

      {/* AI / 词典包 / 更新源 / 关于入口 */}
      <section className="mt-4 space-y-2">
        <Row
          label="AI Provider"
          hint={providers.length > 0 ? `${providers.length} 个` : "未配置"}
          onClick={() => setSub("ai")}
        />
        <Row label="词典包管理" hint="导入 · 更新 · 卸载" onClick={() => setSub("packs")} />
        <Row label="词典包更新源" hint={manifest ? "已配置" : "未配置"} onClick={() => setSub("updates")} />
        <Row label="关于 / 数据来源" onClick={() => setSub("about")} />
      </section>
    </div>
  );
}
