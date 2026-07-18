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
}

export interface Params {
  entryPeriod: number; // Donchian entry channel (default 20)
  exitPeriod: number; // Donchian exit channel (default 10)
  atrPeriod: number; // default 20
  stopMult: number; // default 2.0
  emaPeriod: number; // default 200
  riskPct: number; // default 2 (% of equity)
  filters: FilterConfig;
}

export const DEFAULT_PARAMS: Params = {
  entryPeriod: 20,
  exitPeriod: 10,
  atrPeriod: 20,
  stopMult: 2.0,
  emaPeriod: 200,
  riskPct: 2,
  filters: {
    adx: { on: true, period: 14, min: 20 },
    volume: { on: true, period: 20, mult: 1.5 },
    vwap: { on: true, bars: 30 },
    funding: { on: true, maxAbs: 0.001 },
  },
};

export interface FilterCheck {
  name: "adx" | "volume" | "vwap" | "funding";
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
