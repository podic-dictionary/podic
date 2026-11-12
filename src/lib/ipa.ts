/** 音标展示规范化（验收反馈：英语音标渲染成了 JSON 原文）。
 * en 包 entry.ipa 列存的是 {"uk","us"} JSON 串（练习页 ipaOf 读快照后已解析）；
 * fr/ja 等是裸音标、可能自带斜杠。统一：JSON 取 uk→us，剥首尾斜杠，空则 null。
 * 调用方负责包 /…/ */
export const fmtIpa = (ipa: string | null | undefined) => {
  if (!ipa) return null;
  let s = ipa.trim();
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s) as { uk?: string; us?: string };
      s = o.uk || o.us || "";
    } catch { /* 非 JSON 原样走 */ }
  }
  s = s.replace(/^\/+|\/+$/g, "").trim();
  return s || null;
};
