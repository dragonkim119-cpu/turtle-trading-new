import { DEFAULT_PARAMS, type Params, type Side, type Timeframe } from "@turtle/core";
import type { DB } from "./schema.js";

export interface SignalRow {
  id: number;
  symbol: string;
  timeframe: Timeframe;
  event: string;
  candleTime: number;
  payload: unknown;
  delivered: number;
  createdAt: number;
}

export interface PositionRow {
  id: number;
  symbol: string;
  timeframe: Timeframe;
  side: Side;
  entryPrice: number;
  qty: number;
  stop: number;
  status: "open" | "closed";
  stopHistory: { stop: number; at: number }[];
  openedAt: number;
  closedAt: number | null;
  closePrice: number | null;
  closeReason: string | null;
  partialTpTarget: number | null;
  partialDone: number;
}

export interface NewsRow {
  id: number;
  source: string;
  title: string;
  link: string;
  pubDate: number | null;
  matched: number;
  keywords: string;
  createdAt: number;
}

export class Repo {
  constructor(private db: DB) {}

  // --- watchlist ---
  getWatchlist(): string[] {
    return (
      this.db.prepare("SELECT symbol FROM symbols WHERE enabled=1 ORDER BY symbol").all() as {
        symbol: string;
      }[]
    ).map((r) => r.symbol);
  }
  addSymbol(symbol: string): void {
    this.db
      .prepare("INSERT INTO symbols(symbol,enabled) VALUES(?,1) ON CONFLICT(symbol) DO UPDATE SET enabled=1")
      .run(symbol.toUpperCase());
  }
  removeSymbol(symbol: string): void {
    this.db.prepare("UPDATE symbols SET enabled=0 WHERE symbol=?").run(symbol.toUpperCase());
  }

  // --- settings ---
  getSetting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }
  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  // --- params ---
  getParams(symbol: string, timeframe: Timeframe): Params {
    const r = this.db
      .prepare("SELECT json FROM params WHERE symbol=? AND timeframe=?")
      .get(symbol, timeframe) as { json: string } | undefined;
    if (!r) return structuredClone(DEFAULT_PARAMS);
    return { ...structuredClone(DEFAULT_PARAMS), ...JSON.parse(r.json) };
  }
  upsertParams(symbol: string, timeframe: Timeframe, params: Params): void {
    this.db
      .prepare(
        "INSERT INTO params(symbol,timeframe,json) VALUES(?,?,?) ON CONFLICT(symbol,timeframe) DO UPDATE SET json=excluded.json",
      )
      .run(symbol, timeframe, JSON.stringify(params));
  }

  // --- signals ---
  /** Returns true if newly inserted, false if duplicate (already sent). */
  insertSignal(
    symbol: string,
    timeframe: Timeframe,
    event: string,
    candleTime: number,
    payload: unknown,
  ): number | null {
    try {
      const res = this.db
        .prepare(
          "INSERT INTO signals(symbol,timeframe,event,candleTime,payload,createdAt) VALUES(?,?,?,?,?,?)",
        )
        .run(symbol, timeframe, event, candleTime, JSON.stringify(payload), Date.now());
      return Number(res.lastInsertRowid);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("UNIQUE")) return null;
      throw e;
    }
  }
  markDelivered(id: number, ok: boolean): void {
    this.db.prepare("UPDATE signals SET delivered=? WHERE id=?").run(ok ? 1 : -1, id);
  }
  listSignals(limit = 100): SignalRow[] {
    const rows = this.db
      .prepare("SELECT * FROM signals ORDER BY createdAt DESC LIMIT ?")
      .all(limit) as (Omit<SignalRow, "payload"> & { payload: string })[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  // --- positions ---
  openPosition(p: {
    symbol: string;
    timeframe: Timeframe;
    side: Side;
    entryPrice: number;
    qty: number;
    stop: number;
    partialTpTarget?: number | null;
  }): number {
    const res = this.db
      .prepare(
        "INSERT INTO positions(symbol,timeframe,side,entryPrice,qty,stop,stopHistory,openedAt,partialTpTarget) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        p.symbol,
        p.timeframe,
        p.side,
        p.entryPrice,
        p.qty,
        p.stop,
        JSON.stringify([{ stop: p.stop, at: Date.now() }]),
        Date.now(),
        p.partialTpTarget ?? null,
      );
    return Number(res.lastInsertRowid);
  }
  markPartialDone(id: number): void {
    this.db.prepare("UPDATE positions SET partialDone=1 WHERE id=?").run(id);
  }
  updateStop(id: number, newStop: number): void {
    const row = this.db.prepare("SELECT stopHistory FROM positions WHERE id=?").get(id) as
      | { stopHistory: string }
      | undefined;
    if (!row) return;
    const hist = JSON.parse(row.stopHistory) as { stop: number; at: number }[];
    hist.push({ stop: newStop, at: Date.now() });
    this.db
      .prepare("UPDATE positions SET stop=?, stopHistory=? WHERE id=?")
      .run(newStop, JSON.stringify(hist), id);
  }
  closePosition(id: number, closePrice: number, reason: string): void {
    this.db
      .prepare("UPDATE positions SET status='closed', closedAt=?, closePrice=?, closeReason=? WHERE id=?")
      .run(Date.now(), closePrice, reason, id);
  }
  listOpenPositions(): PositionRow[] {
    return this.rowsToPositions(
      this.db.prepare("SELECT * FROM positions WHERE status='open' ORDER BY openedAt DESC").all(),
    );
  }
  listPositions(limit = 100): PositionRow[] {
    return this.rowsToPositions(
      this.db.prepare("SELECT * FROM positions ORDER BY openedAt DESC LIMIT ?").all(limit),
    );
  }
  getOpenPosition(symbol: string, timeframe: Timeframe): PositionRow | null {
    const rows = this.rowsToPositions(
      this.db
        .prepare("SELECT * FROM positions WHERE status='open' AND symbol=? AND timeframe=?")
        .all(symbol, timeframe),
    );
    return rows[0] ?? null;
  }
  private rowsToPositions(rows: unknown[]): PositionRow[] {
    return (rows as (Omit<PositionRow, "stopHistory"> & { stopHistory: string })[]).map((r) => ({
      ...r,
      stopHistory: JSON.parse(r.stopHistory),
    }));
  }

  // --- news ---
  /** Returns id if inserted, null if duplicate link. */
  insertNews(n: {
    source: string;
    title: string;
    link: string;
    pubDate: number | null;
    matched: boolean;
    keywords: string[];
  }): number | null {
    try {
      const res = this.db
        .prepare(
          "INSERT INTO news_items(source,title,link,pubDate,matched,keywords,createdAt) VALUES(?,?,?,?,?,?,?)",
        )
        .run(n.source, n.title, n.link, n.pubDate, n.matched ? 1 : 0, n.keywords.join(","), Date.now());
      return Number(res.lastInsertRowid);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("UNIQUE")) return null;
      throw e;
    }
  }
  listNews(limit = 100): NewsRow[] {
    return this.db
      .prepare("SELECT * FROM news_items ORDER BY COALESCE(pubDate, createdAt) DESC LIMIT ?")
      .all(limit) as NewsRow[];
  }

  // --- engine state ---
  getState(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM engine_state WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }
  setState(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO engine_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }
}
