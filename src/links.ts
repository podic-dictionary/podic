/** 外部文档链接（GitHub Pages 托管，App 内点击调系统浏览器打开） */
export const PACK_GUID_URL = "https://podic-dictionary.github.io/podic/pack-guide.html";

/** 打开外部页面：桌面浏览器新标签；App 壳内 window.open 被单窗口 WebView 拒绝
 *  （返回 null、无导航），回退 location 跳转，由壳的 URL 拦截层转给系统浏览器。 */
export function openExternal(url: string) {
  const w = window.open(url, "_blank", "noopener");
  if (!w) window.location.href = url;
}
