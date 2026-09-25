import { useCallback, useEffect, useState } from "react";
import { lookup, saveUserDict } from "../../api";
import type { AiContext } from "./ArticleReader";
import type { Entry, Sense, WordStatus } from "../../types";
import { useSettings } from "../../SettingsContext";
import { aiRun } from "../../api";
import BottomSheet from "./BottomSheet";
import EntryCard from "../EntryCard";

/** 查询链：surface → fr 省音撇号后段 → en 连字符各段（Map/序去重，段长 ≥2） */
function queryChain(norm: string, lang: string): string[] {
  const out = [norm];
  if (lang === "fr" && norm.includes("'")) {
    const last = norm.split("'").pop() ?? "";
    if (last.trim().length >= 2) out.push(last.trim());
  }
  if (norm.includes("-")) {
    for (const p of norm.split("-")) {
      const seg = p.trim();
      if (seg.length >= 2 && !out.includes(seg)) out.push(seg);
    }
  }
  return out;
}

const dedupe = (items: Entry[]) => {
  const seen = new Set<number>();
  return items.filter((e) => !seen.has(e.entry_id) && seen.add(e.entry_id));
};

/** complete 任务输出（严格校验后才入库） */
interface CompleteOut {
  headword: string;
  reading?: string;
  pos?: string[];
  senses: Sense[];
}

function parseComplete(text: string): CompleteOut | null {
  let t = text.trim();
  if (t.startsWith("```")) {
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    t = (m ? m[1] : t.replace(/```/g, "")).trim();
  }
  try {
    const d = JSON.parse(t) as Record<string, unknown>;
    if (typeof d.headword !== "string" || !d.headword.trim()) return null;
    const senses = d.senses;
    if (!Array.isArray(senses) || senses.length === 0) return null;
    const ok = senses.every(
      (s) => s && typeof s === "object" && typeof (s as Sense).zh === "string" && (s as Sense).zh!.trim(),
    );
    if (!ok) return null;
    return {
      headword: d.headword.trim(),
      reading: typeof d.reading === "string" && d.reading.trim() ? d.reading.trim() : undefined,
      pos: Array.isArray(d.pos) ? d.pos.filter((p): p is string => typeof p === "string") : undefined,
      senses: (senses as Sense[]).map((s) => ({ pos: s.pos, zh: s.zh })),
    };
  } catch {
    return null;
  }
}

/** 解析失败词的会话级集合：防同一个坏输出反复触发 AI（重试手动触发且 fresh） */
const failedWords = new Set<string>();

export default function WordDrawer({
  open,
  lang,
  surface,
  norm,
  ctx,
  initialStatus,
  onMark,
  aiReady,
  onClose,
}: {
  open: boolean;
  lang: string;
  surface: string;
  norm: string;
  ctx: AiContext | null;
  /** 点开时的标记快照；标记后走本地状态（正文高亮由 onMark 内 DOM 直改） */
  initialStatus: WordStatus | undefined;
  onMark: (norm: string, s: WordStatus | "none") => void;
  aiReady: boolean;
  onClose: () => void;
}) {
  const { aiChoice, hand } = useSettings();
  const [status, setStatus] = useState<WordStatus | undefined>(initialStatus);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  // idle=未触发 | running=AI 生成中 | failed=坏输出（可手动重试）
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const [aiNote, setAiNote] = useState("");

  const lookupChain = useCallback(async (): Promise<Entry[]> => {
    const chain = queryChain(norm, lang);
    let r = await lookup(chain[0], lang, 10).catch(() => []);
    if (r.length === 0 && chain[1]) r = await lookup(chain[1], lang, 10).catch(() => []);
    if (r.length === 0 && chain.length > 2) {
      const rs = await Promise.all(chain.slice(2).map((q) => lookup(q, lang, 5).catch(() => [])));
      r = rs.flat();
    }
    return dedupe(r);
  }, [norm, lang]);

  // AI 补全：词典全 miss 时自动触发（fresh:false 吃缓存）；手动重试 fresh:true 绕开坏缓存
  const runComplete = useCallback(
    (fresh: boolean) => {
      if (!aiChoice.providerId || !ctx) return;
      setPhase("running");
      setAiNote("");
      // JSON 任务不需要逐字上屏，这里只累积全文
      let full = "";
      let cacheKey: string | null = null;
      aiRun(
        {
          task: "complete",
          text: surface || norm,
          context: ctx,
          provider_id: aiChoice.providerId,
          model: aiChoice.model,
          fresh,
        },
        (delta) => {
          full += delta;
        },
      ).done
        .then(async (key) => {
          cacheKey = key;
          const out = parseComplete(full);
          if (!out) {
            failedWords.add(`${lang}:${norm}`);
            setPhase("failed");
            return;
          }
          await saveUserDict({
            lang,
            headword: out.headword,
            reading: out.reading,
            pos: out.pos,
            senses: out.senses,
            source: "ai",
            model: aiChoice.model,
            alt_norm: norm,
            cache_key: cacheKey ?? undefined,
          });
          const es = await lookupChain();
          setEntries(es);
          setPhase("idle");
          setAiNote(`AI 补录「${out.headword}」已存入用户词典`);
        })
        .catch(() => setPhase("idle"));
    },
    [aiChoice.providerId, aiChoice.model, surface, norm, lang, ctx, lookupChain],
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setEntries(null);
    setAiNote("");
    lookupChain().then((es) => {
      if (!alive) return;
      setEntries(es);
      // 词典全 miss + 已配 AI + 不在失败集合 → 自动补全
      if (es.length === 0 && aiReady && ctx && !failedWords.has(`${lang}:${norm}`)) {
        runComplete(false);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, norm, lang]);

  const title = (
    <span className="font-dict text-lg">
      {surface || norm}
      {norm && surface && norm !== surface.toLowerCase() && (
        <span className="ml-2 text-xs text-zinc-400">{norm}</span>
      )}
    </span>
  );

  // 标记按钮顺序：常用动作落在惯用手拇指角（右下/左下）
  const marks: { s: WordStatus | "none"; label: string }[] =
    hand === "right"
      ? [
          ...(status ? [{ s: "none" as const, label: "清除标记" }] : []),
          { s: "new", label: "生词" },
          { s: "known", label: "认识" },
        ]
      : [
          { s: "known", label: "认识" },
          { s: "new", label: "生词" },
          ...(status ? [{ s: "none" as const, label: "清除标记" }] : []),
        ];

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className={`flex gap-2.5 ${hand === "right" ? "justify-end" : "justify-start"}`}>
          {marks.map((m) => (
            <button
              key={m.s}
              onClick={() => {
                setStatus(m.s === "none" ? undefined : m.s);
                onMark(norm, m.s);
              }}
              className={`rounded-xl px-5 py-2.5 text-sm transition-colors ${
                m.s !== "none" && status === m.s
                  ? "bg-emerald-600 text-white"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      }
    >
      {entries === null && <p className="py-6 text-center text-sm text-zinc-400">查询中…</p>}

      {entries !== null && entries.length > 0 && (
        <div className="space-y-4">
          {entries.slice(0, 3).map((e) => (
            <EntryCard key={e.entry_id} entry={e} autoExamples={false} />
          ))}
        </div>
      )}

      {entries !== null && entries.length === 0 && (
        <div className="py-2">
          {phase === "running" && (
            <p className="py-4 text-center text-sm text-violet-500">
              词典里没有「{surface || norm}」，AI 补全中…
            </p>
          )}
          {phase === "failed" && (
            <div className="py-4 text-center">
              <p className="text-sm text-zinc-400">AI 返回的结果解析失败</p>
              <button
                onClick={() => runComplete(true)}
                className="mt-2 rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white hover:bg-violet-700"
              >
                重试
              </button>
            </div>
          )}
          {phase === "idle" && !aiNote && (
            <p className="py-4 text-center text-sm text-zinc-400">
              {aiReady ? "词典与 AI 均无结果" : "词典无此词（配置 AI Provider 后可自动补全）"}
            </p>
          )}
        </div>
      )}

      {aiNote && (
        <p className="mt-2 text-xs text-violet-500">✦ {aiNote}</p>
      )}
    </BottomSheet>
  );
}
