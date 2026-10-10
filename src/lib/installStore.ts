import { useSyncExternalStore } from "react";
import type { InstallProgress } from "../api";

/** 全局安装任务状态：切页面不丢——词典页外也能看到进度，回来恢复显示。
 * 后端安装任务独立于前端页面生命周期，这里只是 UI 镜像。 */

export interface InstallState {
  /** 显示名（语言名或「自定义」） */
  label: string;
  lang: string;
  p: InstallProgress;
}

let current: InstallState | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function setInstall(s: InstallState | null) {
  current = s;
  emit();
}

export function useInstall(): InstallState | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
