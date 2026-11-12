import { useSyncExternalStore } from "react";

/// 生词本子页（练习/词汇自测）是否有进行中的会话：面板写入，App 的返回键
/// 拦截读取（进行中退出要确认，避免误触丢掉剩余题目）。与 dirtyStore 同款极简 store
let active = false;
const subs = new Set<() => void>();

export const setPracticeActive = (v: boolean) => {
  if (active === v) return;
  active = v;
  subs.forEach((fn) => fn());
};

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

export const usePracticeActive = () => useSyncExternalStore(subscribe, () => active);
