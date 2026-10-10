/** 外部文档链接（GitHub Pages 托管，App 内点击调系统浏览器打开） */
export const PACK_GUID_URL = "https://podic-dictionary.github.io/podic/pack-guide.html";

/** 打开外部页面。App 壳（Android/鸿蒙）的单窗口 WebView 会吞掉 window.open
 *  的导航且返回值非 null（无法凭返回值判断），所以探到壳注入的 JS 桥就直接
 *  location 跳转——由壳的 URL 拦截层转给系统浏览器，SPA 页面本身不导航。
 *  iOS 走 WKUIDelegate 开窗回调手动转系统浏览器；桌面浏览器正常开新标签。 */
export function openExternal(url: string) {
  if ("PodicAndroid" in window || "PodicHarmony" in window) {
    window.location.href = url;
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** 官方词典包发布目录（更新源基地址）；镜像 = 在整串前加代理前缀 */
export const DICT_PACK_BASE = "https://github.com/podic-dictionary/dict/releases/latest/download/";
