import type { Timeframe } from "@turtle/core";
import { TF_MS } from "./binance.js";

const CLOSE_DELAY_MS = 30_000; // wait 30s after close so the closed kline is final

/** ms until the next candle close (+delay) for a timeframe. */
export function msUntilNextClose(tf: Timeframe, now = Date.now()): number {
  const ms = TF_MS[tf];
  const nextClose = (Math.floor(now / ms) + 1) * ms;
  return nextClose + CLOSE_DELAY_MS - now;
}

/**
 * Run `fn` right after every candle close of `tf`. Self-rescheduling timer;
 * returns a cancel function.
 */
export function scheduleAtCloses(
  tf: Timeframe,
  fn: () => Promise<void>,
  onError: (e: Error) => void,
): () => void {
  let timer: NodeJS.Timeout;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    timer = setTimeout(async () => {
      try {
        await fn();
      } catch (e) {
        onError(e as Error);
      }
      arm();
    }, msUntilNextClose(tf));
  };
  arm();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

/** Simple fixed-interval loop with error isolation; returns cancel fn. */
export function every(intervalMs: number, fn: () => Promise<void>, onError: (e: Error) => void): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const tick = async () => {
    try {
      await fn();
    } catch (e) {
      onError(e as Error);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
