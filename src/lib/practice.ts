import { suggest, type Favorite } from "../api";

/** 练习题型：词→选义 / 义→选词 / 义→填词 / 听音→选义 */
export type PracticeMode = "word_meaning" | "meaning_word" | "meaning_type" | "audio_meaning";

export const MODE_LABELS: Record<PracticeMode, string> = {
  word_meaning: "词→义",
  meaning_word: "义→词",
  meaning_type: "拼写",
  audio_meaning: "听音",
};

/** 熟练度 1-4 的显示文案（与后端语义一致）；「生」单独一个字看不懂，用「陌生」 */
export const MASTERY_LABELS = ["", "陌生", "模糊", "认识", "熟练"];

/** 随机会话 id（首答去重键的前半，服务端 PRIMARY KEY(session_id, favorite_id)） */
export const newSessionId = () =>
  crypto.randomUUID?.().replace(/-/g, "") ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

export interface PracticeQuestion {
  favId: number;
  mode: PracticeMode;
  headword: string;
  lang: string;
  ipa: string | null;
  /** 正确释义文本（出题必需；缺失的词跳过不出） */
  gloss: string;
  /** 选择题选项；正确项 key 固定 favorite:<id>，判分只比 key 与展示文本无关 */
  options: { key: string; label: string }[] | null;
}

export interface BuiltPractice {
  questions: PracticeQuestion[];
  skipped: { headword: string; reason: string }[];
}

/** 从 snapshot JSON 取第一条非空中文释义（词条 senses 同构：{pos?, zh?, ...}） */
function firstZhGloss(snapshot: string | null): string | null {
  if (!snapshot) return null;
  try {
    const s = JSON.parse(snapshot) as { senses?: { zh?: unknown }[] };
    const found = s.senses?.find((x) => typeof x.zh === "string" && (x.zh as string).trim());
    return found ? (found.zh as string).trim() : null;
  } catch {
    return null;
  }
}

function ipaOf(snapshot: string | null): string | null {
  if (!snapshot) return null;
  try {
    const s = JSON.parse(snapshot) as { ipa?: unknown };
    if (typeof s.ipa === "string" && s.ipa) return s.ipa;
    if (s.ipa && typeof s.ipa === "object") {
      const o = s.ipa as { uk?: string; us?: string };
      return o.uk || o.us || null;
    }
  } catch { /* 坏快照忽略 */ }
  return null;
}

const shuffle = <T,>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** 词条选择：低熟练度优先，同等级随机 */
export function pickWords(items: Favorite[], lang: string, limit: number): Favorite[] {
  const pool = items.filter((f) => f.lang === lang);
  const keyed = pool.map((f) => ({ f, r: Math.random() }));
  keyed.sort((a, b) => a.f.mastery - b.f.mastery || a.r - b.r);
  return keyed.slice(0, limit).map((x) => x.f);
}

/**
 * 构造题目。干扰项优先取同语言其他生词，不足时用 suggest（词典联想）补齐。
 * 选择题凑不齐 4 个不重复选项时降级为拼写题（若启用），否则跳过该词。
 * 义→词 题的选项是词头（无释义的生词也能当干扰项）；其余题型选项是释义。
 */
export async function buildQuestions(
  picked: Favorite[],
  modes: PracticeMode[],
  lang: string,
): Promise<BuiltPractice> {
  const questions: PracticeQuestion[] = [];
  const skipped: { headword: string; reason: string }[] = [];

  // 干扰项池：同语言其他生词。释义题要 gloss，词头题只要 headword（统一成 {key,label}）
  const glossPool: { key: string; label: string }[] = [];
  const wordPool: { key: string; label: string }[] = [];
  const seenHw = new Set<string>();
  for (const f of picked) {
    if (seenHw.has(f.headword)) continue;
    seenHw.add(f.headword);
    wordPool.push({ key: `favorite:${f.id}`, label: f.headword });
    const g = firstZhGloss(f.snapshot);
    if (g) glossPool.push({ key: `favorite:${f.id}`, label: g });
  }

  const buildOptions = async (
    target: Favorite,
    kind: "gloss" | "headword",
  ): Promise<PracticeQuestion["options"] | null> => {
    const labels = new Set<string>();
    const opts: { key: string; label: string }[] = [];
    const correctLabel = kind === "gloss" ? glossPool.find((x) => x.key === `favorite:${target.id}`)!.label : target.headword;
    opts.push({ key: `favorite:${target.id}`, label: correctLabel });
    labels.add(correctLabel.replace(/\s+/g, "").toLowerCase());
    const pool = kind === "gloss" ? glossPool : wordPool;
    for (const item of shuffle(pool)) {
      if (opts.length >= 4) break;
      const normLabel = item.label.replace(/\s+/g, "").toLowerCase();
      if (item.key === `favorite:${target.id}` || labels.has(normLabel)) continue;
      opts.push({ key: item.key, label: item.label });
      labels.add(normLabel);
    }
    // 不足 3 个干扰项：词典联想补（前缀取词头前两字符，退一个字符再试）
    for (const plen of [2, 1]) {
      if (opts.length >= 4) break;
      const prefix = [...target.headword].slice(0, plen).join("");
      if (!prefix) break;
      let items: { headword: string; gloss?: string | null }[] = [];
      try {
        items = await suggest(prefix, lang, 20);
      } catch {
        continue; // 服务不可达：靠已有池
      }
      for (const s of items) {
        if (opts.length >= 4) break;
        const label = kind === "gloss" ? s.gloss?.trim() : s.headword;
        if (!label || s.headword === target.headword) continue;
        const normLabel = label.replace(/\s+/g, "").toLowerCase();
        if (labels.has(normLabel)) continue;
        opts.push({ key: `suggest:${s.headword}`, label });
        labels.add(normLabel);
      }
    }
    return opts.length >= 4 ? shuffle(opts) : null;
  };

  for (let i = 0; i < picked.length; i++) {
    const f = picked[i];
    const gloss = firstZhGloss(f.snapshot);
    if (!gloss) {
      skipped.push({ headword: f.headword, reason: "缺中文释义" });
      continue;
    }
    // 题型轮转：按启用列表循环分配，混搭时每种都出现
    const mode = modes[i % modes.length];
    const base = { favId: f.id, headword: f.headword, lang: f.lang, ipa: ipaOf(f.snapshot), gloss };
    if (mode === "meaning_type") {
      questions.push({ ...base, mode, options: null });
      continue;
    }
    const options = await buildOptions(f, mode === "meaning_word" ? "headword" : "gloss");
    if (options) {
      questions.push({ ...base, mode, options });
    } else if (modes.includes("meaning_type")) {
      questions.push({ ...base, mode: "meaning_type", options: null }); // 降级拼写
    } else {
      skipped.push({ headword: f.headword, reason: "选项不足" });
    }
  }
  return { questions: shuffle(questions), skipped };
}
