// 查询历史：localStorage 本地保存（词头 + 首条释义摘要），供搜索框下拉展示
export interface HistoryItem {
  lang: string;
  q: string; // 触发查询的原文（去重键）
  headword: string; // 命中词条的词头（展示与再次查询用）
  gloss: string; // 基本含义（首词条首义，截断）
  ts: number;
}

const KEY = "podic.history";
const MAX = 50;

export function getHistory(): HistoryItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function addHistory(it: HistoryItem) {
  if (!it.q.trim() || !it.headword.trim()) return;
  const q = it.q.trim().toLowerCase();
  const rest = getHistory().filter((x) => !(x.lang === it.lang && x.q.trim().toLowerCase() === q));
  try {
    localStorage.setItem(KEY, JSON.stringify([it, ...rest].slice(0, MAX)));
  } catch {
    /* 存储异常静默 */
  }
}
