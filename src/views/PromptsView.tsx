import { useEffect, useMemo, useState } from "react";
import { getPrompts, saveSettings, type PromptTaskView } from "../api";
import ConfirmDialog from "../components/ConfirmDialog";
import { ChevronLeftIcon, SpinnerIcon } from "../components/icons";

/// AI 提示词编辑页：查看/修改/还原各任务的内置提示词。
/// 覆盖只存差异（settings.prompts），还原 = 删除该任务的覆盖恢复内置。
/// user 模板占位符：{text} 查询词/原文，{context} 词条上下文 JSON
const TA_CLS =
  "w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 font-mono text-[13px] leading-relaxed text-zinc-800 focus:border-emerald-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:focus:border-emerald-600";

export default function PromptsView({ onBack }: { onBack: () => void }) {
  const [tasks, setTasks] = useState<PromptTaskView[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  // 编辑中的文本：task -> {system, user}（与 override/内置的合并态，脏标记另存）
  const [edits, setEdits] = useState<Record<string, { system: string; user: string }>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [active, setActive] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [confirmReset, setConfirmReset] = useState(false);

  const reload = () => {
    getPrompts()
      .then((r) => {
        setTasks(r.tasks);
        const init: Record<string, { system: string; user: string }> = {};
        for (const t of r.tasks) {
          const o = t.override;
          init[t.task] = o ? { system: o.system, user: o.user } : { system: t.system, user: t.user };
        }
        setEdits(init);
        setDirty({});
        setActive((a) => (r.tasks.some((t) => t.task === a) ? a : (r.tasks[0]?.task ?? "")));
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(reload, []);

  const current = useMemo(() => tasks?.find((t) => t.task === active) ?? null, [tasks, active]);
  const overridden = (task: string) => Boolean(tasks?.find((t) => t.task === task)?.override);

  const saveAll = async () => {
    if (!tasks) return;
    setSaveState("saving");
    // 整份提交：保留各任务的现有覆盖，叠加本轮编辑（与内置一致则不写覆盖）
    const map: Record<string, { system: string; user: string }> = {};
    for (const t of tasks) {
      const e = edits[t.task];
      if (e && (e.system !== t.system || e.user !== t.user)) map[t.task] = e;
    }
    try {
      await saveSettings({ prompts: map });
      setSaveState("ok");
      reload();
      window.setTimeout(() => setSaveState("idle"), 1500);
    } catch {
      setSaveState("error");
    }
  };

  const resetCurrent = async () => {
    if (!current) return;
    const next = { ...edits, [current.task]: { system: current.system, user: current.user } };
    setEdits(next);
    setDirty({ ...dirty, [current.task]: true });
  };

  const dirtyCount = Object.values(dirty).filter(Boolean).length;

  return (
    <div className="mx-auto max-w-2xl p-4">
      <button
        onClick={onBack}
        className="flex w-full items-center gap-2 rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50/60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-emerald-700 dark:hover:bg-emerald-950/40"
      >
        <ChevronLeftIcon size={16} className="text-emerald-600 dark:text-emerald-400" />
        返回设置
      </button>
      <div className="mt-3 flex items-center justify-between gap-3">
        <h1 className="text-lg font-medium">AI 提示词</h1>
        <button
          onClick={() => void saveAll()}
          disabled={saveState === "saving" || dirtyCount === 0}
          className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-1.5 text-sm text-white transition-colors hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500 dark:hover:bg-emerald-600"
        >
          {saveState === "saving" && <SpinnerIcon />}
          {saveState === "ok" ? "已保存" : saveState === "error" ? "保存失败，重试" : `保存${dirtyCount ? `（${dirtyCount}）` : ""}`}
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-400">
        各 AI 任务的提示词模板。user 里的 {"{text}"} = 查询词/原文，{"{context}"} = 词条上下文 JSON（无则留空）
      </p>

      {loadErr && (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">{loadErr}</p>
      )}

      {tasks && (
        <div className="mt-3 flex gap-1 overflow-x-auto rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800">
          {tasks.map((t) => (
            <button
              key={t.task}
              onClick={() => setActive(t.task)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                active === t.task
                  ? "bg-white text-emerald-600 shadow-sm dark:bg-zinc-950 dark:text-emerald-400"
                  : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              {t.label}
              {overridden(t.task) && <span className="ml-1 text-[10px] text-emerald-500">已自定义</span>}
            </button>
          ))}
        </div>
      )}

      {current && (
        <section className="mt-4 space-y-3 rounded-2xl border border-zinc-200/80 bg-white/85 p-4 dark:border-zinc-800 dark:bg-zinc-900/80">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-500">{current.label}（{current.task}）</h2>
            {overridden(current.task) && (
              <button
                onClick={() => setConfirmReset(true)}
                className="text-xs text-zinc-400 underline-offset-2 hover:text-emerald-600 hover:underline dark:hover:text-emerald-400"
              >
                还原内置
              </button>
            )}
          </div>
          <div>
            <p className="mb-1 text-xs text-zinc-400">system（角色设定）</p>
            <textarea
              rows={3}
              value={edits[current.task]?.system ?? ""}
              onChange={(e) => {
                setEdits({ ...edits, [current.task]: { ...edits[current.task], system: e.target.value } });
                setDirty({ ...dirty, [current.task]: true });
              }}
              className={TA_CLS}
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-zinc-400">user（任务指令模板）</p>
            <textarea
              rows={10}
              value={edits[current.task]?.user ?? ""}
              onChange={(e) => {
                setEdits({ ...edits, [current.task]: { ...edits[current.task], user: e.target.value } });
                setDirty({ ...dirty, [current.task]: true });
              }}
              className={TA_CLS}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-400">
            输出格式约定（JSON 结构、Markdown 小标题）改坏了会影响 App 解析结果，修改前先读懂原模板；改坏可用「还原内置」恢复。
          </p>
        </section>
      )}

      <ConfirmDialog
        open={confirmReset}
        title="还原内置提示词？"
        message={`「${current?.label ?? ""}」将恢复为内置模板，丢弃你的自定义。`}
        confirmText="还原"
        onConfirm={() => {
          void resetCurrent();
          setConfirmReset(false);
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
