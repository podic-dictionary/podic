import type { Entry } from "../types";

/// 给 AI 提示词用的词条摘要（与 Rust 侧 prompt::entry_summary 字段对齐）
export function entrySummary(e: Entry) {
  return {
    lang: e.lang,
    headword: e.headword,
    reading: e.reading,
    pos: e.pos,
    gender: e.gender,
    senses: e.senses,
  };
}
