import { aiRun, saveUserDict } from "../api";
import type { Sense } from "../types";

/** complete 任务输出（严格校验后才入库） */
export interface CompleteOut {
  headword: string;
  reading?: string;
  pos?: string[];
  senses: Sense[];
}

export function parseComplete(text: string): CompleteOut | null {
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
const failKey = (lang: string, word: string) => `${lang}:${word.trim().toLowerCase()}`;
export const isFailedWord = (lang: string, word: string) => failedWords.has(failKey(lang, word));

export interface CompleteAndSaveOpts {
  lang: string;
  /** 查询原文（送 AI 的 text） */
  text: string;
  /** alt_norm：屈折镜像键，服务端会先做 norm 归一化（阅读器传 token norm，主查词框传查询原文） */
  altNorm: string;
  /** complete 的 context（阅读器带所在句；主查词框传 {lang, sentence:""}，缓存键需确定性最小） */
  context: unknown;
  providerId: string;
  model?: string;
  /** false 吃服务端缓存；true 绕开坏缓存重生成 */
  fresh: boolean;
}

/** run complete → 校验 → 入库用户词典；返回 null = 解析失败（已记入失败集合）；网络/服务错误向上抛 */
export function completeAndSave(
  o: CompleteAndSaveOpts,
): Promise<{ out: CompleteOut; cacheKey: string | null } | null> {
  let full = "";
  return aiRun(
    {
      task: "complete",
      text: o.text,
      context: o.context,
      provider_id: o.providerId,
      model: o.model,
      fresh: o.fresh,
    },
    (delta) => {
      full += delta;
    },
  ).done.then(async (cacheKey) => {
    const out = parseComplete(full);
    if (!out) {
      failedWords.add(failKey(o.lang, o.altNorm));
      return null;
    }
    await saveUserDict({
      lang: o.lang,
      headword: out.headword,
      reading: out.reading,
      pos: out.pos,
      senses: out.senses,
      source: "ai",
      model: o.model,
      alt_norm: o.altNorm,
      cache_key: cacheKey ?? undefined,
    });
    return { out, cacheKey };
  });
}
