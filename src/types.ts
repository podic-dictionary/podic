export type Lang = "en" | "fr" | "ja";
export type View = "search" | "translate" | "favorites" | "settings";

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
  matched_by: "exact" | "form" | "fts" | "prefix" | "zh" | "zh-fts";
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
