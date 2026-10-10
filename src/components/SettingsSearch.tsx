import { useMemo, useState } from "react";
import type { SettingsSub } from "../views/SettingsView";
import { openExternal, PACK_GUID_URL } from "../links";
import { SearchIcon } from "./icons";

/// 设置页搜索（交互参考 feelime 设置搜索）：输入即时过滤索引，下拉面板列命中项，
/// 点击跳到对应设置——二级页直接切换，主页内的项滚动定位 + 呼吸高亮（.search-flash）
interface SearchEntry {
  title: string;
  desc?: string;
  /** 意图词：用户可能输入的说法（同 feelime 的 data-keywords） */
  keywords?: string[];
  /** 二级页；主页内的项用 anchor 定位 */
  sub?: SettingsSub;
  /** 带 tab 的完整 hash（如词典-安装 tab）：走 hashchange 让 App/PacksView 同步 */
  hash?: string;
  /** 主页内区块 id（scrollIntoView + 呼吸高亮） */
  anchor?: string;
  /** 外部链接（创建词典包教程） */
  external?: boolean;
}

const PAGE_LABELS: { [k in Exclude<SettingsSub, null>]: string } = {
  ai: "AI Provider",
  userdict: "AI 词典",
  languages: "语言",
  packs: "词典",
  about: "关于",
};

const ENTRIES: SearchEntry[] = [
  // 主页内的项（anchor 定位）
  { title: "色彩模式", desc: "亮色 / 暗色 / 跟随系统", keywords: ["主题", "暗色", "深色", "夜间", "外观", "theme", "dark"], anchor: "set-theme" },
  { title: "页面字体大小", desc: "小 / 标准 / 大", keywords: ["字体", "字号", "缩放", "大小", "font"], anchor: "set-font" },
  { title: "操作手性", desc: "按钮与高频入口靠哪一侧", keywords: ["左手", "右手", "利手", "惯用手"], anchor: "set-hand" },
  { title: "词典未命中时 AI 补全", desc: "自动生成 / 手动触发", keywords: ["AI", "自动", "手动", "补全", "补录", "查词"], anchor: "set-auto" },
  // 二级页
  { title: "AI Provider", desc: "OpenAI 兼容 / Anthropic 双协议", keywords: ["接口", "密钥", "key", "模型", "api", "base url"], sub: "ai" },
  { title: "AI 词典", desc: "阅读时 AI 补录的词条", keywords: ["补录", "词条", "user dict"], sub: "userdict" },
  { title: "语言", desc: "添加任意语言、排序与移出", keywords: ["语言", "添加", "英语", "法语", "日语", "俄语", "德语"], sub: "languages" },
  { title: "词典", desc: "导入 · 更新 · 卸载", keywords: ["词典包", "卸载", "删除", "版本", "词条数"], sub: "packs" },
  // 词典-安装 tab（hash 带 tab 段）
  { title: "更新所有词典", desc: "逐个检查更新并下载安装", keywords: ["更新", "升级", "下载", "检查"], hash: "#/settings/packs/install" },
  { title: "本地导入", desc: "选择 .db 词典包文件导入", keywords: ["导入", "文件", "db", "离线"], hash: "#/settings/packs/install" },
  { title: "自定义 URL 安装", desc: "从任意直链地址下载安装", keywords: ["url", "链接", "下载", "安装", "自定义"], hash: "#/settings/packs/install" },
  { title: "更新源", desc: "GitHub 直连 / 加速 / 自定义 + 测速", keywords: ["源", "加速", "测速", "代理", "gh-proxy", "镜像"], hash: "#/settings/packs/source" },
  // 外链
  { title: "创建词典包", desc: "LLM 批量生成 · 打包 · 导入教程", keywords: ["教程", "构建", "制作", "打包"], external: true },
  { title: "关于 / 数据来源", desc: "版本 · 开源致谢", keywords: ["版本", "致谢", "许可", "开源", "license"], sub: "about" },
];

const entryText = (e: SearchEntry) =>
  [e.title, e.desc, ...(e.keywords ?? []), e.sub ? PAGE_LABELS[e.sub] : ""]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

/// 主页内定位：滚动到区块居中 + 呼吸高亮（动画重置要强制 reflow）
const flashAnchor = (id: string) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("search-flash");
  void el.offsetWidth; // 重启动画
  el.classList.add("search-flash");
  window.setTimeout(() => el.classList.remove("search-flash"), 2000);
};

export default function SettingsSearch({ setSub }: { setSub: (s: SettingsSub) => void }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const hits = useMemo(() => {
    if (!query) return [];
    const matched = ENTRIES.filter((e) => entryText(e).includes(query));
    // 标题直接命中的排前面（说明/关键词命中的靠后）
    matched.sort(
      (a, b) =>
        Number(b.title.toLowerCase().includes(query)) - Number(a.title.toLowerCase().includes(query)),
    );
    return matched.slice(0, 12);
  }, [query]);

  const jump = (e: SearchEntry) => {
    setQ("");
    if (e.external) {
      openExternal(PACK_GUID_URL);
    } else if (e.hash) {
      window.location.hash = e.hash; // App 的 hashchange 监听同步 view/sub
    } else if (e.sub) {
      setSub(e.sub);
    } else if (e.anchor) {
      flashAnchor(e.anchor);
    }
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-700 dark:bg-zinc-950">
        <SearchIcon size={16} className="shrink-0 text-zinc-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索设置：主题、字体、密钥、导入、更新源…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-400"
        />
      </div>
      {query && (
        <div className="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-950 dark:shadow-zinc-950/50">
          {hits.length === 0 ? (
            <p className="px-4 py-2.5 text-sm text-zinc-400">没有匹配的设置项</p>
          ) : (
            hits.map((e) => (
              <button
                key={e.title}
                onClick={() => jump(e)}
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm">{e.title}</span>
                  {e.desc && <span className="block truncate text-xs text-zinc-400">{e.desc}</span>}
                </span>
                <span className="shrink-0 text-xs text-zinc-400">
                  {e.external ? "外链" : (e.sub && PAGE_LABELS[e.sub]) || "设置"}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
