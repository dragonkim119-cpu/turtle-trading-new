import type { Candle, Timeframe } from "@turtle/core";

const BASE = "https://fapi.binance.com";

export interface BinanceClient {
  fetchKlines(symbol: string, tf: Timeframe, limit: number, endTime?: number): Promise<Candle[]>;
  fetchMarkPrice(symbol: string): Promise<number>;
  fetchFunding(symbol: string): Promise<number | null>;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
    }
  }
  throw lastErr;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Binance ${res.status} ${url}: ${await res.text()}`);
  return res.json();
}

export function createBinanceClient(): BinanceClient {
  return {
    async fetchKlines(symbol, tf, limit, endTime) {
      return withRetry(async () => {
        let url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`;
        if (endTime !== undefined) url += `&endTime=${endTime}`;
        const rows = (await getJson(url)) as unknown[][];
        return rows.map((r) => ({
          openTime: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        }));
      });
    },
    async fetchMarkPrice(symbol) {
      return withRetry(async () => {
        const d = (await getJson(`${BASE}/fapi/v1/premiumIndex?symbol=${symbol}`)) as {
          markPrice: string;
        };
        return Number(d.markPrice);
      });
    },
    async fetchFunding(symbol) {
      try {
        const d = (await getJson(`${BASE}/fapi/v1/premiumIndex?symbol=${symbol}`)) as {
          lastFundingRate?: string;
        };
        const r = Number(d.lastFundingRate);
        return Number.isFinite(r) ? r : null;
      } catch {
        return null; // funding unavailable -> filter passes with note
      }
    },
  };
}

export const TF_MS: Record<Timeframe, number> = {
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

/** Open time of the last fully closed candle for a timeframe (UTC-aligned). */
export function lastClosedOpenTime(tf: Timeframe, now: number): number {
  const ms = TF_MS[tf];
  return Math.floor(now / ms) * ms - ms;
}
