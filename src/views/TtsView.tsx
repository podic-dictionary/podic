import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSettings, saveSettings, ttsCatalog, ttsCancelTask, ttsDeleteModel, ttsInstallStream,
  ttsModels, ttsTasks, type TtsCatalogModel, type TtsInstalled,
} from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import Seg from "../components/SegmentedControl";
import UpdateSourcePicker, { type SourcePreset } from "../components/UpdateSourcePicker";
import { ChevronLeftIcon, SpinnerIcon, TrashIcon } from "../components/icons";
import { langDisplayName } from "../langNames";
import { setDefaultSpeedCache, invalidateModelsCache, speak, hasShellBridge, unloadEngine } from "../tts/speech";

/** 与后端 DEFAULT_TTS_MANIFEST_URL / GHPROXY_PREFIX 一致（测速候选地址用） */
const TTS_MANIFEST_URL = "https://github.com/podic-dictionary/tts/releases/latest/download/tts-metainfo.json";

const TTS_PRESETS: readonly SourcePreset[] = [
  { id: "github", label: "GitHub", value: "github" },
  { id: "ghproxy", label: "GitHub（gh-proxy 加速）", value: "ghproxy" },
];

interface TtsSettingsState {
  source: { mode: string; custom_manifest_url: string };
  default_speed: string;
  languages: Record<string, { provider: string }>;
}

/** 试听例句（按模型首个支持语言） */
const SAMPLE_TEXT: Record<string, string> = {
  en: "Hello, this is a sample pronunciation.",
  fr: "Bonjour, ceci est un exemple de prononciation.",
  ja: "こんにちは、これは発音のサンプルです。",
};

const fmtMB = (bytes: number) => `${Math.max(1, Math.round(bytes / 1048576))} MB`;

const PHASE_LABEL: Record<string, string> = {
  download: "下载中",
  verify_archive: "校验压缩包",
  extract: "解压中",
  verify_files: "校验文件",
  commit: "提交安装",
};

/// 语音引擎（TTS）：端侧离线发音模型的下载源、默认语速与模型管理。
/// 已装模型的语言在查词页朗读时自动用引擎（系统无语音也能读），未装语言走系统 TTS
export default function TtsView({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<TtsSettingsState | null>(null);
  const [installed, setInstalled] = useState<TtsInstalled[] | null>(null);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof ttsCatalog>> | null>(null);
  const [catErr, setCatErr] = useState("");
  const [relLoading, setRelLoading] = useState(false);
  // 进行中的安装/更新（含 SSE 进度与后台续接的任务）：model_id → 进度
  const [installing, setInstalling] = useState<Record<string, { phase: string; downloaded: number; total: number; background?: boolean } | undefined>>({});
  const cancelFns = useRef<Record<string, () => void>>({});
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [delErr, setDelErr] = useState("");
  const [listenBusy, setListenBusy] = useState<string | null>(null);
  const inShell = hasShellBridge();

  const reloadModels = useCallback(() => {
    invalidateModelsCache();
    return ttsModels().then(setInstalled).catch(() => setInstalled([]));
  }, []);

  const reloadCatalog = useCallback(() => {
    setRelLoading(true);
    setCatErr("");
    return ttsCatalog()
      .then((c) => setCatalog(c))
      .catch((e) => setCatErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setRelLoading(false));
  }, []);

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s.tts ?? {
        source: { mode: "github", custom_manifest_url: "" },
        default_speed: "normal",
        languages: {},
      });
    }).catch(() => {});
    void reloadModels();
    void reloadCatalog();
  }, [reloadModels, reloadCatalog]);

  // 后台任务续接：页面重进时下载不中断（SSE 断开不取消），轮询任务状态直到结束
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const tasks = await ttsTasks();
        const running = tasks.filter((t) => t.state === "running");
        if (!stop && running.length > 0) {
          setInstalling((prev) => {
            const next = { ...prev };
            for (const t of running) {
              if (!next[t.model_id]) next[t.model_id] = { phase: "download", downloaded: 0, total: 0, background: true };
            }
            return next;
          });
          for (const t of running) {
            if (!cancelFns.current[t.model_id]) {
              cancelFns.current[t.model_id] = () => void ttsCancelTask(t.id).catch(() => {});
            }
          }
          window.setTimeout(poll, 2000);
          return;
        }
        const finished = tasks.filter((t) => t.state === "done" || t.state === "error");
        if (finished.length > 0) {
          const ids = new Set(finished.map((t) => t.model_id));
          setInstalling((prev) => {
            const next = { ...prev };
            let changed = false;
            for (const id of ids) {
              if (next[id]?.background) { delete next[id]; changed = true; }
            }
            return changed ? next : prev;
          });
          ids.forEach((id) => delete cancelFns.current[id]);
          void reloadModels();
        }
      } catch {
        if (!stop) window.setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { stop = true; };
  }, [reloadModels]);

  const saveTts = async (patch: Partial<TtsSettingsState>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    await saveSettings({ tts: next });
    setSettings(next);
    if (patch.default_speed) setDefaultSpeedCache(patch.default_speed === "slow" ? "slow" : "normal");
    if (patch.source) void reloadCatalog();
  };

  // 源选择器的值语义：github/ghproxy = 模式；其余字符串 = 自定义清单直链
  const sourceValue = settings
    ? settings.source.mode === "custom"
      ? settings.source.custom_manifest_url || "https://"
      : settings.source.mode
    : "github";
  const saveSource = async (v: string) => {
    if (v === "github" || v === "ghproxy") {
      await saveTts({ source: { mode: v, custom_manifest_url: "" } });
    } else {
      await saveTts({ source: { mode: "custom", custom_manifest_url: v.trim() } });
    }
  };
  const probeUrl = (v: string) =>
    v === "github" ? TTS_MANIFEST_URL
    : v === "ghproxy" ? `https://gh-proxy.com/${TTS_MANIFEST_URL}`
    : v;

  const startInstall = (modelId: string) => {
    setInstalling((p) => ({ ...p, [modelId]: { phase: "download", downloaded: 0, total: 0 } }));
    setCatErr("");
    const inst = ttsInstallStream(modelId, (ev) => {
      if (ev.type === "progress" && ev.phase) {
        setInstalling((p) => (p[modelId] ? { ...p, [modelId]: { phase: ev.phase!, downloaded: ev.downloaded ?? 0, total: ev.total ?? 0 } } : p));
      }
    });
    cancelFns.current[modelId] = () => void inst.cancel();
    inst.done
      .then(() => {
        // 装完让壳清模型缓存/卸载旧引擎，立即可试听新版本
        unloadEngine();
        return reloadModels();
      })
      .catch(() => { /* SSE error 事件已在下方统一处理 */ })
      .finally(() => {
        delete cancelFns.current[modelId];
        setInstalling((p) => {
          if (!p[modelId]) return p;
          const next = { ...p };
          delete next[modelId];
          return next;
        });
      });
    inst.done.catch((e) => {
      setCatErr(e instanceof Error ? e.message : String(e));
    });
  };

  const listenHandle = useRef<ReturnType<typeof speak>>(null);
  const listen = async (m: TtsCatalogModel, speed: "normal" | "slow") => {
    const key = `${m.model_id}:${speed}`;
    if (listenBusy === key) {
      // 播放中再点同一按钮 = 停止
      listenHandle.current?.cancel();
      return;
    }
    const lang = m.languages[0] ?? "en";
    const text = SAMPLE_TEXT[lang] ?? "Hello, this is a sample pronunciation.";
    setListenBusy(key);
    const h = speak({ text, lang, speed, provider: "offline" });
    if (!h) {
      setListenBusy(null);
      return;
    }
    listenHandle.current = h;
    await h.done;
    if (listenHandle.current === h) {
      listenHandle.current = null;
      setListenBusy(null);
    }
  };

  const doDelete = async (modelId: string) => {
    setDelErr("");
    // 引擎可能仍持有模型引用（后端引用>0 拒删）：先让壳卸载引擎再删
    unloadEngine();
    try {
      await ttsDeleteModel(modelId);
      await reloadModels();
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : String(e));
    }
  };

  const instOf = (id: string) => installed?.find((m) => m.model_id === id);
  const mb = (n: number) => fmtMB(n);

  return (
    <div className="mx-auto max-w-2xl p-4">
      <button
        onClick={onBack}
        className="flex w-full items-center gap-2 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50/60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-emerald-700 dark:hover:bg-emerald-950/40"
      >
        <ChevronLeftIcon size={16} className="text-emerald-600 dark:text-emerald-400" />
        返回设置
      </button>
      <div className="mt-3 flex items-center gap-2">
        <h1 className="text-lg font-medium">语音引擎</h1>
      </div>
      <p className="mt-1 text-xs text-zinc-400">
        端侧离线发音模型：装好后查词朗读自动使用（系统没有该语言语音也能读），不联网、不出网
      </p>

      {/* 默认语速 */}
      <section className="podic-card mt-4 rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
        <h2 className="text-sm font-medium text-zinc-500">默认朗读语速</h2>
        <p className="mt-0.5 text-xs text-zinc-400">查词页喇叭按钮的默认语速；播放中长按喇叭可临时用慢速重读</p>
        <div className="mt-2">
          <Seg
            value={(settings?.default_speed === "slow" ? "slow" : "normal")}
            options={[
              { id: "normal", label: "原速" },
              { id: "slow", label: "慢速" },
            ]}
            onChange={(v) => void saveTts({ default_speed: v })}
          />
        </div>
      </section>

      {/* 下载源 */}
      <section className="podic-card mt-4 rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
        <h2 className="text-sm font-medium text-zinc-500">模型下载源</h2>
        <div className="mt-2">
          <UpdateSourcePicker
            presets={TTS_PRESETS}
            value={sourceValue}
            onSave={saveSource}
            probeUrl={probeUrl}
            hint="语音模型的清单与包下载地址；国内网络建议 gh-proxy 加速"
          />
        </div>
      </section>

      {/* 模型列表 */}
      <section className="mt-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-500">语音模型</h2>
          <button
            onClick={() => { void reloadModels(); void reloadCatalog(); }}
            disabled={relLoading}
            className="flex items-center gap-1.5 text-xs text-emerald-600 hover:underline disabled:opacity-50 dark:text-emerald-400"
          >
            {relLoading && <SpinnerIcon />}
            刷新
          </button>
        </div>

        {catErr && (
          <p className="rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
            {catErr}
          </p>
        )}
        {delErr && (
          <p className="rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
            {delErr}
          </p>
        )}

        {catalog === null && !catErr && <p className="py-6 text-center text-sm text-zinc-400">清单加载中…</p>}
        {catalog !== null && catalog.models.length === 0 && (
          <p className="py-6 text-center text-sm text-zinc-400">当前源没有可用的语音模型</p>
        )}

        {(catalog?.models ?? []).map((m) => {
          const inst = instOf(m.model_id);
          const prog = installing[m.model_id];
          const updatable = inst && inst.revision < m.revision;
          return (
            <div key={m.model_id} className="podic-card rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {m.name || m.model_id}
                    {m.languages.map((l) => (
                      <span key={l} className="ml-1.5 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        {langDisplayName(l)}
                      </span>
                    ))}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-400">
                    v{m.version} · {mb(m.package.size_bytes)}{m.voices.length > 0 ? ` · ${m.voices.length} 音色` : ""}
                  </p>
                </div>
                {inst && (
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                    updatable
                      ? "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                      : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                  }`}>
                    {updatable ? `可更新（v${inst.version} → v${m.version}）` : `已安装 v${inst.version}`}
                  </span>
                )}
              </div>
              {m.notes && <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{m.notes}</p>}

              {/* 下载进度 */}
              {prog && (
                <div className="mt-2.5 rounded-xl border border-zinc-100 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-300">
                      <SpinnerIcon />
                      {PHASE_LABEL[prog.phase] ?? prog.phase}
                      {prog.phase === "download" && prog.total > 0 && ` ${Math.round((prog.downloaded / prog.total) * 100)}%`}
                      {prog.background && "（后台续接）"}
                    </span>
                    <button
                      onClick={() => cancelFns.current[m.model_id]?.()}
                      className="shrink-0 text-xs text-red-500 hover:underline"
                    >
                      取消
                    </button>
                  </div>
                  {prog.phase === "download" && prog.total > 0 && (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all"
                        style={{ width: `${Math.min(100, (prog.downloaded / prog.total) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* 操作区 */}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                {inst && inShell && (
                  <>
                    <button
                      onClick={() => void listen(m, "normal")}
                      disabled={listenBusy !== null && listenBusy !== `${m.model_id}:normal`}
                      className="rounded-lg border border-emerald-500/70 px-3 py-1.5 text-xs text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
                    >
                      {listenBusy === `${m.model_id}:normal` ? "停止" : "试听·原速"}
                    </button>
                    <button
                      onClick={() => void listen(m, "slow")}
                      disabled={listenBusy !== null && listenBusy !== `${m.model_id}:slow`}
                      className="rounded-lg border border-emerald-500/70 px-3 py-1.5 text-xs text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
                    >
                      {listenBusy === `${m.model_id}:slow` ? "停止" : "试听·慢速"}
                    </button>
                  </>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {!inst && !prog && (
                    <button
                      onClick={() => startInstall(m.model_id)}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700"
                    >
                      下载 {mb(m.package.size_bytes)}
                    </button>
                  )}
                  {updatable && !prog && (
                    <button
                      onClick={() => startInstall(m.model_id)}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-700"
                    >
                      更新
                    </button>
                  )}
                  {inst && !prog && (
                    <button
                      onClick={() => { setDelErr(""); setConfirmDel(m.model_id); }}
                      title="删除模型"
                      className="flex items-center gap-1 rounded-lg border border-red-400/60 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950"
                    >
                      <TrashIcon size={13} /> 删除
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* 已装但清单里没有（源切走/模型下架）：仍可删除 */}
        {(installed ?? []).filter((m) => !catalog?.models.some((c) => c.model_id === m.model_id)).map((m) => (
          <div key={m.model_id} className="podic-card rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{m.model_id}</p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  v{m.version} · {m.languages.map(langDisplayName).join(" / ")} · 不在当前源清单中
                </p>
              </div>
              <button
                onClick={() => { setDelErr(""); setConfirmDel(m.model_id); }}
                title="删除模型"
                className="flex shrink-0 items-center gap-1 rounded-lg border border-red-400/60 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950"
              >
                <TrashIcon size={13} /> 删除
              </button>
            </div>
          </div>
        ))}
      </section>

      <ConfirmDialog
        open={confirmDel !== null}
        title="删除语音模型？"
        message={`「${confirmDel ?? ""}」删除后对应语言回退系统 TTS（系统没有该语言语音则无法朗读），可随时重新下载。`}
        confirmText="删除"
        onConfirm={() => {
          if (confirmDel) void doDelete(confirmDel);
          setConfirmDel(null);
        }}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  );
}
