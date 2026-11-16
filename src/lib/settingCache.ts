/** 设置项缓存：服务端配置需要在组件外高频读取时（每帧挂载的朗读按钮等）用。
 *
 * 手写「let xCache + xLoading ??= getSettings()」有两个坑，这里统一兜住：
 * 1. 在途加载晚于保存返回时，旧值会覆盖刚保存的新值——version 守卫：
 *    加载期间发生过 set 就丢弃加载结果
 * 2. 没有变更通知，展示缓存值的 UI 永远陈旧且无从发现——set 即广播
 *
 * 使用约定见 AGENTS.md「设置读取」；scripts/check-frontend-caches.sh 挡回归
 */
export interface SettingCache<T> {
  get(): Promise<T>;
  /** 保存成功后写入：覆盖在途加载并广播订阅者 */
  set(v: T): void;
  /** 当前值；未加载完成时为 null */
  peek(): T | null;
  /** 订阅变更；返回取消函数 */
  subscribe(l: (v: T) => void): () => void;
}

export function makeSettingCache<T>(load: () => Promise<T>, fallback: T): SettingCache<T> {
  let value: T | null = null;
  let version = 0;
  let inFlight: Promise<T> | null = null;
  const listeners = new Set<(v: T) => void>();
  // 单个订阅者抛异常不得断掉对其他订阅者的广播，也不能把 set()/加载链变成 reject
  const notify = (v: T) => {
    listeners.forEach((l) => {
      try {
        l(v);
      } catch {
        // 订阅方自己的问题，吞掉；组件 setter 正常不会抛
      }
    });
  };

  const get = (): Promise<T> => {
    if (value !== null) return Promise.resolve(value);
    if (!inFlight) {
      const startVersion = ++version;
      inFlight = load()
        .then(
          (loaded) => {
            if (version === startVersion) {
              value = loaded;
              notify(loaded);
            }
            // set() 已在加载期间写入：await 的调用方拿到新值而非陈旧加载结果
            return value ?? loaded;
          },
          () => {
            if (version === startVersion) value = fallback;
            return value ?? fallback;
          },
        )
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  const set = (v: T) => {
    value = v;
    version++; // 作废在途加载：晚归的旧结果不得覆盖刚保存的值
    inFlight = null;
    notify(v);
  };

  const subscribe = (l: (v: T) => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };

  return { get, set, peek: () => value, subscribe };
}
