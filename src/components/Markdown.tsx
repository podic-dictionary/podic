import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true, gfm: true });

export default function Markdown({ text }: { text: string }) {
  // marked 官方不做 sanitize；AI 产出会被词头/输入引导，必须消毒后再进 innerHTML
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text) as string), [text]);
  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none
                 prose-headings:mt-4 prose-headings:mb-2 prose-p:my-1.5
                 prose-li:my-0.5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
