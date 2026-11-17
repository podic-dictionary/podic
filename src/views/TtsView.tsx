import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSettings, saveSettings, ttsCatalog, ttsCancelTask, ttsDeleteModel, ttsInstallStream,
  ttsModels, ttsTasks, type TtsCatalogModel, type TtsInstalled,
} from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import Seg from "../components/SegmentedControl";
import { parseHash } from "../lib/router";
import UpdateSourcePicker, { type SourcePreset } from "../components/UpdateSourcePicker";
import { ChevronLeftIcon, SpinnerIcon, TrashIcon } from "../components/icons";
import { langDisplayName } from "../langNames";
import { setDefaultSpeedCache, setSlowRateCache, setLangPrefsCache, invalidateModelsCache, listSystemVoices, pickSystemVoice, slowRate, speak, systemVoiceAvailable, hasShellBridge, unloadEngine } from "../tts/speech";

/** 与后端 DEFAULT_TTS_MANIFEST_URL / GHPROXY_PREFIX 一致（测速候选地址用） */
const TTS_MANIFEST_URL = "https://github.com/podic-dictionary/tts/releases/latest/download/tts-metainfo.json";

const TTS_PRESETS: readonly SourcePreset[] = [
  { id: "github", label: "GitHub", value: "github" },
  { id: "ghproxy", label: "GitHub（gh-proxy 加速）", value: "ghproxy" },
];

interface TtsSettingsState {
  source: { mode: string; custom_manifest_url: string };
  default_speed: string;
  slow_rate?: number;
  languages: Record<string, { provider: string; voice?: string }>;
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
  // SSE 仍活跃的模型（区分 SSE 断线兜底与真后台任务）
  const sseModels = useRef<Set<string>>(new Set());
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [delErr, setDelErr] = useState("");
  const [listenBusy, setListenBusy] = useState<string | null>(null);
  const inShell = hasShellBridge();

  // 三 tab（朗读/模型/更新源）：hash 驱动（#/settings/tts/models、…/source），
  // 刷新/直链可恢复；切走再切回时 hash 已变（如 #/search），用 sessionStorage
  // 记住停留的 tab（会话级，重启不残留）
  const readTab = (): "speech" | "models" | "source" => {
    const t = parseHash().path[2];
    if (t === "models" || t === "source") return t;
    try {
      const s = sessionStorage.getItem("podic.tts.tab");
      if (s === "models" || s === "source") return s;
    } catch { /* 隐私模式 sessionStorage 不可用 */ }
    return "speech";
  };
  const [tab, setTabState] = useState<"speech" | "models" | "source">(readTab);
  useEffect(() => {
    const onHash = () => {
      const t = parseHash().path[2];
      if (t === "models" || t === "source") {
        setTabState(t);
        try { sessionStorage.setItem("podic.tts.tab", t); } catch { /* 同上 */ }
      } else {
        // 第三段消失 = 回朗读 tab（点 tab 后 hashchange 到这里；直链兜底同）。
        // 存储不动：这里只是「当前页回朗读」，别抹掉深层记忆
        setTabState("speech");
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const setTab = (t: "speech" | "models" | "source") => {
    // 立即切状态：hash 第三段消失（回朗读）时 onHash 的分支靠不上，不能只依赖事件
    setTabState(t);
    window.location.hash = `#/settings/tts${t === "speech" ? "" : `/${t}`}`;
    try { sessionStorage.setItem("podic.tts.tab", t); } catch { /* 同上 */ }
  };

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
        slow_rate: 0.75,
        languages: {},
      });
    }).catch(() => {});
    void reloadModels();
    void reloadCatalog();
  }, [reloadModels, reloadCatalog]);

  // 任务轮询兜底：SSE 断开不取消服务端下载（gh-proxy 会掐长连接，WebView 里
  // SSE 中途断掉是常态），页面打开期间持续轮询，恢复进度显示并在任务结束时刷新模型列表
  useEffect(() => {
    let stop = false;
    let seenRunning = new Set<string>();
    const tick = async () => {
      try {
        const tasks = await ttsTasks();
        if (stop) return;
        const running = tasks.filter((t) => t.state === "running");
        for (const t of running) {
          if (!cancelFns.current[t.model_id]) {
            cancelFns.current[t.model_id] = () => void ttsCancelTask(t.id).catch(() => {});
          }
        }
        setInstalling((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const t of running) {
            const sseAlive = sseModels.current.has(t.model_id);
            if (!next[t.model_id]) {
              // 页面重进/SSE 未建立：显示后台续接
              next[t.model_id] = { phase: "download", downloaded: 0, total: 0, background: true };
              changed = true;
            } else if (!sseAlive && !next[t.model_id]!.background) {
              // SSE 已断（finally 清了标记）但任务还在跑：标记后台续接
              next[t.model_id] = { ...next[t.model_id]!, background: true };
              changed = true;
            }
          }
          for (const t of tasks) {
            if (t.state !== "running" && next[t.model_id]?.background) {
              delete next[t.model_id];
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        const runningIds = new Set(running.map((t) => t.id));
        if ([...seenRunning].some((id) => !runningIds.has(id))) {
          void reloadModels(); // 有任务从运行变为结束
        }
        seenRunning = runningIds;
      } catch {
        // 服务端暂时不可达：等下个周期
      }
    };
    void tick();
    const iv = window.setInterval(tick, 3000);
    return () => {
      stop = true;
      window.clearInterval(iv);
    };
  }, [reloadModels]);

  const saveTts = async (patch: Partial<TtsSettingsState>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    await saveSettings({ tts: next });
    setSettings(next);
    if (patch.default_speed) setDefaultSpeedCache(patch.default_speed === "slow" ? "slow" : "normal");
    if (typeof patch.slow_rate === "number") setSlowRateCache(patch.slow_rate);
    if (patch.languages) setLangPrefsCache(patch.languages);
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
    sseModels.current.add(modelId);
    cancelFns.current[modelId] = () => void inst.cancel();
    inst.done
      .then(() => {
        // 装完让壳清模型缓存/卸载旧引擎，立即可试听新版本
        unloadEngine();
        return reloadModels();
      })
      .catch(() => { /* SSE error 事件已在下方统一处理 */ })
      .finally(() => {
        sseModels.current.delete(modelId);
        delete cancelFns.current[modelId];
        // SSE 断线兜底：任务可能仍在服务端跑，这里不清进度条，
        // 交给轮询标记「后台续接」或在其结束时清掉
        setInstalling((p) => {
          if (!p[modelId] || p[modelId]!.background) return p;
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
    // 壳的朗读是串行队列：不先停旧的，新的要等旧句播完才响
    listenHandle.current?.cancel();
    const rate = speed === "slow" ? await slowRate() : undefined;
    const h = speak({ text, lang, speed, rate, provider: "offline" });
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

  /// 按语言试听：用该行当前选择的引擎（自动 = 模型优先无则系统）播一句例句
  const listenLang = async (lang: string) => {
    const key = `lang:${lang}`;
    if (listenBusy === key) {
      listenHandle.current?.cancel();
      return;
    }
    const raw = settings?.languages?.[lang]?.provider;
    const provider = raw === "system" || raw === "offline" ? raw : "auto";
    setListenBusy(key);
    listenHandle.current?.cancel();
    const h = speak({ text: SAMPLE_TEXT[lang] ?? SAMPLE_TEXT.en, lang, speed: "normal", provider });
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

  /// 引擎选择行：已装模型的语言 ∪ 系统 TTS 可用的语言（都没有的语言无从选）
  const engineLangs = Array.from(new Set([
    ...(installed ?? []).flatMap((m) => m.languages),
    ...Object.keys(SAMPLE_TEXT).filter((l) => systemVoiceAvailable(l) === true),
  ])).sort();

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

      {/* tab 切换：朗读（语速/倍率/用法）/ 模型（下载·更新·删除）/ 更新源 */}
      <div className="mt-3 flex gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800">
        {(["speech", "models", "source"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm transition-colors ${
              tab === t
                ? "bg-white text-emerald-600 shadow-sm dark:bg-zinc-950 dark:text-emerald-400"
                : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            {t === "speech" ? "朗读" : t === "models" ? "模型" : "更新源"}
          </button>
        ))}
      </div>

      {tab === "speech" && (
      <>
      {/* 默认语速 */}
      <section className="podic-card mt-4 rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
        <h2 className="text-sm font-medium text-zinc-500">默认朗读语速</h2>
        <p className="mt-0.5 text-xs text-zinc-400">无倍率标喇叭使用的语速；带倍率标的喇叭永远是慢速</p>
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

      {/* 慢速倍率 */}
      <section className="podic-card mt-4 rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
        <h2 className="text-sm font-medium text-zinc-500">慢速朗读倍率</h2>
        <p className="mt-0.5 text-xs text-zinc-400">
          带倍率标的慢速喇叭按钮（词条、例句、每日一句通用）按此倍率放慢，跟读学习发音用；试听·慢速同此倍率，改完按钮上的倍率即时刷新
        </p>
        {/* 步进器（0.2~0.9、步进 0.05，整数运算避免浮点尾差）：窄屏放不下九段横排 */}
        <div className="mt-2 flex items-center gap-3">
          <div className="flex items-center overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700">
            <button
              onClick={() => void saveTts({ slow_rate: Math.max(20, Math.round((settings?.slow_rate ?? 0.75) * 100) - 5) / 100 })}
              disabled={(settings?.slow_rate ?? 0.75) <= 0.2}
              aria-label="降低倍率"
              className="px-3.5 py-2 text-lg leading-none text-zinc-500 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              −
            </button>
            <span className="min-w-16 text-center text-sm font-medium tabular-nums text-zinc-700 dark:text-zinc-200">
              {(settings?.slow_rate ?? 0.75).toFixed(2)}×
            </span>
            <button
              onClick={() => void saveTts({ slow_rate: Math.min(90, Math.round((settings?.slow_rate ?? 0.75) * 100) + 5) / 100 })}
              disabled={(settings?.slow_rate ?? 0.75) >= 0.9}
              aria-label="提高倍率"
              className="px-3.5 py-2 text-lg leading-none text-zinc-500 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              +
            </button>
          </div>
          <span className="text-xs text-zinc-400">0.20×–0.90×</span>
        </div>
      </section>

      {/* 按语言选引擎：App 内本地引擎合成；网页版由 server 侧合成（同款模型） */}
      <section className="podic-card mt-4 rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
        <h2 className="text-sm font-medium text-zinc-500">按语言选择引擎</h2>
        <p className="mt-0.5 text-xs text-zinc-400">
          自动：装了端侧模型用模型（{inShell ? "离线、不联网" : "由本机服务端合成"}），没装走系统 TTS；离线引擎 = 只用下载的模型（未装时朗读报错不回退）；系统 TTS = 强制走系统
        </p>
        <div className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
          {engineLangs.length === 0 && <p className="py-2 text-xs text-zinc-400">暂无可选语言（未装模型且系统无语音）</p>}
          {engineLangs.map((l) => {
            const rawPref = settings?.languages?.[l]?.provider;
            const hasModel = Boolean(installed?.some((m) => m.languages.includes(l)));
            // 模型已删（或从未装）：离线档无从生效，回落自动展示（保存的偏好
            // 不动，装回模型即恢复）
            const pref = rawPref === "system" || (rawPref === "offline" && hasModel) ? rawPref : "auto";
            return (
              <div key={l} className="py-2.5 first:pt-1 last:pb-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="w-16 shrink-0 text-sm text-zinc-600 dark:text-zinc-300">{langDisplayName(l)}</span>
                  {/* 自动 */}
                  <button
                    onClick={() => void saveTts({ languages: { ...(settings?.languages ?? {}), [l]: { provider: "auto" } } })}
                    aria-pressed={pref === "auto"}
                    className={`rounded-lg border px-2 py-1 text-xs whitespace-nowrap transition-colors ${
                      pref === "auto"
                        ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-300"
                        : "border-zinc-200 text-zinc-500 hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                    }`}
                  >
                    自动
                  </button>
                  {/* 自动档的实际引擎一眼可见：有已装模型走端侧，否则系统 */}
                  {pref === "auto" && (
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                      installed?.some((m) => m.languages.includes(l))
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}>
                      → {installed?.some((m) => m.languages.includes(l)) ? "离线引擎" : "系统 TTS"}
                    </span>
                  )}
                  {/* 离线引擎：装了模型才有这个档 */}
                  {hasModel && (
                  <button
                    onClick={() => void saveTts({ languages: { ...(settings?.languages ?? {}), [l]: { provider: "offline" } } })}
                    aria-pressed={pref === "offline"}
                    className={`rounded-lg border px-2 py-1 text-xs whitespace-nowrap transition-colors ${
                      pref === "offline"
                        ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-300"
                        : "border-zinc-200 text-zinc-500 hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                    }`}
                  >
                    离线引擎
                  </button>
                  )}
                  {/* 系统 TTS 与音色连体：音色属于系统 TTS，非该档置灰 */}
                  {inShell ? (
                    <button
                      onClick={() => void saveTts({ languages: { ...(settings?.languages ?? {}), [l]: { provider: "system" } } })}
                      aria-pressed={pref === "system"}
                      className={`rounded-lg border px-2 py-1 text-xs whitespace-nowrap transition-colors ${
                        pref === "system"
                          ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-300"
                          : "border-zinc-200 text-zinc-500 hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                      }`}
                    >
                      系统 TTS
                    </button>
                  ) : (
                    <div className={`flex items-stretch overflow-hidden rounded-lg border transition-colors ${
                      pref === "system"
                        ? "border-emerald-500 dark:border-emerald-600"
                        : "border-zinc-200 dark:border-zinc-700"
                    }`}>
                      <button
                        onClick={() => void saveTts({ languages: { ...(settings?.languages ?? {}), [l]: { provider: "system" } } })}
                        aria-pressed={pref === "system"}
                        className={`border-r border-zinc-200 bg-white px-2 py-1 text-xs whitespace-nowrap transition-colors dark:border-zinc-700 dark:bg-zinc-900 ${
                          pref === "system"
                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                            : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                        }`}
                      >
                        系统 TTS
                      </button>
                      <select
                        value={settings?.languages?.[l]?.voice ?? pickSystemVoice(l)?.name ?? ""}
                        onChange={(e) => {
                          const prev = settings?.languages?.[l] ?? { provider: "auto" };
                          void saveTts({ languages: { ...(settings?.languages ?? {}), [l]: { ...prev, voice: e.target.value || undefined } } });
                        }}
                        disabled={pref !== "system"}
                        title={pref === "system" ? "系统 TTS 的音色" : "切到「系统 TTS」后可选择音色"}
                        className="min-w-0 max-w-28 truncate border-0 bg-white px-1.5 text-xs text-zinc-600 outline-none disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-900 dark:text-zinc-300"
                      >
                        {listSystemVoices(l).map((v) => (
                          <option key={v.name} value={v.name}>{v.name}</option>
                        ))}
                        {!listSystemVoices(l).length && <option value="">（无系统语音）</option>}
                      </select>
                    </div>
                  )}
                  <button
                    onClick={() => void listenLang(l)}
                    disabled={listenBusy !== null && listenBusy !== `lang:${l}`}
                    className="ml-auto shrink-0 rounded-lg border border-emerald-500/70 px-3 py-1.5 text-xs text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
                  >
                    {listenBusy === `lang:${l}` ? "停止" : "试听"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-zinc-400">试听按该行当前选择播一句例句，两个引擎对比着选</p>
      </section>

      {/* 用法说明 */}
      <section className="podic-card mt-4 rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
        <h2 className="text-sm font-medium text-zinc-500">朗读按钮怎么用</h2>
        <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-zinc-400">
          <li>· 喇叭：按「默认语速」朗读，播放中再点停止</li>
          <li>· 带倍率标的喇叭（如 0.75×）：按「慢速倍率」放慢重读，适合跟读辨音；倍率可在本页调整</li>
          <li>· 词条头词、每条例句、每日一句的朗读按钮都是这两个</li>
        </ul>
      </section>
      </>
      )}

      {tab === "source" && (
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
      )}

      {tab === "models" && (
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
                {inst && (
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
      )}

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
