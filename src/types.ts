export type Lang = "en" | "fr" | "ja";
export type View = "search" | "translate" | "reading" | "favorites" | "settings";

export interface PackInfo {
  lang: Lang;
  pack_id: string;
  version: string;
  built_at: string;
  entry_count: number;
  sources: { name: string; url: string; license: string }[];
  file_name: string;
}

export interface Sense {
  pos?: string[];
  zh?: string;
  en?: string;
  fr?: string;
  kind?: string;
  tags?: string[];
}

export interface Entry {
  lang: Lang;
  entry_id: number;
  headword: string;
  reading?: string;
  ipa?: { uk?: string; us?: string } | string;
  pos?: string[];
  gender?: string;
  freq: number;
  senses?: Sense[];
  extra?: { tags?: string[]; collins?: number; oxford?: number; refined?: boolean; source?: string };
  matched_by: "exact" | "form" | "user" | "fts" | "prefix" | "zh" | "zh-fts";
  rule?: string;
}

export interface SuggestItem {
  lang: Lang;
  headword: string;
  reading?: string;
}

export interface Sentence {
  id: number;
  text: string;
  translation: string[];
}

// ---------------- 阅读 ----------------

/** 服务端分词产物（段落 → token）；norm 为空串表示非词 */
export interface ReaderToken {
  t: string;
  is_word: boolean;
  norm: string;
  space_after: boolean;
}

export interface ArticleMeta {
  id: number;
  lang: Lang;
  title: string;
  char_count: number;
  token_count: number;
  created_at: string;
}

export interface ArticleFull extends ArticleMeta {
  content: string;
  paragraphs: ReaderToken[][];
}

export type WordStatus = "known" | "new";

/** 用户词典（AI 阅读补录，词典扩充源） */
export interface UserDictEntry {
  id: number;
  lang: Lang;
  norm: string;
  headword: string;
  reading: string | null;
  pos: string | null;
  senses: string;
  source: string;
  model: string | null;
  created_at: string;
}
