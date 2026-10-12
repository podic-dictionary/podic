/** 常见语言码 → 中文名（与 crates/podic-core/src/ai/prompt.rs 的 LANG_NAMES 保持同步）。
 * 用于未注册语言兜底：词典包列表可能挂着未注册语言的包，显示名不该依赖注册状态 */
export const LANG_NAMES: Record<string, string> = {
  en: "英语", fr: "法语", ja: "日语", zh: "中文",
  de: "德语", es: "西班牙语", pt: "葡萄牙语", it: "意大利语",
  ru: "俄语", ko: "韩语", ar: "阿拉伯语", hi: "印地语",
  th: "泰语", vi: "越南语", nl: "荷兰语", pl: "波兰语",
  tr: "土耳其语", sv: "瑞典语", uk: "乌克兰语", el: "希腊语",
  he: "希伯来语", id: "印尼语", ms: "马来语", la: "拉丁语",
  fa: "波斯语", hu: "匈牙利语", cs: "捷克语", da: "丹麦语",
  fi: "芬兰语", no: "挪威语",
};

/** 未注册语言的显示名兜底 */
export const langDisplayName = (code: string): string => LANG_NAMES[code] ?? code;
