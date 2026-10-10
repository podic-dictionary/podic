import { useSyncExternalStore } from "react";

/// 设置页未保存标记（跨组件：SettingsView 写入，App 的 tab 切换拦截读取）。
/// 与 installStore 同款极简 store
let dirty = false;
const subs = new Set<() => void>();

export const setSettingsDirty = (v: boolean) => {
  if (dirty === v) return;
  dirty = v;
  subs.forEach((fn) => fn());
};

export const isSettingsDirty = () => dirty;

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

export const useSettingsDirty = () => useSyncExternalStore(subscribe, isSettingsDirty);
