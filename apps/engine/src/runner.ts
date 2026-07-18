import {
  DEFAULT_PORTFOLIO_GATE,
  evaluatePortfolioGate,
  featureSnapshot,
  judgeClose,
  type GateResult,
  type PortfolioGateConfig,
  type PosCtx,
  type Side,
  type Timeframe,
} from "@turtle/core";
import type { Repo } from "@turtle/db";
import { lastClosedOpenTime, type BinanceClient } from "./binance.js";
import { computePortfolioState } from "./portfolioState.js";
import { fmtEvent, fmtGate, fmtPartialTp, fmtStopHit, type TelegramSender } from "./telegram.js";
import type { Health } from "./health.js";

/** Read portfolio gate config from settings JSON (fallback to defaults). */
function gateConfig(repo: Repo): PortfolioGateConfig {
  const raw = repo.getSetting("portfolioGate");
  if (!raw) return DEFAULT_PORTFOLIO_GATE;
  try {
    return { ...DEFAULT_PORTFOLIO_GATE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PORTFOLIO_GATE;
  }
}

/** Evaluate the portfolio gate for a prospective entry using live DB state. */
function evaluateEntryGate(repo: Repo, dir: Side, riskPct: number): GateResult {
  const equity = Number(repo.getSetting("equity") ?? 0);
  if (equity <= 0) {
    return { demote: false, halveRisk: false, reasons: [], warnings: [] };
  }
  const state = computePortfolioState(repo, equity, riskPct, Date.now());
  return evaluatePortfolioGate(dir, state, gateConfig(repo));
}

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
      // Capture a feature snapshot + evaluate the portfolio gate for entries.
      let snapshot: unknown = null;
      let gate: GateResult | null = null;
      if (ev.type === "ENTRY_LONG" || ev.type === "ENTRY_SHORT") {
        const dir = ev.type === "ENTRY_LONG" ? "long" : "short";
        snapshot = featureSnapshot(dir, window, window.length - 1, params, funding);
        gate = evaluateEntryGate(repo, dir, params.riskPct);
      }

      // Store gate result alongside the event payload (for web display).
      const payload = gate ? { ...ev, gate } : ev;
      const id = repo.insertSignal(symbol, tf, ev.type, openTime, payload, snapshot);
      if (id === null) continue; // duplicate — already handled
      log(
        `${symbol} ${tf} ${ev.type}${gate?.demote ? " [강등]" : ""} @candle ${new Date(openTime).toISOString()}`,
      );

      // Apply position side-effects for registered positions.
      if (ev.type === "TRAIL_UPDATE" && open) {
        repo.updateStop(open.id, ev.newStop);
      }

      const kind = EVENT_NOTIF_KIND[ev.type];
      if (kind && notifyEnabled(repo, kind)) {
        const equity = Number(repo.getSetting("equity") ?? 0) || null;
        let msg = fmtEvent(ev, {
          symbol,
          timeframe: tf,
          equity,
          riskPct: params.riskPct,
          stopMult: params.stopMult,
        });
        if (gate && (gate.reasons.length || gate.warnings.length)) {
          const { prefix, suffix } = fmtGate(gate.reasons, gate.warnings);
          msg = prefix + msg + suffix;
        }
        const ok = await telegram.send(msg);
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

    // Partial take-profit: 1R target reached and not yet banked.
    if (pos.partialTpTarget !== null && pos.partialDone === 0) {
      const reached =
        pos.side === "long" ? mark >= pos.partialTpTarget : mark <= pos.partialTpTarget;
      if (reached) {
        const params = repo.getParams(pos.symbol, pos.timeframe);
        const frac = params.partialTp?.fraction ?? 0.5;
        // Move remaining stop to breakeven if configured (ratchet: never loosen).
        let movedBreakeven = false;
        if (params.partialTp?.moveStopToBreakeven) {
          const be =
            pos.side === "long"
              ? Math.max(pos.stop, pos.entryPrice)
              : Math.min(pos.stop, pos.entryPrice);
          if (be !== pos.stop) {
            repo.updateStop(pos.id, be);
            movedBreakeven = true;
          }
        }
        const id = repo.insertSignal(pos.symbol, pos.timeframe, `PARTIAL_TP:${pos.id}`, pos.id, {
          positionId: pos.id,
          target: pos.partialTpTarget,
          mark,
          fraction: frac,
          movedBreakeven,
        });
        if (id !== null) {
          repo.markPartialDone(pos.id);
          if (notifyEnabled(repo, "partial")) {
            const ok = await telegram.send(
              fmtPartialTp(pos.symbol, pos.timeframe, pos.side, pos.partialTpTarget, mark, frac, movedBreakeven),
            );
            repo.markDelivered(id, ok);
            if (!ok) health.telegramFail();
          }
        }
      }
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
