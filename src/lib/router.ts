import { useEffect, useState } from "react";

/** 轻量 hash 路由：每个页面有自己 URL（网页刷新不回首页；App 壳 deeplink 统一改 hash 跳转）。
 * 形如 `#/search?q=x&lang=en`、`#/settings/languages`、`#/packs/install` */

export interface Route {
  /** 路径段：["search"] / ["settings", "languages"] / ["packs", "install"] */
  path: string[];
  params: URLSearchParams;
}

export function parseHash(hash: string = window.location.hash): Route {
  const h = hash.replace(/^#\/?/, "");
  const [p, q = ""] = h.split("?");
  return {
    path: p.split("/").filter(Boolean),
    params: new URLSearchParams(q),
  };
}

export function navigate(path: string, params?: Record<string, string | undefined>) {
  const q = params
    ? new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][],
      ).toString()
    : "";
  const url = `#/${path.replace(/^\//, "")}${q ? `?${q}` : ""}`;
  // 不用 location.hash 赋值：它会产生一条 state=null 的匿名 history 条目，
  // 返回键 pop 到它时会被当成「跨出应用」误弹退出确认。这里用 replaceState
  // 原地改地址（tab 级切换不该有新 history 条目）；若 hash 变化引起页面状态
  // 变化，App 的返回栈 effect 会自行 pushState 入栈。hashchange 需手动派发
  history.replaceState(history.state, "", url);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** hashchange 驱动的路由状态；同 hash 重复 navigate 不触发 */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash());
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
