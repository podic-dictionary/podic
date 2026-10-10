import { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import {
  fetchCatalog,
  importPack,
  installPackStream,
  listPacks,
  removePack,
  type CatalogItem,
  type InstallProgress,
} from "../api";
import type { PackInfo } from "../types";
import { useSettings } from "../SettingsContext";


export default function PacksView() {
  const { languages } = useSettings();
  const langName = (code: string) => languages.find((x) => x.code === code)?.name ?? code;
  const [packs, setPacks] = useState<PackInfo[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ lang: string; p: InstallProgress } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PackInfo | null>(null);
  const [customUrl, setCustomUrl] = useState("");

  const refresh = useCallback(async () => {
    try {
      setPacks((await listPacks()).packs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onOpenCatalog = async () => {
    setBusy(true);
    setError("");
    try {
      setCatalog(await fetchCatalog());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 安装/更新走同一端点；刷新后同步目录里的已装版本标记
  const onInstall = async (u: { lang: string; url: string; sha256?: string }) => {
    setError("");
    const { done } = installPackStream({ lang: u.lang, url: u.url, sha256: u.sha256 ?? "" }, (p) =>
      setProgress({ lang: u.lang, p }),
    );
    try {
      await done;
      await refresh();
      setCatalog((cs) =>
        cs?.map((c) =>
          c.lang === u.lang
            ? { ...c, installed_version: packs.find((p2) => p2.lang === u.lang)?.version ?? c.version }
            : c,
        ) ?? null,
      );
      if (u.lang === "custom") setCustomUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  const onInstallUrl = async () => {
    const url = customUrl.trim();
    if (!url) return;
    await onInstall({ lang: "custom", url });
  };

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    try {
      for (const f of files) await importPack(f);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (lang: string) => {
    setBusy(true);
    try {
      await removePack(lang);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-lg font-medium">词典包</h1>
      <p className="mt-1 text-sm text-zinc-400">
        词典数据以独立包形式安装。从本地导入 .db 文件，或在「词典包更新源」配置在线更新。
      </p>

      {error && <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">{error}</p>}

      {/* 在线词典包：更新源的全量目录（含未安装语言）+ 自定义 URL 安装 */}
      <div className="action-row mt-3">
        <button
          onClick={onOpenCatalog}
          disabled={busy}
          className="rounded-lg border border-emerald-500 px-3 py-1.5 text-sm text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
        >
          在线词典包
        </button>
        {catalog && catalog.length === 0 && (
          <span className="text-sm text-zinc-400">更新源里没有词典包</span>
        )}
      </div>
      {catalog && catalog.length > 0 && (
        <div className="mt-2 space-y-2">
          {catalog.map((c) => {
            const installed = c.installed_version ?? null;
            const canUpdate = installed !== null && installed !== c.version;
            return (
              <div
                key={c.lang}
                className="flex items-center justify-between rounded-xl border border-violet-200 bg-violet-50/50 px-4 py-3 dark:border-violet-900 dark:bg-violet-950/30"
              >
                <div className="min-w-0">
                  <p className="text-sm">
                    {langName(c.lang)}
                    <span className="ml-1 text-zinc-400">
                      v{c.version}
                      {installed
                        ? canUpdate
                          ? `（已装 v${installed}，可更新）`
                          : "（已装最新）"
                        : c.entry_count
                          ? ` · ${(c.entry_count / 1000).toFixed(1)}k 词条${c.size ? ` · ${Math.max(1, Math.round(c.size / 1048576))}MB` : ""}`
                          : ""}
                    </span>
                  </p>
                  {c.notes && <p className="mt-0.5 text-xs text-zinc-400">{c.notes}</p>}
                </div>
                {progress?.lang === c.lang ? (
                  <div className="w-40 shrink-0">
                    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                      <div
                        className="h-full bg-violet-500 transition-all"
                        style={{
                          width:
                            progress.p.phase === "download" && progress.p.total > 0
                              ? `${Math.round((progress.p.downloaded / progress.p.total) * 100)}%`
                              : "100%",
                        }}
                      />
                    </div>
                    <p className="mt-1 text-right text-xs text-zinc-400">
                      {progress.p.phase === "download"
                        ? `下载中 ${Math.round(progress.p.downloaded / 1048576)}MB`
                        : progress.p.phase === "extract"
                          ? "解压中…"
                          : "校验中…"}
                    </p>
                  </div>
                ) : canUpdate || installed === null ? (
                  <button
                    onClick={() => onInstall(c)}
                    className="shrink-0 rounded-lg bg-violet-600 px-3 py-2.5 text-sm text-white hover:bg-violet-700"
                  >
                    {canUpdate ? "更新" : "安装"}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* 自定义 URL 安装：.db.gz 或 .db 直链（sha256 不填则跳过校验） */}
      <div className="action-row mt-2">
        <input
          value={customUrl}
          onChange={(e) => setCustomUrl(e.target.value)}
          placeholder="自定义 URL 安装（.db.gz / .db 直链）"
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          onClick={onInstallUrl}
          disabled={!customUrl.trim() || progress !== null}
          className="rounded-lg border border-violet-500 px-3 py-2 text-sm text-violet-600 hover:bg-violet-50 disabled:opacity-50 dark:hover:bg-violet-950"
        >
          下载安装
        </button>
      </div>

      <div className="mt-4 space-y-3">
        {packs.length === 0 && !busy && (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-400 dark:border-zinc-700">
            还没有安装任何词典包
          </p>
        )}
        {packs.map((p) => (
          <div
            key={p.lang}
            className="flex items-center justify-between gap-3 podic-card rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {langName(p.lang)}
                <span className="ml-2 text-xs text-zinc-400">
                  {p.pack_id} v{p.version}
                </span>
              </p>
              <p className="mt-0.5 text-sm text-zinc-400">
                {p.entry_count.toLocaleString()} 词条 · 构建于 {p.built_at.slice(0, 10)}
              </p>
              {p.sources?.length > 0 && (
                <p className="mt-1 break-words text-xs text-zinc-400">
                  数据来源：{p.sources.map((s) => `${s.name} (${s.license})`).join("、")}
                </p>
              )}
            </div>
            <button
              onClick={() => setConfirmRemove(p)}
              disabled={busy}
              className="shrink-0 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm text-red-500 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950"
            >
              删除
            </button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmRemove !== null}
        title={`删除${langName(confirmRemove?.lang ?? "")}词典包？`}
        message="将移除本地词典文件，查词时该语言不可用。可稍后重新导入或在线更新恢复。"
        onConfirm={async () => {
          const lang = confirmRemove!.lang;
          setConfirmRemove(null);
          await onRemove(lang);
        }}
        onCancel={() => setConfirmRemove(null)}
      />

      <div className="action-row mt-4">
        <label className="inline-block cursor-pointer rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50">
        {busy ? "处理中…" : "导入本地词典包"}
        <input
          type="file"
          accept=".db"
          multiple
          className="hidden"
          onChange={(e) => onImport(e.target.files)}
        />
        </label>
      </div>
    </div>
  );
}
