import { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import NoticeDialog from "../components/NoticeDialog";
import { SpinnerIcon } from "../components/icons";
import {
  fetchCatalog,
  importPack,
  installPackStream,
  listPacks,
  removePack,
  type CatalogItem,
} from "../api";
import type { PackInfo } from "../types";
import { useSettings } from "../SettingsContext";
import UpdateSourcePicker from "../components/UpdateSourcePicker";
import { parseHash } from "../lib/router";
import { setInstall, useInstall } from "../lib/installStore";

const fmtSize = (bytes?: number) =>
  bytes && bytes > 0 ? `${Math.max(1, Math.round(bytes / 1048576))}MB` : "";

export default function PacksView() {
  // 三 tab（列表/安装/更新源）：hash 驱动（#/settings/packs/install、…/source），刷新/直链可恢复
  const [tab, setTabState] = useState<"list" | "install" | "source">(() => {
    const t = parseHash().path[2];
    return t === "install" || t === "source" ? t : "list";
  });
  useEffect(() => {
    const onHash = () => {
      const t = parseHash().path[2];
      setTabState(t === "install" || t === "source" ? t : "list");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const setTab = (t: "list" | "install" | "source") => {
    window.location.hash = `#/settings/packs${t === "list" ? "" : `/${t}`}`;
  };

  const { languages } = useSettings();
  const langName = (code: string) => languages.find((x) => x.code === code)?.name ?? code;
  const [packs, setPacks] = useState<PackInfo[]>([]);
  // 下载进度走全局 store：切页面不丢，词典页外由 App 顶栏镜像显示
  const installState = useInstall();
  const progress = installState ? { lang: installState.lang, p: installState.p } : null;
  const [confirmRemove, setConfirmRemove] = useState<PackInfo | null>(null);
  /** 检查到的可更新/可安装项（确认框：版本、说明、体积告知后再下载） */
  const [confirmInstall, setConfirmInstall] = useState<CatalogItem | null>(null);
  /** 结果通知（弹窗）：操作结果必须在操作处可感知，不能只写在页面顶端 */
  const [notice, setNotice] = useState<{ title: string; message?: string } | null>(null);

  // 各操作独立的进行态：不能共用——「检查中」不该让无关的导入按钮显示处理中
  const [checking, setChecking] = useState<string | null>(null); // 正在检查的语言码
  const [updatingAll, setUpdatingAll] = useState(false);
  const [importing, setImporting] = useState(false);
  const [urlBusy, setUrlBusy] = useState(false);
  const [customUrl, setCustomUrl] = useState("");

  // 已添加但没有词典的语言（虚线占位 + 单独检查）
  const noPackLangs = languages.filter((l) => !packs.some((p) => p.lang === l.code));
  const installing = progress !== null;

  // 源清单（静默后台拉一次）：更新源里有该语言的词典即可更新；自导入的包
  // （pack_id 不同）在确认框里明示「将替换」，由用户把关而不是直接隐藏入口
  const [catalogData, setCatalogData] = useState<CatalogItem[] | null>(null);
  useEffect(() => {
    fetchCatalog().then(setCatalogData).catch(() => {});
  }, []);
  const hasInSource = (lang: string) =>
    catalogData == null || catalogData.some((c) => c.lang === lang);

  const refresh = useCallback(async () => {
    try {
      setPacks((await listPacks()).packs);
    } catch (e) {
      setNotice({ title: "词典列表加载失败", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** 检查单个语言：源里有无词典、已装版本是否落后；有则弹确认框告知详情 */
  const onCheck = async (lang: string) => {
    setChecking(lang);
    try {
      const cat = await fetchCatalog();
      const item = cat.find((c) => c.lang === lang);
      if (!item) {
        setNotice({ title: `没有「${langName(lang)}」词典`, message: "更新源里没有该语言的词典包，可稍后再试或从本地导入" });
        return;
      }
      const installed = packs.find((p) => p.lang === lang);
      const cur = installed?.version;
      if (cur && cur === item.version) {
        setNotice({ title: `「${langName(lang)}」已是最新`, message: `当前版本 v${cur}` });
        return;
      }
      setConfirmInstall(item);
    } catch (e) {
      setNotice({ title: "检查失败", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(null);
    }
  };

  const install = async (u: { lang: string; url: string; sha256?: string }) => {
    const label = u.lang === "custom" ? "自定义词典" : langName(u.lang);
    const { done } = installPackStream(
      { lang: u.lang, url: u.url, sha256: u.sha256 ?? "" },
      (p) => setInstall({ lang: u.lang, label, p }),
    );
    try {
      await done;
      await refresh();
      return true;
    } catch (e) {
      setNotice({ title: "安装失败", message: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setInstall(null);
    }
  };

  const onConfirmInstall = async () => {
    const item = confirmInstall;
    setConfirmInstall(null);
    if (item) await install(item);
  };

  /** 更新所有：已装词典升级 + 已添加无词典语言装包，逐个检查逐个安装 */
  const onUpdateAll = async () => {
    setUpdatingAll(true);
    let done = 0;
    const failures: string[] = [];
    try {
      const cat = await fetchCatalog();
      const langs = [...packs.map((p) => p.lang), ...noPackLangs.map((l) => l.code)];
      for (const lang of langs) {
        const item = cat.find((c) => c.lang === lang);
        if (!item) continue;
        const installed = packs.find((p) => p.lang === lang);
        const cur = installed?.version;
        if (cur === item.version) continue;
        if (await install(item)) done += 1;
        else failures.push(langName(lang));
      }
      if (failures.length > 0) {
        setNotice({ title: "部分词典更新失败", message: `失败：${failures.join("、")}；成功 ${done} 个` });
      } else {
        setNotice({ title: done > 0 ? `已更新 ${done} 个词典` : "全部词典已是最新" });
      }
    } catch (e) {
      setNotice({ title: "更新失败", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setUpdatingAll(false);
    }
  };

  const onInstallUrl = async () => {
    const url = customUrl.trim();
    if (!url) return;
    setUrlBusy(true);
    if (await install({ lang: "custom", url })) setCustomUrl("");
    setUrlBusy(false);
  };

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return;
    setImporting(true);
    try {
      for (const f of files) await importPack(f);
      await refresh();
      setNotice({ title: "导入成功", message: `${files.length} 个词典包已安装` });
    } catch (e) {
      setNotice({ title: "导入失败", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setImporting(false);
    }
  };

  const onRemove = async (lang: string) => {
    try {
      await removePack(lang);
      await refresh();
    } catch (e) {
      setNotice({ title: "删除失败", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const checkBtn = (lang: string, label = "检查更新") => (
    <button
      onClick={() => onCheck(lang)}
      disabled={installing || checking !== null || updatingAll}
      className="whitespace-nowrap rounded-lg border border-emerald-500 px-3 py-1.5 text-sm text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950"
    >
      {checking === lang ? (
        <span className="inline-flex items-center gap-1.5">
          <SpinnerIcon /> 检查中…
        </span>
      ) : (
        label
      )}
    </button>
  );

  return (
    <div className="mx-auto max-w-2xl">
      {/* tab 切换：列表（已装 + 无词典占位）/ 安装（在线更新·导入·自定义 URL）/ 更新源 */}
      <div className="mt-3 flex gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800">
        {(["list", "install", "source"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm transition-colors ${
              tab === t
                ? "bg-white text-emerald-600 shadow-sm dark:bg-zinc-950 dark:text-emerald-400"
                : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            {t === "list" ? "列表" : t === "install" ? "安装" : "更新源"}
          </button>
        ))}
      </div>

      {tab === "list" && (
      <div className="mt-3 space-y-2">
        {packs.map((p) => (
          <div key={p.lang} className="podic-card rounded-2xl bg-white/85 p-3.5 dark:bg-zinc-900/80">
            {/* 文案全宽；按钮挪到下一行，不再挤压词条信息 */}
            <div>
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
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 max-w-48 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
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
                <p className="shrink-0 text-xs text-zinc-400">
                  {progress.p.phase === "download"
                    ? `下载中 ${Math.round(progress.p.downloaded / 1048576)}MB`
                    : progress.p.phase === "extract"
                      ? "解压中…"
                      : "校验中…"}
                </p>
              </div>
            ) : (
              <div className="mt-2 flex justify-end gap-1.5">
                {/* 更新源里有该语言才给入口；自导入包走确认框替换 */}
                {hasInSource(p.lang) && checkBtn(p.lang)}
                <button
                  onClick={() => setConfirmRemove(p)}
                  disabled={installing}
                  className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950"
                >
                  删除
                </button>
              </div>
            )}
          </div>
        ))}

        {/* 已添加但无词典的语言：虚线占位，检查源里有则确认安装 */}
        {noPackLangs.map((l) => (
          <div
            key={l.code}
            className="rounded-2xl border border-dashed border-zinc-300 bg-transparent p-3.5 dark:border-zinc-700"
          >
            <div>
              <p className="font-medium text-zinc-500">{l.name}</p>
              <p className="mt-0.5 text-sm text-zinc-400">
                无词典（查词走 AI 补全，可点「检查」从更新源安装）
              </p>
            </div>
            <div className="mt-2 flex justify-end">
              {progress?.lang === l.code ? (
                <p className="py-1.5 text-xs text-zinc-400">安装中…</p>
              ) : (
                checkBtn(l.code, "检查")
              )}
            </div>
          </div>
        ))}
      </div>
      )}

      {/* ---- 安装 tab：三块明确分隔 ---- */}
      {tab === "install" && (
      <div className="mt-5 space-y-3">
        {/* ① 在线更新 */}
        <section className="podic-card flex items-center justify-between gap-3 rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">在线更新</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              逐个检查已装词典的更新与无词典语言的安装源，有新版本即下载
            </p>
          </div>
          <button
            onClick={() => void onUpdateAll()}
            disabled={installing || checking !== null || updatingAll}
            className="shrink-0 whitespace-nowrap rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {updatingAll ? (
              <span className="inline-flex items-center gap-1.5">
                <SpinnerIcon /> 更新中…
              </span>
            ) : (
              "更新所有词典"
            )}
          </button>
        </section>

        {/* ② 本地导入 */}
        <section className="podic-card flex items-center justify-between gap-3 rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">本地导入</h2>
            <p className="mt-0.5 text-xs text-zinc-400">选择 .db 词典包文件导入（可多选）</p>
          </div>
          <label className="inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-xl border border-emerald-500 px-4 py-2 text-sm text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 dark:hover:bg-emerald-950">
            {importing ? (
              <span className="inline-flex items-center gap-1.5">
                <SpinnerIcon /> 导入中…
              </span>
            ) : (
              "导入本地词典包"
            )}
            <input
              type="file"
              accept=".db"
              multiple
              className="hidden"
              onChange={(e) => onImport(e.target.files)}
            />
          </label>
        </section>

        {/* ③ 自定义 URL */}
        <section className="podic-card rounded-2xl bg-white/85 p-4 dark:bg-zinc-900/80">
          <h2 className="text-sm font-medium">自定义 URL 安装</h2>
          <p className="mt-0.5 text-xs text-zinc-400">任意可直链的 .db.gz / .db 词典包地址</p>
          <div className="action-row mt-3">
            <button
              onClick={() => void onInstallUrl()}
              disabled={!customUrl.trim() || urlBusy || installing}
              className="shrink-0 whitespace-nowrap rounded-xl bg-violet-600 px-4 py-2 text-sm text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {urlBusy ? (
                <span className="inline-flex items-center gap-1.5">
                  <SpinnerIcon /> 安装中…
                </span>
              ) : (
                "下载安装"
              )}
            </button>
            {/* .action-row > * 的 flex:0 0 auto 特异性高于 tailwind flex-1，用 inline style 撑满 */}
            <input
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="https://…/fr-dict-0.1.3.db.gz"
              style={{ flex: "1 1 auto", minWidth: 0 }}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
        </section>
      </div>
      )}

      {/* ---- 更新源 tab：独立配置页 ---- */}
      {tab === "source" && (
      <div className="mt-3">
        <UpdateSourcePicker />
      </div>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        title={`删除${langName(confirmRemove?.lang ?? "")}词典？`}
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
            ? `更新${langName(confirmInstall?.lang ?? "")}词典？`
            : `安装${langName(confirmInstall?.lang ?? "")}词典？`
        }
        message={
          confirmInstall
            ? [
                (() => {
                  const cur = packs.find((p) => p.lang === confirmInstall.lang);
                  if (!cur) return `v${confirmInstall.version}${confirmInstall.entry_count ? ` · ${confirmInstall.entry_count.toLocaleString()} 词条` : ""}`;
                  const replaced = cur.pack_id !== confirmInstall.pack_id;
                  return `v${cur.version}${replaced ? `（${cur.pack_id}）` : ""} → v${confirmInstall.version}${replaced ? "，将替换你导入的词典" : ""}`;
                })(),
                fmtSize(confirmInstall.size) ? `下载体积 ${fmtSize(confirmInstall.size)}` : "",
                confirmInstall.notes ?? "",
              ]
                .filter(Boolean)
                .join("\n")
            : ""
        }
        confirmText="下载安装"
        confirmClassName="bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700"
        onConfirm={() => void onConfirmInstall()}
        onCancel={() => setConfirmInstall(null)}
      />

      <NoticeDialog
        open={notice !== null}
        title={notice?.title ?? ""}
        message={notice?.message}
        onClose={() => setNotice(null)}
      />
    </div>
  );
}
