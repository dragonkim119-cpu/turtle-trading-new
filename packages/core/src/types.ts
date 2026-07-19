export interface Candle {
  openTime: number; // ms epoch, candle open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "4h" | "1d";
export type Side = "long" | "short";

export interface FilterConfig {
  adx: { on: boolean; period: number; min: number };
  volume: { on: boolean; period: number; mult: number };
  vwap: { on: boolean; bars: number };
  funding: { on: boolean; maxAbs: number }; // maxAbs as rate, e.g. 0.001 = 0.1%
  // OI confirmation: breakout should coincide with rising open interest (new money).
  // Like funding, no long historical series via free API -> live-only, default off.
  oi: { on: boolean; minChangePct: number }; // e.g. 0 => require OI change > 0%
}

export interface PartialTp {
  /** take partial profit when price reaches entry + atR * initialRisk */
  atR: number; // e.g. 1.0
  /** fraction of the position closed at the target, 0..1 */
  fraction: number; // e.g. 0.5
  /** after the partial fills, move the stop to breakeven (entry) for the rest */
  moveStopToBreakeven: boolean;
}

export interface TimeStop {
  /** exit if the trade has not reached +1R within this many bars */
  bars: number; // e.g. 12
}

export interface Params {
  entryPeriod: number; // Donchian entry channel (default 20)
  exitPeriod: number; // Donchian exit channel (default 10)
  atrPeriod: number; // default 20
  stopMult: number; // default 2.0
  emaPeriod: number; // default 200
  riskPct: number; // default 2 (% of equity)
  /** breakout must exceed the channel by this many ATRs (0 = plain breakout) */
  entryBufferAtr: number;
  /** partial profit taking; null = off (classic turtle) */
  partialTp: PartialTp | null;
  /** time-based exit; null = off. Backtest-gated before default-on. */
  timeStop: TimeStop | null;
  filters: FilterConfig;
}

export const DEFAULT_PARAMS: Params = {
  entryPeriod: 20,
  exitPeriod: 15, // cross-validated: 15 raised win rate + PF vs classic 10 across symbols/periods
  atrPeriod: 20,
  stopMult: 2.0,
  emaPeriod: 200,
  riskPct: 2,
  entryBufferAtr: 0.3, // cross-validated: 0.3×ATR breakout buffer filters marginal false breakouts
  // bank half at 1R. breakeven-stop OFF by default: cross-val showed it lifts win
  // rate + trims MDD but slightly lowers PF (clips recoveries) — opt in per symbol.
  partialTp: { atR: 1, fraction: 0.5, moveStopToBreakeven: false },
  timeStop: null, // off by default; adopt only if backtest gate passes

  filters: {
    adx: { on: true, period: 14, min: 20 },
    volume: { on: true, period: 20, mult: 1.5 },
    vwap: { on: true, bars: 30 },
    funding: { on: true, maxAbs: 0.001 },
    oi: { on: false, minChangePct: 0 }, // off by default; not long-backtestable
  },
};

export interface FilterCheck {
  name: "adx" | "volume" | "vwap" | "funding" | "oi";
  passed: boolean;
  value: number | null;
  detail: string;
}

export interface PosCtx {
  side: Side | null;
  entryPrice?: number;
  stop?: number;
}

export type SignalEvent =
  | {
      type: "ENTRY_LONG" | "ENTRY_SHORT";
      price: number;
      stop: number;
      atr: number;
      filters: FilterCheck[];
    }
  | { type: "ENTRY_BLOCKED"; dir: Side; price: number; filters: FilterCheck[] }
  | { type: "EXIT_LONG" | "EXIT_SHORT"; price: number }
  | { type: "TRAIL_UPDATE"; newStop: number; prevStop: number };
