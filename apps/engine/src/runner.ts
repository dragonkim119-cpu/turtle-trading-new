import {
  DEFAULT_PORTFOLIO_GATE,
  evaluatePortfolioGate,
  featureSnapshot,
  judgeClose,
  type Candle,
  type GateResult,
  type PortfolioGateConfig,
  type PosCtx,
  type Side,
  type Timeframe,
} from "@turtle/core";
import type { Repo } from "@turtle/db";
import { lastClosedOpenTime, type BinanceClient } from "./binance.js";
import { computePortfolioState } from "./portfolioState.js";
import { inCooldown } from "./volatilityGuard.js";
import {
  fmtEvent,
  fmtGate,
  fmtPartialTp,
  fmtStopHit,
  fmtStopNear,
  fmtTimeStop,
  type TelegramSender,
} from "./telegram.js";
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

/**
 * Evaluate the entry gate for a prospective entry: portfolio risk (if equity
 * set) plus a post-spike volatility cooldown. Both only demote, never block.
 */
function evaluateEntryGate(repo: Repo, symbol: string, dir: Side, riskPct: number): GateResult {
  const equity = Number(repo.getSetting("equity") ?? 0);
  const gate: GateResult =
    equity > 0
      ? evaluatePortfolioGate(dir, computePortfolioState(repo, equity, riskPct, Date.now()), gateConfig(repo))
      : { demote: false, halveRisk: false, reasons: [], warnings: [] };

  if (inCooldown(repo, symbol, Date.now())) {
    return {
      ...gate,
      demote: true,
      reasons: [...gate.reasons, "1분 급변 직후 쿨다운 — 진입 비권장"],
    };
  }
  return gate;
}

const CANDLE_FETCH = 320; // covers EMA200 + VWAP(30d on 4h = 180 bars) with margin
const REGIME_FETCH = 220; // covers EMA200 + margin on daily bars

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
  let oiChangePct: number | null = null;
  let higherTfCandles: Candle[] | undefined;
  try {
    candles = await binance.fetchKlines(symbol, tf, CANDLE_FETCH);
    funding = await binance.fetchFunding(symbol);
    const params0 = repo.getParams(symbol, tf);
    // OI only fetched when the filter is enabled for this symbol/timeframe.
    if (params0.filters.oi.on) {
      oiChangePct = await binance.fetchOiChangePct(symbol);
    }
    // Regime only meaningful on 4h (1d has no higher timeframe here).
    if (tf === "4h" && params0.filters.regime.on) {
      higherTfCandles = await binance.fetchKlines(symbol, "1d", REGIME_FETCH);
    }
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
      ? { side: open.side, entryPrice: open.entryPrice, stop: open.stop, entryTime: open.openedAt }
      : { side: null };

    const events = judgeClose(pos, window, params, funding, oiChangePct, higherTfCandles);
    for (const ev of events) {
      // Capture a feature snapshot + evaluate the portfolio gate for entries.
      let snapshot: unknown = null;
      let gate: GateResult | null = null;
      if (ev.type === "ENTRY_LONG" || ev.type === "ENTRY_SHORT") {
        const dir = ev.type === "ENTRY_LONG" ? "long" : "short";
        snapshot = featureSnapshot(dir, window, window.length - 1, params, funding, oiChangePct);
        gate = evaluateEntryGate(repo, symbol, dir, params.riskPct);
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

    // Time stop (opt-in): registered position that hasn't reached +1R within N bars.
    if (open && params.timeStop) {
      await checkTimeStop(deps, open, window, params.timeStop.bars);
    }
    repo.setState(stateKey, String(openTime));
  }
}

/**
 * Emit a one-time time-stop exit recommendation when an open position has gone
 * `bars` closed candles since entry without ever reaching +1R. Mirrors the
 * backtest time-stop rule. Dedupe: unique per position id.
 */
export async function checkTimeStop(
  deps: RunnerDeps,
  open: NonNullable<ReturnType<Repo["getOpenPosition"]>>,
  window: import("@turtle/core").Candle[],
  bars: number,
): Promise<void> {
  const { repo, telegram, health } = deps;
  const initRisk = open.initialRisk ?? Math.abs(open.entryPrice - open.stop);
  if (initRisk <= 0) return;

  // Candles at/after entry registration; the first is the entry bar (bar 0).
  const since = window.filter((c) => c.openTime >= open.openedAt);
  const barsSince = since.length - 1;
  if (barsSince < bars) return;

  const oneR = open.side === "long" ? open.entryPrice + initRisk : open.entryPrice - initRisk;
  const reached1R = since.some((c) => (open.side === "long" ? c.high >= oneR : c.low <= oneR));
  if (reached1R) return;

  const last = window[window.length - 1];
  const id = repo.insertSignal(open.symbol, open.timeframe, `TIME_STOP:${open.id}`, open.openedAt, {
    positionId: open.id,
    bars: barsSince,
    price: last.close,
  });
  if (id === null) return;
  if (repo.getSetting("notif:timestop") !== "off") {
    const ok = await telegram.send(
      fmtTimeStop(open.symbol, open.timeframe, open.side, barsSince, last.close),
    );
    repo.markDelivered(id, ok);
    if (!ok) health.telegramFail();
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
    if (!hit) {
      // Stop-proximity pre-warning: within 0.3×initial risk of the stop, once per stop level.
      const initRisk = pos.initialRisk ?? Math.abs(pos.entryPrice - pos.stop);
      const dist = pos.side === "long" ? mark - pos.stop : pos.stop - mark;
      if (initRisk > 0 && dist > 0 && dist <= 0.3 * initRisk) {
        const nid = repo.insertSignal(
          pos.symbol,
          pos.timeframe,
          `STOP_NEAR:${pos.id}`,
          Math.round(pos.stop * 1e8),
          { positionId: pos.id, mark, stop: pos.stop },
        );
        if (nid !== null && notifyEnabled(repo, "stopnear")) {
          const ok = await telegram.send(
            fmtStopNear(pos.symbol, pos.timeframe, pos.side, mark, pos.stop),
          );
          repo.markDelivered(nid, ok);
          if (!ok) health.telegramFail();
        }
      }
      continue;
    }

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
