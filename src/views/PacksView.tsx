import { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import {
  checkUpdates,
  importPack,
  installPackStream,
  listPacks,
  removePack,
  type InstallProgress,
  type PackUpdate,
} from "../api";
import type { PackInfo } from "../types";

const LANG_NAMES: Record<string, string> = { en: "英语", fr: "法语", ja: "日语" };

export default function PacksView() {
  const [packs, setPacks] = useState<PackInfo[]>([]);
  const [updates, setUpdates] = useState<PackUpdate[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ lang: string; p: InstallProgress } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PackInfo | null>(null);

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

  const onCheckUpdates = async () => {
    setBusy(true);
    setError("");
    try {
      const u = await checkUpdates();
      setUpdates(u);
      if (u.length === 0) setError("已是最新版本");
      setTimeout(() => setError((prev) => (prev === "已是最新版本" ? "" : prev)), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onInstall = async (u: PackUpdate) => {
    setError("");
    const { done } = installPackStream(u, (p) => setProgress({ lang: u.lang, p }));
    try {
      await done;
      await refresh();
      setUpdates((us) => us?.filter((x) => x.lang !== u.lang) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
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

      {/* 在线更新 */}
      <div className="action-row mt-3">
        <button
          onClick={onCheckUpdates}
          disabled={busy}
          className="rounded-lg border border-emerald-500 px-3 py-1.5 text-sm text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
        >
          检查更新
        </button>
        {updates && updates.length > 0 && (
          <div className="mt-2 space-y-2">
            {updates.map((u) => (
              <div
                key={u.lang}
                className="flex items-center justify-between rounded-xl border border-violet-200 bg-violet-50/50 px-4 py-3 dark:border-violet-900 dark:bg-violet-950/30"
              >
                <p className="text-sm">
                  {LANG_NAMES[u.lang] ?? u.lang} 词典包可更新：
                  <span className="text-zinc-400">
                    v{u.current_version} → v{u.latest_version}
                  </span>
                </p>
                {progress?.lang === u.lang ? (
                  <div className="w-40">
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
                ) : (
                  <button
                    onClick={() => onInstall(u)}
                    className="rounded-lg bg-violet-600 px-3 py-2.5 text-sm text-white hover:bg-violet-700"
                  >
                    更新
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
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
                {LANG_NAMES[p.lang] ?? p.lang}
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
        title={`删除${LANG_NAMES[confirmRemove?.lang ?? ""] ?? ""}词典包？`}
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
