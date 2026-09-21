import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getSettings, type ProviderView } from "./api";

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
  loaded: boolean;
  reload: () => Promise<void>;
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  fontScale: FontScale;
  setFontScale: (f: FontScale) => void;
  /** 操作手性：right=主按钮/高频入口靠右（默认），left=靠左 */
  hand: Hand;
  setHand: (h: Hand) => void;
  /** 全局 AI 选择：provider+model 组合，跨页面共享，localStorage 记忆上次选择 */
  aiChoice: { providerId: string; model: string };
  setAiChoice: (providerId: string, model: string) => void;
}

const Ctx = createContext<SettingsState>({
  providers: [],
  manifestUrl: "",
  loaded: false,
  reload: async () => {},
  theme: "system",
  setTheme: () => {},
  fontScale: "default",
  setFontScale: () => {},
  hand: "right",
  setHand: () => {},
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
  const [loaded, setLoaded] = useState(false);
  const [theme, setThemeState] = useState<ThemeMode>(() => readPref("podic.theme", "system", ["light", "dark", "system"]));
  const [fontScale, setFontScaleState] = useState<FontScale>(() => readPref("podic.font", "default", ["small", "default", "large"]));
  const [hand, setHandState] = useState<Hand>(() => readPref("podic.hand", "right", ["right", "left"]));
  const [aiChoice, setAiChoiceState] = useState<{ providerId: string; model: string }>(() =>
    readJSON("podic.ai", { providerId: "", model: "" }),
  );

  const reload = useCallback(async () => {
    try {
      const s = await getSettings();
      setProviders(s.providers);
      setManifestUrl(s.manifest_url);
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
      theme, setTheme, fontScale, setFontScale,
      hand, setHand,
      aiChoice, setAiChoice,
    }),
    [providers, manifestUrl, loaded, reload, theme, setTheme, fontScale, setFontScale, hand, setHand, aiChoice, setAiChoice],
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
