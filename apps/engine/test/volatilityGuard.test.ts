import { describe, expect, it, vi } from "vitest";
import { openDb, Repo } from "@turtle/db";
import type { Candle } from "@turtle/core";
import { inCooldown, runVolGuard, type GuardDeps } from "../src/volatilityGuard.js";
import { checkStops, checkTimeStop, processSymbol, type RunnerDeps } from "../src/runner.js";
import { Health } from "../src/health.js";

function oneMin(closes: number[], startMs: number): Candle[] {
  return closes.map((c, i) => ({
    openTime: startMs + i * 60_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 100,
  }));
}

function deps(one: Candle[]) {
  const repo = new Repo(openDb(":memory:"));
  repo.addSymbol("BTCUSDT");
  const telegram = { send: vi.fn(async () => true) };
  const binance = {
    fetchKlines: vi.fn(async () => []),
    fetchKlinesRaw: vi.fn(async () => one.map((c) => ({ ...c }))),
    fetchMarkPrice: vi.fn(async () => 0),
    fetchFunding: vi.fn(async () => null),
    fetchOiChangePct: vi.fn(async () => null),
  };
  const health = new Health(repo, telegram);
  return { repo, telegram, binance, health };
}

describe("runVolGuard", () => {
  it("alerts on a 1m spike, arms cooldown, dedupes next tick", async () => {
    // calm then a -2.4% drop; last (open) candle dropped by guard so append a filler
    const now = 100 * 60_000 + 30_000; // 30s into a minute
    const calm = [100, 100.1, 99.95, 100.05, 100, 100.1, 99.9, 97.5];
    const one = oneMin(calm, now - calm.length * 60_000);
    // ensure last candle is "closed" (openTime <= now-60_000): the filler open candle
    one.push({ openTime: now - 30_000, open: 97.5, high: 97.6, low: 97.4, close: 97.5, volume: 100 });
    const d = deps(one);
    const g: GuardDeps = d;

    await runVolGuard(g, now);
    expect(d.telegram.send).toHaveBeenCalledTimes(1);
    expect(d.telegram.send.mock.calls[0][0]).toContain("이상변동");
    expect(inCooldown(d.repo, "BTCUSDT", now)).toBe(true);

    await runVolGuard(g, now); // same 1m candle -> dedupe
    expect(d.telegram.send).toHaveBeenCalledTimes(1);
  });

  it("no alert on calm 1m series", async () => {
    const now = 100 * 60_000 + 30_000;
    const calm = [100, 100.05, 99.98, 100.02, 100, 100.03, 99.99, 100.01];
    const one = oneMin(calm, now - calm.length * 60_000);
    one.push({ openTime: now - 30_000, open: 100, high: 100, low: 100, close: 100, volume: 100 });
    const d = deps(one);
    await runVolGuard(d, now);
    expect(d.telegram.send).not.toHaveBeenCalled();
    expect(inCooldown(d.repo, "BTCUSDT", now)).toBe(false);
  });
});

describe("checkStops stop-proximity pre-warning", () => {
  function stopDeps() {
    const repo = new Repo(openDb(":memory:"));
    const telegram = { send: vi.fn(async () => true) };
    const binance = {
      fetchKlines: vi.fn(async () => []),
      fetchKlinesRaw: vi.fn(async () => []),
      fetchMarkPrice: vi.fn(async () => 0),
      fetchFunding: vi.fn(async () => null),
      fetchOiChangePct: vi.fn(async () => null),
    };
    const health = new Health(repo, telegram);
    const runnerDeps: RunnerDeps = { repo, binance, telegram, health };
    return { repo, telegram, binance, health, runnerDeps };
  }

  it("warns once when mark is within 0.3R of the stop", async () => {
    const d = stopDeps();
    // entry 100 stop 95 -> initRisk 5; 0.3R = 1.5 -> warn zone is stop..96.5
    d.repo.openPosition({ symbol: "BTCUSDT", timeframe: "4h", side: "long", entryPrice: 100, qty: 1, stop: 95 });
    d.binance.fetchMarkPrice.mockResolvedValue(96); // dist 1.0 <= 1.5
    await checkStops(d.runnerDeps);
    await checkStops(d.runnerDeps); // dedupe
    const warns = d.telegram.send.mock.calls.filter((c) => c[0].includes("손절선 임박"));
    expect(warns).toHaveLength(1);
  });

  it("no pre-warning when comfortably above stop", async () => {
    const d = stopDeps();
    d.repo.openPosition({ symbol: "BTCUSDT", timeframe: "4h", side: "long", entryPrice: 100, qty: 1, stop: 95 });
    d.binance.fetchMarkPrice.mockResolvedValue(99); // dist 4 > 1.5
    await checkStops(d.runnerDeps);
    expect(d.telegram.send).not.toHaveBeenCalled();
  });
});

describe("checkTimeStop", () => {
  function tsDeps() {
    const repo = new Repo(openDb(":memory:"));
    const telegram = { send: vi.fn(async () => true) };
    const binance = {
      fetchKlines: vi.fn(async () => []),
      fetchKlinesRaw: vi.fn(async () => []),
      fetchMarkPrice: vi.fn(async () => 0),
      fetchFunding: vi.fn(async () => null),
      fetchOiChangePct: vi.fn(async () => null),
    };
    const health = new Health(repo, telegram);
    const runnerDeps: RunnerDeps = { repo, binance, telegram, health };
    return { repo, telegram, runnerDeps };
  }

  const openPos = {
    id: 1,
    symbol: "BTCUSDT",
    timeframe: "4h" as const,
    side: "long" as const,
    entryPrice: 100,
    qty: 1,
    stop: 95,
    status: "open" as const,
    stopHistory: [],
    openedAt: 0,
    closedAt: null,
    closePrice: null,
    closeReason: null,
    partialTpTarget: null,
    partialDone: 0,
    initialRisk: 5, // 1R target = 105
    realizedR: null,
  };

  function flat(n: number): Candle[] {
    // n bars from openTime 0, never reaching 105
    return Array.from({ length: n }, (_, i) => ({
      openTime: i * 60_000,
      open: 101,
      high: 102,
      low: 100,
      close: 101,
      volume: 100,
    }));
  }

  it("fires once after N bars without +1R, dedupes on re-check", async () => {
    const d = tsDeps();
    const w = flat(13); // 12 bars since entry bar
    await checkTimeStop(d.runnerDeps, openPos, w, 12);
    await checkTimeStop(d.runnerDeps, openPos, w, 12);
    const alerts = d.telegram.send.mock.calls.filter((c) => c[0].includes("타임스톱"));
    expect(alerts).toHaveLength(1);
  });

  it("does not fire if +1R was reached", async () => {
    const d = tsDeps();
    const w = flat(13);
    w[5] = { ...w[5], high: 110 }; // reached 1R (>=105) at bar 5
    await checkTimeStop(d.runnerDeps, openPos, w, 12);
    expect(d.telegram.send).not.toHaveBeenCalled();
  });

  it("does not fire before N bars elapse", async () => {
    const d = tsDeps();
    await checkTimeStop(d.runnerDeps, openPos, flat(6), 12); // only 5 bars since entry
    expect(d.telegram.send).not.toHaveBeenCalled();
  });
});
