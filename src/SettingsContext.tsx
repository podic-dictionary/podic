import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getSettings, saveSettings, type ProviderView } from "./api";
import type { LanguageConfig } from "./types";

/** 后端不可用时的本地兜底（与后端 default_languages 一致） */
export const DEFAULT_LANGUAGES: LanguageConfig[] = [
  { code: "en", name: "英语", short: "英" },
  { code: "fr", name: "法语", short: "法" },
  { code: "ja", name: "日语", short: "日" },
];

export type ThemeMode = "light" | "dark" | "system";
export type FontScale = "small" | "default" | "large";
export type Hand = "right" | "left";

export const FONT_ZOOM: Record<FontScale, number> = {
  small: 1.0,
  default: 1.1, // 默认比旧版页面大一点
  large: 1.25,
};

interface SettingsState {
  providers: ProviderView[];
  manifestUrl: string;
  /** 注册语言（source of truth 在后端 settings；加载失败保持默认三语并禁编辑） */
  languages: LanguageConfig[];
  /** 替换语言列表（POST 持久化；失败回滚并抛错） */
  setLanguages: (next: LanguageConfig[]) => Promise<void>;
  languagesFailed: boolean;
  loaded: boolean;
  reload: () => Promise<void>;
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  fontScale: FontScale;
  setFontScale: (f: FontScale) => void;
  /** 操作手性：right=主按钮/高频入口靠右（默认），left=靠左 */
  hand: Hand;
  setHand: (h: Hand) => void;
  /** 词典未命中时的 AI 补全：true=自动生成并入库（默认），false=结果页手动点按钮触发 */
  autoComplete: boolean;
  setAutoComplete: (v: boolean) => void;
  /** 全局 AI 选择：provider+model 组合，跨页面共享，localStorage 记忆上次选择 */
  aiChoice: { providerId: string; model: string };
  setAiChoice: (providerId: string, model: string) => void;
}

const Ctx = createContext<SettingsState>({
  providers: [],
  manifestUrl: "",
  languages: DEFAULT_LANGUAGES,
  setLanguages: async () => {},
  languagesFailed: false,
  loaded: false,
  reload: async () => {},
  theme: "system",
  setTheme: () => {},
  fontScale: "default",
  setFontScale: () => {},
  hand: "right",
  setHand: () => {},
  autoComplete: true,
  setAutoComplete: () => {},
  aiChoice: { providerId: "", model: "" },
  setAiChoice: () => {},
});

// 读偏好；valid 给出合法值白名单，脏值（手改/旧版本残留）直接回退
const readPref = <T extends string>(key: string, fallback: T, valid?: readonly T[]): T => {
  try {
    const v = localStorage.getItem(key) as T | undefined;
    if (!v) return fallback;
    if (valid && !valid.includes(v)) return fallback;
    return v;
  } catch {
    return fallback;
  }
};

const readJSON = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [manifestUrl, setManifestUrl] = useState("");
  const [languages, setLanguagesState] = useState<LanguageConfig[]>(DEFAULT_LANGUAGES);
  const [languagesFailed, setLanguagesFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [theme, setThemeState] = useState<ThemeMode>(() => readPref("podic.theme", "system", ["light", "dark", "system"]));
  const [fontScale, setFontScaleState] = useState<FontScale>(() => readPref("podic.font", "default", ["small", "default", "large"]));
  const [hand, setHandState] = useState<Hand>(() => readPref("podic.hand", "right", ["right", "left"]));
  const [autoComplete, setAutoCompleteState] = useState(() => readPref("podic.autocomplete", "on", ["on", "off"]) === "on");
  const [aiChoice, setAiChoiceState] = useState<{ providerId: string; model: string }>(() =>
    readJSON("podic.ai", { providerId: "", model: "" }),
  );

  const reload = useCallback(async () => {
    try {
      const s = await getSettings();
      setProviders(s.providers);
      setManifestUrl(s.manifest_url);
      if (Array.isArray(s.languages) && s.languages.length > 0) {
        setLanguagesState(s.languages);
        setLanguagesFailed(false);
      } else {
        setLanguagesFailed(true); // 语言列表异常：保持默认并禁止编辑（防误改坏状态）
      }
      // 校验记忆的选择是否仍有效，失效则回退到第一个 provider 的默认模型
      setAiChoiceState((prev) => {
        const p = s.providers.find((x) => x.id === prev.providerId);
        if (p && (prev.model ? p.models.includes(prev.model) : true)) {
          const model = prev.model || p.active_model || p.models[0] || "";
          return { providerId: p.id, model };
        }
        const p0 = s.providers[0];
        return p0 ? { providerId: p0.id, model: p0.active_model || p0.models[0] || "" } : { providerId: "", model: "" };
      });
    } catch {
      // 后端未起时静默
    } finally {
      setLoaded(true);
    }
  }, []);

  // 语言列表替换：本地先更（UI 即时反馈），POST 全量设置（providers/manifest 带现值，
  // 后端 languages 字段才替换）；失败回滚并抛错由调用方提示
  const setLanguages = useCallback(async (next: LanguageConfig[]) => {
    const prev = languages;
    setLanguagesState(next);
    try {
      // 只提交 languages：带上 providers/manifest_url 会把另一端刚保存的配置
      // 恢复成本端的旧快照（后端对省略字段保留现值）
      await saveSettings({ languages: next });
    } catch (e) {
      setLanguagesState(prev);
      throw e;
    }
  }, [languages]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 色彩模式：手动挡优先，跟随系统时监听系统变化，挂 .dark 类
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t);
    try {
      localStorage.setItem("podic.theme", t);
    } catch { /* 隐身模式等场景静默 */ }
  }, []);

  const setFontScale = useCallback((f: FontScale) => {
    setFontScaleState(f);
    try {
      localStorage.setItem("podic.font", f);
    } catch { /* 静默 */ }
  }, []);

  const setHand = useCallback((h: Hand) => {
    setHandState(h);
    try {
      localStorage.setItem("podic.hand", h);
    } catch { /* 静默 */ }
  }, []);

  const setAutoComplete = useCallback((v: boolean) => {
    setAutoCompleteState(v);
    try {
      localStorage.setItem("podic.autocomplete", v ? "on" : "off");
    } catch { /* 静默 */ }
  }, []);

  // 手性类挂 html，.action-row 等 CSS 按此切换布局
  useEffect(() => {
    document.documentElement.classList.toggle("hand-left", hand === "left");
  }, [hand]);

  const setAiChoice = useCallback((providerId: string, model: string) => {
    setAiChoiceState({ providerId, model });
    try {
      localStorage.setItem("podic.ai", JSON.stringify({ providerId, model }));
    } catch { /* 静默 */ }
  }, []);

  // value 是内联对象会让任一设置变化重渲染全部消费者（含每张词条卡的 AI 面板），memo 掉
  const value = useMemo(
    () => ({
      providers, manifestUrl, loaded, reload,
      languages, setLanguages, languagesFailed,
      theme, setTheme, fontScale, setFontScale,
      hand, setHand,
      autoComplete, setAutoComplete,
      aiChoice, setAiChoice,
    }),
    [providers, manifestUrl, loaded, reload, languages, setLanguages, languagesFailed, theme, setTheme, fontScale, setFontScale, hand, setHand, autoComplete, setAutoComplete, aiChoice, setAiChoice],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
    </Ctx.Provider>
  );
}

export function useSettings() {
  return useContext(Ctx);
}
