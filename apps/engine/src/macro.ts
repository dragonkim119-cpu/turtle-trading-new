import type { Repo } from "@turtle/db";

/**
 * Macro snapshot collector (DISPLAY ONLY — never gates signals). Pulls daily
 * values for DXY / VIX / US 10Y from FRED's free public CSV (no API key, no
 * anti-bot). Stored to macro_snapshots for the web macro card. Per-symbol
 * failures are isolated so one bad feed doesn't stop the rest.
 */
export interface MacroSource {
  symbol: string; // our label
  fred: string; // FRED series id
}

export const MACRO_SOURCES: MacroSource[] = [
  { symbol: "DXY", fred: "DTWEXBGS" }, // Broad USD index
  { symbol: "VIX", fred: "VIXCLS" }, // volatility index
  { symbol: "US10Y", fred: "DGS10" }, // US 10-year yield
];

export interface MacroDeps {
  repo: Repo;
  fetchCsv?: (url: string) => Promise<string>;
  log?: (msg: string) => void;
}

/**
 * Parse a FRED daily CSV -> the most recent row with a numeric value.
 * FRED marks missing values with "." — those rows are skipped.
 * Header is `observation_date,SERIESID` (older files use `DATE`).
 */
export function parseFredDaily(csv: string): { date: string; value: number } | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  for (let i = lines.length - 1; i >= 1; i--) {
    const [date, raw] = lines[i].split(",");
    const value = Number(raw);
    if (date && raw !== "." && Number.isFinite(value)) return { date, value };
  }
  return null;
}

export async function pollMacro(deps: MacroDeps): Promise<void> {
  const { repo } = deps;
  const log = deps.log ?? (() => {});
  const fetchCsv =
    deps.fetchCsv ??
    (async (url: string) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`fred ${res.status}`);
      return res.text();
    });

  for (const src of MACRO_SOURCES) {
    try {
      const csv = await fetchCsv(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${src.fred}`);
      const row = parseFredDaily(csv);
      if (row) repo.upsertMacro(src.symbol, row.date, row.value);
    } catch (e) {
      log(`macro ${src.symbol}: ${(e as Error).message}`);
    }
  }
}
