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

const fmtSize = (bytes?: number) =>
  bytes && bytes > 0 ? `${Math.max(1, Math.round(bytes / 1048576))}MB` : "";

export default function PacksView() {
  const { languages } = useSettings();
  const langName = (code: string) => languages.find((x) => x.code === code)?.name ?? code;
  const [packs, setPacks] = useState<PackInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ lang: string; p: InstallProgress } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PackInfo | null>(null);
  /** 检查到的可更新/可安装项（确认框：版本、说明、体积告知后再下载） */
  const [confirmInstall, setConfirmInstall] = useState<CatalogItem | null>(null);
  /** 「更新所有语言包」的运行态说明（正在检查/下载哪个语言） */
  const [batchNote, setBatchNote] = useState("");
  const [customUrl, setCustomUrl] = useState("");

  // 已添加但没有词典包的语言（虚线占位 + 单独检查）
  const noPackLangs = languages.filter((l) => !packs.some((p) => p.lang === l.code));

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

  const flash = (msg: string) => {
    setError(msg);
    window.setTimeout(() => setError((prev) => (prev === msg ? "" : prev)), 2500);
  };

  /** 检查单个语言：源里有无词典包、已装版本是否落后；有则弹确认框告知详情 */
  const onCheck = async (lang: string) => {
    setBusy(true);
    setError("");
    try {
      const cat = await fetchCatalog();
      const item = cat.find((c) => c.lang === lang);
      if (!item) {
        flash(`更新源里没有「${langName(lang)}」的词典包`);
        return;
      }
      const cur = packs.find((p) => p.lang === lang)?.version;
      if (cur && cur === item.version) {
        flash(`「${langName(lang)}」已是最新版本 v${cur}`);
        return;
      }
      setConfirmInstall(item);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const install = async (u: { lang: string; url: string; sha256?: string }) => {
    setError("");
    const { done } = installPackStream(
      { lang: u.lang, url: u.url, sha256: u.sha256 ?? "" },
      (p) => setProgress({ lang: u.lang, p }),
    );
    try {
      await done;
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setProgress(null);
    }
  };

  const onConfirmInstall = async () => {
    const item = confirmInstall;
    setConfirmInstall(null);
    if (item) await install(item);
  };

  /** 更新所有：已装包升级 + 已添加无包语言装包，逐个检查逐个安装 */
  const onUpdateAll = async () => {
    setBusy(true);
    setError("");
    let done = 0;
    try {
      const cat = await fetchCatalog();
      const langs = [...packs.map((p) => p.lang), ...noPackLangs.map((l) => l.code)];
      for (const lang of langs) {
        const item = cat.find((c) => c.lang === lang);
        if (!item) continue;
        const cur = packs.find((p) => p.lang === lang)?.version;
        if (cur === item.version) continue;
        setBatchNote(
          `正在安装「${langName(lang)}」v${item.version}${fmtSize(item.size) ? `（${fmtSize(item.size)}）` : ""}…`,
        );
        if (await install(item)) done += 1;
      }
      flash(done > 0 ? `已更新 ${done} 个词典包` : "全部语言已是最新");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchNote("");
      setBusy(false);
    }
  };

  const onInstallUrl = async () => {
    const url = customUrl.trim();
    if (!url) return;
    if (await install({ lang: "custom", url })) setCustomUrl("");
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

  const installing = progress !== null || busy;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-lg font-medium">词典包</h1>
      <p className="mt-1 text-sm text-zinc-400">
        词典数据以独立包形式安装；每个包可单独检查更新，或底部一键更新全部。
      </p>

      {error && <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">{error}</p>}
      {batchNote && <p className="mt-3 text-sm text-violet-500">{batchNote}</p>}

      <div className="mt-3 space-y-2">
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
            {progress?.lang === p.lang ? (
              <div className="w-36 shrink-0">
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
              <div className="flex shrink-0 gap-1">
                <button
                  onClick={() => onCheck(p.lang)}
                  disabled={installing}
                  className="whitespace-nowrap rounded-lg border border-emerald-500 px-3 py-2.5 text-sm text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
                >
                  检查更新
                </button>
                <button
                  onClick={() => setConfirmRemove(p)}
                  disabled={installing}
                  className="whitespace-nowrap rounded-lg px-3 py-2.5 text-sm text-red-500 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950"
                >
                  删除
                </button>
              </div>
            )}
          </div>
        ))}

        {/* 已添加但无词典包的语言：虚线占位，检查源里有则直接装 */}
        {noPackLangs.map((l) => (
          <div
            key={l.code}
            className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-zinc-300 bg-transparent p-4 dark:border-zinc-700"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-zinc-500">{l.name}</p>
              <p className="mt-0.5 text-sm text-zinc-400">
                无词典包（查词走 AI 补全，可点「检查」从更新源安装）
              </p>
            </div>
            {progress?.lang === l.code ? (
              <p className="shrink-0 text-xs text-zinc-400">
                {progress.p.phase === "download" ? "下载中…" : "安装中…"}
              </p>
            ) : (
              <button
                onClick={() => onCheck(l.code)}
                disabled={installing}
                className="shrink-0 whitespace-nowrap rounded-lg border border-emerald-500 px-3 py-2.5 text-sm text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
              >
                检查
              </button>
            )}
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

      <ConfirmDialog
        open={confirmInstall !== null}
        title={
          confirmInstall && packs.some((p) => p.lang === confirmInstall.lang)
            ? `更新${langName(confirmInstall?.lang ?? "")}词典包？`
            : `安装${langName(confirmInstall?.lang ?? "")}词典包？`
        }
        message={
          confirmInstall
            ? [
                packs.some((p) => p.lang === confirmInstall.lang)
                  ? `v${packs.find((p) => p.lang === confirmInstall.lang)?.version} → v${confirmInstall.version}`
                  : `v${confirmInstall.version}${confirmInstall.entry_count ? ` · ${confirmInstall.entry_count.toLocaleString()} 词条` : ""}`,
                fmtSize(confirmInstall.size) ? `下载体积 ${fmtSize(confirmInstall.size)}` : "",
                confirmInstall.notes ?? "",
              ]
                .filter(Boolean)
                .join("\n")
            : ""
        }
        confirmText="下载安装"
        onConfirm={() => void onConfirmInstall()}
        onCancel={() => setConfirmInstall(null)}
      />

      {/* 底部操作：一键更新全部 + 自定义 URL（手性布局：右利手主按钮在右） */}
      <div className="action-row mt-4">
        <button
          onClick={onUpdateAll}
          disabled={installing}
          className="rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          更新所有语言包
        </button>
        <label className="inline-block cursor-pointer rounded-xl border border-emerald-500 px-4 py-2 text-sm text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950">
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
      <div className="action-row mt-2">
        <button
          onClick={() => void onInstallUrl()}
          disabled={!customUrl.trim() || installing}
          className="rounded-xl bg-violet-600 px-4 py-2 text-sm text-white hover:bg-violet-700 disabled:opacity-50"
        >
          下载安装
        </button>
        {/* .action-row > * 的 flex:0 0 auto 特异性高于 tailwind flex-1，用 inline style 撑满 */}
        <input
          value={customUrl}
          onChange={(e) => setCustomUrl(e.target.value)}
          placeholder="自定义 URL 安装（.db.gz / .db 直链）"
          style={{ flex: "1 1 auto", minWidth: 0 }}
          className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
    </div>
  );
}
