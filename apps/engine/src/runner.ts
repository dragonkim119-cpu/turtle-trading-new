import { judgeClose, type PosCtx, type Timeframe } from "@turtle/core";
import type { Repo } from "@turtle/db";
import { lastClosedOpenTime, type BinanceClient } from "./binance.js";
import { fmtEvent, fmtStopHit, type TelegramSender } from "./telegram.js";
import type { Health } from "./health.js";

const CANDLE_FETCH = 320; // covers EMA200 + VWAP(30d on 4h = 180 bars) with margin

export interface RunnerDeps {
  repo: Repo;
  binance: BinanceClient;
  telegram: TelegramSender;
  health: Health;
  log?: (msg: string) => void;
}

function notifyEnabled(repo: Repo, kind: string): boolean {
  // settings key notif:<kind> = 'off' disables; default on
  return repo.getSetting(`notif:${kind}`) !== "off";
}

const EVENT_NOTIF_KIND: Record<string, string> = {
  ENTRY_LONG: "entry",
  ENTRY_SHORT: "entry",
  ENTRY_BLOCKED: "blocked",
  EXIT_LONG: "exit",
  EXIT_SHORT: "exit",
  TRAIL_UPDATE: "trail",
};

/**
 * Process one (symbol, timeframe) at candle close. Fetches candles, judges the
 * last closed candle, persists + notifies events, updates engine state.
 * Catch-up: judges every closed candle after lastProcessed (max 10 to bound).
 */
export async function processSymbol(
  deps: RunnerDeps,
  symbol: string,
  tf: Timeframe,
  now = Date.now(),
): Promise<void> {
  const { repo, binance, telegram, health } = deps;
  const log = deps.log ?? (() => {});

  const lastClosed = lastClosedOpenTime(tf, now);
  const stateKey = `lastProcessed:${symbol}:${tf}`;
  const prev = Number(repo.getState(stateKey) ?? 0);
  if (prev >= lastClosed) return; // already processed

  let candles;
  let funding: number | null;
  try {
    candles = await binance.fetchKlines(symbol, tf, CANDLE_FETCH);
    funding = await binance.fetchFunding(symbol);
    health.apiOk();
  } catch (e) {
    await health.apiFail(`klines ${symbol} ${tf}: ${(e as Error).message}`);
    return;
  }

  // Drop the still-open candle if present (its openTime > lastClosed means partial).
  while (candles.length && candles[candles.length - 1].openTime > lastClosed) {
    candles.pop();
  }
  if (!candles.length) return;

  // Determine closed candles needing judgment (catch-up after downtime).
  // First-ever run (no state): judge only the latest closed candle — replaying
  // history would spam alerts for long-past breakouts.
  const pending = candles
    .map((c, idx) => ({ openTime: c.openTime, idx }))
    .filter((c) => c.openTime > prev && c.openTime <= lastClosed)
    .slice(prev === 0 ? -1 : -10);

  for (const { openTime, idx } of pending) {
    const window = candles.slice(0, idx + 1);
    const params = repo.getParams(symbol, tf);
    const open = repo.getOpenPosition(symbol, tf);
    const pos: PosCtx = open
      ? { side: open.side, entryPrice: open.entryPrice, stop: open.stop }
      : { side: null };

    const events = judgeClose(pos, window, params, funding);
    for (const ev of events) {
      const id = repo.insertSignal(symbol, tf, ev.type, openTime, ev);
      if (id === null) continue; // duplicate — already handled
      log(`${symbol} ${tf} ${ev.type} @candle ${new Date(openTime).toISOString()}`);

      // Apply position side-effects for registered positions.
      if (ev.type === "TRAIL_UPDATE" && open) {
        repo.updateStop(open.id, ev.newStop);
      }

      const kind = EVENT_NOTIF_KIND[ev.type];
      if (kind && notifyEnabled(repo, kind)) {
        const equity = Number(repo.getSetting("equity") ?? 0) || null;
        const ok = await telegram.send(
          fmtEvent(ev, {
            symbol,
            timeframe: tf,
            equity,
            riskPct: params.riskPct,
            stopMult: params.stopMult,
          }),
        );
        repo.markDelivered(id, ok);
        if (!ok) health.telegramFail();
      }
    }
    repo.setState(stateKey, String(openTime));
  }
}

/** Intraday stop monitor tick: check mark price against open position stops. */
export async function checkStops(deps: RunnerDeps): Promise<void> {
  const { repo, binance, telegram, health } = deps;
  const open = repo.listOpenPositions();
  if (!open.length) return;

  for (const pos of open) {
    let mark: number;
    try {
      mark = await binance.fetchMarkPrice(pos.symbol);
      health.apiOk();
    } catch (e) {
      await health.apiFail(`markPrice ${pos.symbol}: ${(e as Error).message}`);
      continue;
    }
    const hit = pos.side === "long" ? mark <= pos.stop : mark >= pos.stop;
    if (!hit) continue;

    // Unique per position+stop level so a re-check doesn't re-alert.
    const id = repo.insertSignal(pos.symbol, pos.timeframe, `STOP_HIT:${pos.id}`, Math.round(pos.stop * 1e8), {
      positionId: pos.id,
      mark,
      stop: pos.stop,
    });
    if (id === null) continue;
    if (notifyEnabled(repo, "stop")) {
      const ok = await telegram.send(fmtStopHit(pos.symbol, pos.timeframe, pos.side, mark, pos.stop));
      repo.markDelivered(id, ok);
      if (!ok) health.telegramFail();
    }
  }
}
