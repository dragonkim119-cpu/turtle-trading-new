import { DEFAULT_VOL_GUARD, oneMinAnomaly, type VolGuardConfig } from "@turtle/core";
import type { Repo } from "@turtle/db";
import type { BinanceClient } from "./binance.js";
import { fmtVolSpike, type TelegramSender } from "./telegram.js";
import type { Health } from "./health.js";

export interface GuardDeps {
  repo: Repo;
  binance: BinanceClient;
  telegram: TelegramSender;
  health: Health;
  log?: (msg: string) => void;
}

/** Cooldown state key: an entry within this window is demoted after a spike. */
export function cooldownKey(symbol: string): string {
  return `cooldown:${symbol}`;
}

/** Whether a symbol is currently in a post-spike entry cooldown. */
export function inCooldown(repo: Repo, symbol: string, nowMs: number): boolean {
  const until = Number(repo.getState(cooldownKey(symbol)) ?? 0);
  return nowMs < until;
}

function guardConfig(repo: Repo): VolGuardConfig {
  const raw = repo.getSetting("volGuard");
  if (!raw) return DEFAULT_VOL_GUARD;
  try {
    return { ...DEFAULT_VOL_GUARD, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_VOL_GUARD;
  }
}

/**
 * One guard tick: for each watchlist symbol, fetch recent 1m candles, detect
 * an abnormal move, and on a spike send an alert + arm an entry cooldown.
 * Defensive only — never emits a trade signal. Dedupe by 1m candle time.
 */
export async function runVolGuard(deps: GuardDeps, nowMs = Date.now()): Promise<void> {
  const { repo, binance, telegram, health } = deps;
  const log = deps.log ?? (() => {});
  const cfg = guardConfig(repo);
  if (!cfg.on) return;

  const alertsOn = repo.getSetting("notif:volspike") !== "off";

  for (const symbol of repo.getWatchlist()) {
    let candles;
    try {
      candles = await binance.fetchKlinesRaw(symbol, "1m", cfg.bars + 5);
      health.apiOk();
    } catch (e) {
      await health.apiFail(`1m ${symbol}: ${(e as Error).message}`);
      continue;
    }
    // drop the still-open last 1m candle
    if (candles.length && candles[candles.length - 1].openTime > nowMs - 60_000) candles.pop();
    if (candles.length < 3) continue;

    const anomaly = oneMinAnomaly(candles, cfg);
    if (!anomaly.spike) continue;

    const candleTime = candles[candles.length - 1].openTime;
    const id = repo.insertSignal(symbol, "1m" as never, "VOL_SPIKE", candleTime, {
      pct: anomaly.pct,
      baselinePct: anomaly.baselinePct,
    });
    if (id === null) continue; // already alerted for this 1m candle

    // arm entry cooldown
    repo.setState(cooldownKey(symbol), String(nowMs + cfg.cooldownMin * 60_000));
    log(`${symbol} VOL_SPIKE ${anomaly.pct.toFixed(2)}% (baseline ${anomaly.baselinePct.toFixed(2)}%)`);

    if (alertsOn) {
      const ok = await telegram.send(
        fmtVolSpike(symbol, anomaly.pct, anomaly.baselinePct, cfg.cooldownMin),
      );
      repo.markDelivered(id, ok);
      if (!ok) health.telegramFail();
    }
  }
}
