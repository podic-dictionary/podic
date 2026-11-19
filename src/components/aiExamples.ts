/** AI 例句输出的解析：约定 JSON {"sentences":[{"text":"…","zh":"…"}]}，
 * 模型常会包 ```json 代码块甚至中途截断，这里做容错抽取。
 * 生成例句的展示（AI 面板 tab 与词条例句区）共用 */
export type AiExample = { text: string; zh?: string };

export function tryParseExamples(text: string): AiExample[] | null {
  let t = text.trim();
  if (t.startsWith("```")) {
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    t = m ? m[1].trim() : t.replace(/```/g, "");
  }
  try {
    const data: { sentences?: AiExample[] } = JSON.parse(t);
    if (Array.isArray(data.sentences)) {
      return data.sentences.filter((s) => s && typeof s.text === "string");
    }
  } catch {
    // JSON 不完整（输出被截断等）：抢救其中已完整的句子对象，不整段回退原文
    const saved = [...t.matchAll(/\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"zh"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g)]
      .map((m) => ({ text: JSON.parse(`"${m[1]}"`) as string, zh: JSON.parse(`"${m[2]}"`) as string }));
    if (saved.length > 0) return saved;
  }
  return null;
}
