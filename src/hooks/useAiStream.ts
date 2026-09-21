import { useCallback, useEffect, useRef, useState } from "react";
import { aiRun, type AiStreamHandle } from "../api";

const FLUSH_MS = 120;

export function useAiStream() {
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const handleRef = useRef<AiStreamHandle | null>(null);
  // SSE delta 攒批：每个 delta 都 setText 会让 Markdown 全量重 parse + DOM 重建（O(n²)），
  // 弱机 WebView 上明显卡顿；这里 120ms 批量刷一次
  const pendingRef = useRef("");
  const timerRef = useRef<number | undefined>(undefined);

  const flush = useCallback(() => {
    window.clearInterval(timerRef.current);
    timerRef.current = undefined;
    if (pendingRef.current) {
      const d = pendingRef.current;
      pendingRef.current = "";
      setText((t) => t + d);
    }
  }, []);

  useEffect(() => () => window.clearInterval(timerRef.current), []);

  const run = useCallback(
    async (
      task: "explain" | "examples" | "translate" | "fallback",
      input: string,
      opts?: { context?: unknown; provider_id?: string; model?: string; fresh?: boolean },
      onDone?: (full: string) => void,
    ) => {
      handleRef.current?.cancel();
      pendingRef.current = "";
      setText("");
      setError("");
      setRunning(true);
      let full = "";
      const handle = aiRun(
        {
          task,
          text: input,
          context: opts?.context,
          provider_id: opts?.provider_id ?? "",
          model: opts?.model,
          fresh: opts?.fresh,
        },
        (delta) => {
          full += delta;
          pendingRef.current += delta;
          if (timerRef.current === undefined) {
            timerRef.current = window.setInterval(() => {
              if (!pendingRef.current) return;
              const d = pendingRef.current;
              pendingRef.current = "";
              setText((t) => t + d);
            }, FLUSH_MS);
          }
        },
      );
      handleRef.current = handle;
      try {
        await handle.done;
        onDone?.(full);
      } catch (e) {
        if (!`${e}`.includes("abort")) setError(e instanceof Error ? e.message : String(e));
      } finally {
        flush(); // 冲掉缓冲里的尾巴，保证全文完整上屏
        setRunning(false);
        handleRef.current = null;
      }
    },
    [flush],
  );

  const cancel = useCallback(() => {
    handleRef.current?.cancel();
    flush();
    setRunning(false);
  }, [flush]);

  const reset = useCallback(() => {
    pendingRef.current = "";
    setText("");
    setError("");
  }, []);

  return { text, running, error, run, cancel, reset, setText };
}
