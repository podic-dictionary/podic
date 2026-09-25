import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { FONT_ZOOM, useSettings } from "./SettingsContext";
import ConfirmDialog from "./components/ConfirmDialog";
import LanguageSwitcher from "./components/LanguageSwitcher";
import { BookOpenIcon, ChevronLeftIcon, GearIcon, LanguagesIcon, SearchIcon, StarIcon } from "./components/icons";
import ReadingView from "./views/ReadingView";
import SearchView from "./views/SearchView";
import TranslateView from "./views/TranslateView";
import FavoritesView from "./views/FavoritesView";
import SettingsView, { type SettingsSub } from "./views/SettingsView";
import type { Lang, View } from "./types";

const VIEWS: {
  id: View;
  label: string;
  icon: (p: { size?: number; className?: string }) => ReactElement;
}[] = [
  { id: "search", label: "查词", icon: SearchIcon },
  { id: "translate", label: "翻译", icon: LanguagesIcon },
  { id: "reading", label: "阅读", icon: BookOpenIcon },
  { id: "favorites", label: "生词本", icon: StarIcon },
  { id: "settings", label: "设置", icon: GearIcon },
];

export default function App() {
  const [view, setView] = useState<View>("search");
  // 设置页二级页状态提升：返回键/浏览器返回的导航语义需要感知它
  const [settingsSub, setSettingsSub] = useState<SettingsSub>(null);
  // 阅读态：文章 id | "new"(粘贴) | null(列表)；进返回栈与 settingsSub 同路径。
  // 持久化到 localStorage：切 tab / 重启 app 都恢复上次读到的文章
  const [articleId, setArticleId] = useState<number | "new" | null>(() => {
    try {
      const v = localStorage.getItem("podic.reading.article");
      if (!v) return null;
      if (v === "new") return "new";
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  // 语言选择持久化，恢复上次使用的语种（脏值回退英文）
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const v = localStorage.getItem("podic.lang") as Lang | null;
      return v && ["en", "fr", "ja"].includes(v) ? v : "en";
    } catch {
      return "en";
    }
  });

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("podic.lang", l);
    } catch { /* 静默 */ }
  }, []);
  const { fontScale, hand } = useSettings();
  // 右手: 高频入口靠右（查词在最右、拇指热区）；左手: 原顺序
  const navViews = hand === "right" ? [...VIEWS].reverse() : VIEWS;
  // 各 tab 常驻（display 切换）保住内部状态；滚动位置按 tab 记忆恢复
  const mainRef = useRef<HTMLElement>(null);
  const scrollPos = useRef<Partial<Record<View, number>>>({});

  const switchView = (v: View) => {
    if (v === view) return;
    if (mainRef.current) scrollPos.current[view] = mainRef.current.scrollTop;
    setView(v);
    if (v !== "settings") setSettingsSub(null);
    // 阅读态不因切 tab 清掉：回阅读 tab 还在原文章里
  };

  useEffect(() => {
    try {
      if (typeof articleId === "number") localStorage.setItem("podic.reading.article", String(articleId));
      else localStorage.removeItem("podic.reading.article"); // null / "new" 都不跨启动保留
    } catch { /* 静默 */ }
  }, [articleId]);

  // ---- 返回语义（Android 返回键 / 浏览器返回）----
  // 栈结构: [进入前历史, base(查词根), sentinel(查词根哨兵), ...导航条目]
  // - 哨兵保证「查词根再返回」永远落在同文档（跨文档返回无法拦截），此时弹退出确认
  // - App 壳不走 history：PodicAndroid 桥直接问 JS 能否回退
  const restoring = useRef(false);
  const exitAllowed = useRef(false);
  const [exitAsk, setExitAsk] = useState(false);
  useEffect(() => {
    if (!history.state?.podic) {
      history.replaceState({ podic: 1, view: "search", sub: null }, "");
      history.pushState({ podic: 1, view: "search", sub: null, sentinel: true }, "");
    }
  }, []);
  useEffect(() => {
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    const state = { podic: 1, view, sub: settingsSub, article: articleId };
    const hs = { ...(history.state ?? {}) } as Record<string, unknown>;
    delete hs.sentinel;
    if (JSON.stringify(hs) !== JSON.stringify(state)) {
      history.pushState(state, "");
    }
  }, [view, settingsSub, articleId]);
  // 把「能否应用内返回」与回退动作同步给 App 壳（WebView 的 canGoBack 不认 pushState）
  useEffect(() => {
    const w = window as unknown as {
      PodicAndroid?: { setCanGoBack: (v: boolean) => void };
      PodicHarmony?: { setCanGoBack: (v: boolean) => void };
      __podicGoBack?: () => void;
    };
    // 查词根且无二级页才交给壳直接退出；阅读文章内返回（回列表）走 __podicGoBack
    const canGoBack = view !== "search" || settingsSub !== null;
    w.PodicAndroid?.setCanGoBack(canGoBack);
    w.PodicHarmony?.setCanGoBack(canGoBack);
    w.__podicGoBack = () => {
      if (settingsSub) setSettingsSub(null);
      else if (view === "reading" && articleId !== null) setArticleId(null);
      else if (view !== "search") switchView("search");
    };
  }, [view, settingsSub, articleId]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = e.state as {
        podic?: number;
        view?: View;
        sub?: SettingsSub;
        article?: number | "new" | null;
        sentinel?: boolean;
      } | null;
      if (!s?.podic) {
        if (exitAllowed.current) return; // 确认过退出，放行离开页面
        // 兜底：跨过 base 的返回，推回哨兵并弹确认
        history.pushState({ podic: 1, view: "search", sub: null, sentinel: true }, "");
        setExitAsk(true);
        return;
      }
      if (!s.sentinel && s.view === "search" && !s.sub) {
        // 到达 base = 查词根再返回：推回哨兵，弹退出确认
        history.pushState({ podic: 1, view: "search", sub: null, sentinel: true }, "");
        setExitAsk(true);
        return;
      }
      restoring.current = true;
      setView(s.view ?? "search");
      setSettingsSub(s.sub ?? null);
      setArticleId(s.article ?? null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = scrollPos.current[view] ?? 0;
  }, [view]);

  // 进设置二级页/阅读文章时内容区回到顶部（原先 SettingsView 里 querySelector("main") 跨层摸 DOM，收归这里）
  useEffect(() => {
    if (settingsSub || articleId !== null) mainRef.current?.scrollTo(0, 0);
  }, [settingsSub, articleId]);

  // 生词本点词 -> 切到查词并查询（SearchView 监听该事件）
  const openWord = (w: string, l: string) => {
    switchView("search");
    window.dispatchEvent(new CustomEvent("podic:search", { detail: { q: w, lang: l } }));
  };

  // App 壳深链接入口：podic://search?q=hi&lang=en -> iOS 壳 evaluateJavaScript 调到这里
  useEffect(() => {
    (window as unknown as { __podicSearch?: (q: string, lang?: string) => void }).__podicSearch =
      (q, lang) => {
        if (lang && ["en", "fr", "ja"].includes(lang)) setLang(lang as Lang);
        openWord(q, lang ?? "en");
      };
  });

  return (
    <div className="flex h-dvh flex-col text-zinc-900 dark:text-zinc-100">
      {/* 上部：Sidebar + 内容列（内容列高度 = 视口 - 底部导航，滚动区不含 nav） */}
      <div className="flex min-h-0 flex-1">
      {/* Sidebar（桌面端） */}
      <nav className="hidden w-16 flex-col items-center gap-1 border-r border-zinc-200 py-4 md:flex dark:border-zinc-800">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => switchView(v.id)}
            className={`flex w-14 flex-col items-center gap-0.5 rounded-lg px-1 py-2 text-xs transition-colors ${
              view === v.id
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
            }`}
          >
            <v.icon size={22} className="mx-auto" />
            <span>{v.label}</span>
          </button>
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar: logo + language switcher（右手时选项靠右） */}
        {/* header 整体按手性镜像：右手=装饰在左、控件在右（拇指位）；左手相反 */}
        <header
          className={`sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between border-b border-zinc-200/70 bg-white/60 px-4 backdrop-blur-md dark:border-zinc-800/70 dark:bg-zinc-950/60 ${
            hand === "left" ? "flex-row-reverse" : ""
          }`}
        >
          {/* 印章 / 语言切换 / 返回 是独立子元素，justify-between 才能把控件推到拇指侧 */}
          <div className="seal" aria-label="Podic">典</div>
          {view !== "reading" && <LanguageSwitcher value={lang} onChange={setLang} />}
          {view === "reading" && articleId !== null && (
            <button
              onClick={() => setArticleId(null)}
              className="flex items-center gap-1 rounded-xl border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50/60 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-emerald-700 dark:hover:bg-emerald-950/40"
            >
              <ChevronLeftIcon size={15} className="text-emerald-600 dark:text-emerald-400" />
              返回
            </button>
          )}
        </header>

        <main
          ref={mainRef}
          className="min-h-0 flex-1 overscroll-contain overflow-y-auto"
          style={{ zoom: FONT_ZOOM[fontScale] }}
        >
          {VIEWS.map((v) => (
            <div key={v.id} className="h-full" style={{ display: view === v.id ? "block" : "none" }}>
              {v.id === "search" && <SearchView lang={lang} onLangChange={setLang} />}
              {v.id === "translate" && <TranslateView />}
              {v.id === "reading" && (
                <ReadingView lang={lang} articleId={articleId} setArticleId={setArticleId} />
              )}
              {v.id === "favorites" && <FavoritesView active={view === "favorites"} onOpenWord={openWord} />}
              {v.id === "settings" && <SettingsView sub={settingsSub} setSub={setSettingsSub} />}
            </div>
          ))}
        </main>
      </div>
      </div>

      {/* Bottom nav（手机端，文档流内：内容区高度天然扣除导航，滚动到头即见底） */}
      <nav className="flex shrink-0 border-t border-zinc-200/70 bg-white/80 backdrop-blur-md md:hidden dark:border-zinc-800/70 dark:bg-zinc-950/80">
        {navViews.map((v) => (
          <button
            key={v.id}
            onClick={() => switchView(v.id)}
            className={`relative flex flex-1 flex-col items-center gap-1 py-2 leading-none transition-colors ${
              view === v.id
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            {view === v.id && (
              <span className="absolute top-0 h-[2px] w-9 rounded-full bg-emerald-600 dark:bg-emerald-400" aria-hidden />
            )}
            <v.icon size={24} className="mx-auto" />
            <span className="whitespace-nowrap">{v.label}</span>
          </button>
        ))}
      </nav>

      {/* 浏览器场景：查词栈底再按返回的退出确认 */}
      <ConfirmDialog
        open={exitAsk}
        title="退出 Podic？"
        confirmText="退出"
        onConfirm={() => {
          setExitAsk(false);
          exitAllowed.current = true;
          history.go(-2); // 跨过 base+哨兵离开页面（App 壳不弹这个框）
        }}
        onCancel={() => setExitAsk(false)}
      />
    </div>
  );
}
