import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "@turtle/core";
import { openDb } from "../src/schema.js";
import { Repo } from "../src/repo.js";

function repo() {
  return new Repo(openDb(":memory:"));
}

describe("Repo", () => {
  it("watchlist add/remove", () => {
    const r = repo();
    r.addSymbol("btcusdt");
    r.addSymbol("ETHUSDT");
    expect(r.getWatchlist()).toEqual(["BTCUSDT", "ETHUSDT"]);
    r.removeSymbol("BTCUSDT");
    expect(r.getWatchlist()).toEqual(["ETHUSDT"]);
    r.addSymbol("BTCUSDT"); // re-enable
    expect(r.getWatchlist()).toContain("BTCUSDT");
  });

  it("params default + upsert roundtrip", () => {
    const r = repo();
    expect(r.getParams("BTCUSDT", "4h")).toEqual(DEFAULT_PARAMS);
    const p = { ...structuredClone(DEFAULT_PARAMS), entryPeriod: 55 };
    r.upsertParams("BTCUSDT", "4h", p);
    expect(r.getParams("BTCUSDT", "4h").entryPeriod).toBe(55);
    expect(r.getParams("BTCUSDT", "1d").entryPeriod).toBe(20);
  });

  it("params saved before a new filter (e.g. oi) was added still merge in the new default", () => {
    const r = repo();
    // simulate a row saved by an older app version whose filters object lacks `oi`
    const old = structuredClone(DEFAULT_PARAMS) as Partial<typeof DEFAULT_PARAMS>;
    const oldFilters = old.filters as Partial<(typeof DEFAULT_PARAMS)["filters"]>;
    delete oldFilters.oi;
    r.upsertParams("ETHUSDT", "4h", old as typeof DEFAULT_PARAMS);
    const loaded = r.getParams("ETHUSDT", "4h");
    expect(loaded.filters.oi).toEqual(DEFAULT_PARAMS.filters.oi);
    expect(loaded.filters.adx).toEqual(DEFAULT_PARAMS.filters.adx);
  });

  it("signal unique key dedupe", () => {
    const r = repo();
    const id1 = r.insertSignal("BTCUSDT", "4h", "ENTRY_LONG", 1000, { price: 1 });
    const dup = r.insertSignal("BTCUSDT", "4h", "ENTRY_LONG", 1000, { price: 1 });
    const other = r.insertSignal("BTCUSDT", "4h", "ENTRY_LONG", 2000, { price: 2 });
    expect(id1).not.toBeNull();
    expect(dup).toBeNull();
    expect(other).not.toBeNull();
    expect(r.listSignals()).toHaveLength(2);
  });

  it("position lifecycle with stop history", () => {
    const r = repo();
    const id = r.openPosition({
      symbol: "BTCUSDT",
      timeframe: "4h",
      side: "long",
      entryPrice: 65000,
      qty: 0.1,
      stop: 63560,
    });
    expect(r.getOpenPosition("BTCUSDT", "4h")?.id).toBe(id);
    r.updateStop(id, 64200);
    const pos = r.getOpenPosition("BTCUSDT", "4h")!;
    expect(pos.stop).toBe(64200);
    expect(pos.stopHistory).toHaveLength(2);
    // initial risk = |65000 - 63560| = 1440
    expect(pos.initialRisk).toBe(1440);
    r.closePosition(id, 66000, "channel_exit");
    expect(r.getOpenPosition("BTCUSDT", "4h")).toBeNull();
    const closed = r.listPositions()[0];
    expect(closed.status).toBe("closed");
    // realized R = (66000-65000)/1440 = 0.694...
    expect(closed.realizedR).toBeCloseTo((66000 - 65000) / 1440, 4);
  });

  it("stores and reads back a feature snapshot on a signal", () => {
    const r = repo();
    const snap = { dir: "long", breakoutStrengthAtr: 1.2, adx: 28 };
    const id = r.insertSignal("BTCUSDT", "4h", "ENTRY_LONG", 1000, { price: 1 }, snap);
    expect(id).not.toBeNull();
    const rows = r.listSignals();
    expect(rows[0].featureSnapshot).toEqual(snap);
    // null snapshot when omitted
    r.insertSignal("BTCUSDT", "4h", "EXIT_LONG", 2000, { price: 2 });
    expect(r.listSignals().find((s) => s.event === "EXIT_LONG")!.featureSnapshot).toBeNull();
  });

  it("news dedupe by link", () => {
    const r = repo();
    const a = r.insertNews({ source: "coindesk", title: "t", link: "http://x/1", pubDate: null, matched: true, keywords: ["트럼프"] });
    const b = r.insertNews({ source: "coindesk", title: "t", link: "http://x/1", pubDate: null, matched: false, keywords: [] });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(r.listNews()).toHaveLength(1);
  });

  it("settings + engine state", () => {
    const r = repo();
    expect(r.getSetting("equity")).toBeNull();
    r.setSetting("equity", "100000000");
    r.setSetting("equity", "50000000");
    expect(r.getSetting("equity")).toBe("50000000");
    r.setState("lastProcessed:BTCUSDT:4h", "12345");
    expect(r.getState("lastProcessed:BTCUSDT:4h")).toBe("12345");
  });
});
