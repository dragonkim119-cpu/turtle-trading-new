import { describe, expect, it, vi } from "vitest";
import { openDb, Repo } from "@turtle/db";
import type { Candle } from "@turtle/core";
import { checkStops, processSymbol, type RunnerDeps } from "../src/runner.js";
import { Health } from "../src/health.js";
import { msUntilNextClose } from "../src/scheduler.js";
import { lastClosedOpenTime, TF_MS } from "../src/binance.js";
import { matchKeywords, pollRss } from "../src/rss.js";

const H4 = TF_MS["4h"];

function mkCandles(n: number, lastOpenTime: number, breakoutLast: boolean): Candle[] {
  // gently rising series, above-EMA; final candle breaks prior 20-high if breakoutLast
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i * 0.1;
    out.push({
      openTime: lastOpenTime - (n - 1 - i) * H4,
      open: base,
      high: base + 1,
      low: base - 1,
      close: base,
      volume: 100,
    });
  }
  if (breakoutLast) {
    const last = out[out.length - 1];
    last.close = last.high = 100 + n * 0.1 + 50; // decisive breakout
    last.volume = 1000; // strong volume
  }
  return out;
}

function mkDeps(candles: Candle[]) {
  const repo = new Repo(openDb(":memory:"));
  const sent: string[] = [];
  const telegram = { send: vi.fn(async (t: string) => (sent.push(t), true)) };
  const binance = {
    fetchKlines: vi.fn(async () => candles.map((c) => ({ ...c }))),
    fetchMarkPrice: vi.fn(async () => 0),
    fetchFunding: vi.fn(async () => 0.0001),
  };
  const health = new Health(repo, telegram);
  const deps: RunnerDeps = { repo, binance, telegram, health };
  return { repo, telegram, binance, deps, sent };
}

describe("processSymbol", () => {
  it("emits entry signal on breakout, persists, notifies, and dedupes on rerun", async () => {
    const now = Math.floor(Date.now() / H4) * H4 + 60_000; // just after a close
    const lastClosed = lastClosedOpenTime("4h", now);
    const candles = mkCandles(300, lastClosed, true);
    const { repo, telegram, deps } = mkDeps(candles);
    // disable ADX (needs organic trend), keep volume+vwap on to prove filters pass
    const p = repo.getParams("BTCUSDT", "4h");
    p.filters.adx.on = false;
    repo.upsertParams("BTCUSDT", "4h", p);

    await processSymbol(deps, "BTCUSDT", "4h", now);

    const signals = repo.listSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].event).toBe("ENTRY_LONG");
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send.mock.calls[0][0]).toContain("롱 진입 신호");
    expect(telegram.send.mock.calls[0][0]).toContain("BTCUSDT");

    // rerun: lastProcessed state short-circuits, no dup
    await processSymbol(deps, "BTCUSDT", "4h", now);
    expect(repo.listSignals()).toHaveLength(1);
    expect(telegram.send).toHaveBeenCalledTimes(1);
  });

  it("no signal without breakout", async () => {
    const now = Math.floor(Date.now() / H4) * H4 + 60_000;
    const lastClosed = lastClosedOpenTime("4h", now);
    const { repo, deps } = mkDeps(mkCandles(300, lastClosed, false));
    await processSymbol(deps, "BTCUSDT", "4h", now);
    expect(repo.listSignals()).toHaveLength(0);
  });

  it("trailing update mutates registered position stop", async () => {
    const now = Math.floor(Date.now() / H4) * H4 + 60_000;
    const lastClosed = lastClosedOpenTime("4h", now);
    const candles = mkCandles(300, lastClosed, false); // rising series
    const { repo, deps } = mkDeps(candles);
    const posId = repo.openPosition({
      symbol: "BTCUSDT",
      timeframe: "4h",
      side: "long",
      entryPrice: 100,
      qty: 1,
      stop: 50, // far below 10-bar low -> trail must ratchet up
    });
    await processSymbol(deps, "BTCUSDT", "4h", now);
    const signals = repo.listSignals();
    expect(signals.some((s) => s.event === "TRAIL_UPDATE")).toBe(true);
    const pos = repo.listPositions().find((p) => p.id === posId)!;
    expect(pos.stop).toBeGreaterThan(50);
    expect(pos.stopHistory.length).toBeGreaterThan(1);
  });
});

describe("checkStops", () => {
  it("alerts once when mark crosses stop", async () => {
    const { repo, telegram, binance, deps } = mkDeps([]);
    repo.openPosition({
      symbol: "BTCUSDT",
      timeframe: "4h",
      side: "long",
      entryPrice: 100,
      qty: 1,
      stop: 95,
    });
    binance.fetchMarkPrice.mockResolvedValue(94);
    await checkStops(deps);
    await checkStops(deps); // second tick must not re-alert
    const stopAlerts = telegram.send.mock.calls.filter((c) => c[0].includes("손절선 도달"));
    expect(stopAlerts).toHaveLength(1);
  });

  it("no alert while mark above stop (long)", async () => {
    const { repo, telegram, binance, deps } = mkDeps([]);
    repo.openPosition({
      symbol: "BTCUSDT",
      timeframe: "4h",
      side: "long",
      entryPrice: 100,
      qty: 1,
      stop: 95,
    });
    binance.fetchMarkPrice.mockResolvedValue(96);
    await checkStops(deps);
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it("alerts partial TP once when mark reaches 1R target, then marks done", async () => {
    const { repo, telegram, binance, deps } = mkDeps([]);
    // entry 100, stop 95 -> risk 5 -> 1R target 105
    const id = repo.openPosition({
      symbol: "BTCUSDT",
      timeframe: "4h",
      side: "long",
      entryPrice: 100,
      qty: 1,
      stop: 95,
      partialTpTarget: 105,
    });
    binance.fetchMarkPrice.mockResolvedValue(106);
    await checkStops(deps);
    await checkStops(deps); // second tick must not re-alert
    const ptAlerts = telegram.send.mock.calls.filter((c) => c[0].includes("부분 익절 도달"));
    expect(ptAlerts).toHaveLength(1);
    expect(repo.listPositions().find((p) => p.id === id)!.partialDone).toBe(1);
  });

  it("moves stop to breakeven on partial TP when configured", async () => {
    const { repo, telegram, binance, deps } = mkDeps([]);
    const p = repo.getParams("BTCUSDT", "4h");
    p.partialTp = { atR: 1, fraction: 0.5, moveStopToBreakeven: true };
    repo.upsertParams("BTCUSDT", "4h", p);
    const id = repo.openPosition({
      symbol: "BTCUSDT",
      timeframe: "4h",
      side: "long",
      entryPrice: 100,
      qty: 1,
      stop: 95,
      partialTpTarget: 105,
    });
    binance.fetchMarkPrice.mockResolvedValue(106);
    await checkStops(deps);
    const pos = repo.listPositions().find((x) => x.id === id)!;
    expect(pos.stop).toBe(100); // moved from 95 to breakeven (entry)
    expect(pos.stopHistory.length).toBe(2);
    expect(telegram.send.mock.calls[0][0]).toContain("본전");
  });

  it("does not move stop to breakeven when option is off", async () => {
    const { repo, binance, deps } = mkDeps([]);
    // default params: moveStopToBreakeven false
    const id = repo.openPosition({
      symbol: "BTCUSDT",
      timeframe: "4h",
      side: "long",
      entryPrice: 100,
      qty: 1,
      stop: 95,
      partialTpTarget: 105,
    });
    binance.fetchMarkPrice.mockResolvedValue(106);
    await checkStops(deps);
    expect(repo.listPositions().find((x) => x.id === id)!.stop).toBe(95); // unchanged
  });

  it("does not fire partial TP before target reached", async () => {
    const { repo, telegram, binance, deps } = mkDeps([]);
    repo.openPosition({
      symbol: "BTCUSDT",
      timeframe: "4h",
      side: "long",
      entryPrice: 100,
      qty: 1,
      stop: 95,
      partialTpTarget: 105,
    });
    binance.fetchMarkPrice.mockResolvedValue(103);
    await checkStops(deps);
    expect(telegram.send).not.toHaveBeenCalled();
  });
});

describe("scheduler", () => {
  it("msUntilNextClose lands just after a boundary", () => {
    const now = 1_700_000_000_000;
    const ms = msUntilNextClose("4h", now);
    const target = now + ms;
    expect((target - 30_000) % H4).toBe(0);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(H4 + 30_000);
  });
});

describe("rss", () => {
  it("keyword match is case-insensitive", () => {
    expect(matchKeywords("Trump imposes new tariff", ["트럼프", "trump", "관세", "tariff"])).toEqual([
      "trump",
      "tariff",
    ]);
    expect(matchKeywords("평화로운 하루", ["트럼프"])).toEqual([]);
  });

  it("inserts news, alerts only matches, dedupes by link", async () => {
    const repo = new Repo(openDb(":memory:"));
    const telegram = { send: vi.fn(async () => true) };
    const items = [
      { title: "트럼프 관세 발표", link: "http://n/1", isoDate: "2026-07-18T00:00:00Z" },
      { title: "일반 시황 뉴스", link: "http://n/2", isoDate: "2026-07-18T00:00:00Z" },
    ];
    const deps = {
      repo,
      telegram,
      sources: [{ name: "test", url: "http://feed" }],
      fetchFeed: async () => items,
    };
    await pollRss(deps);
    expect(repo.listNews()).toHaveLength(2);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send.mock.calls[0][0]).toContain("트럼프");
    await pollRss(deps); // dedupe: no new inserts, no new alerts
    expect(repo.listNews()).toHaveLength(2);
    expect(telegram.send).toHaveBeenCalledTimes(1);
  });
});
