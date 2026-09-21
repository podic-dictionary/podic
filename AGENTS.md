# AGENTS.md — 项目约定（给 AI 助手/新贡献者的速查）

## 样式

- **所有 UI 样式必须同时适配亮色和暗色两种模式**。写每个类名时都要带对应的 `dark:` 变体（背景、边框、文字、hover 态都不遗漏）。
- 暗色模式的机制：Tailwind v4 `@custom-variant dark`，通过 `html.dark` 类切换（见 `src/SettingsContext.tsx`，支持 亮/暗/跟随系统 三档）。不要依赖 `prefers-color-scheme` 媒体查询直接写样式。
- 色板约定（朱砂印谱）：主色 emerald 位 = 朱砂（`emerald-600` / 暗色 `emerald-400`），AI 区 violet 位 = 石青，点缀 amber 位 = 藤金，危险 red 位 = 冷调酒绛（与朱砂区分）；中性色 zinc = 瓷青灰阶；氛围底与噪点在 `src/styles.css` 的 body::before/::after，换色先改 `@theme`。
- 验证方式：设置页切换亮/暗两种模式各过一眼，重点看卡片、边框、hover、选中态。

## 布局

- 应用式布局：整页（html/body）不滚动，只有 `main` 内容区滚动（`overflow-y-auto` + `overscroll-contain`）。
- 导航：桌面端左侧 Sidebar（`md:` 以上），手机端底部 5 tab 导航（`md:hidden`），两处的选中态样式需保持一致的语义（emerald 高亮）。
- 顶部 header sticky 固定，含 logo + 语言切换。

## 其他

- 提交信息、注释、文档使用中文，讲人话。
- 不要把 AI 助手加为 git coauthor。
- 公开内容（代码/文档/release）不得包含私人 hostname、IP、API key，必要时用占位符。
