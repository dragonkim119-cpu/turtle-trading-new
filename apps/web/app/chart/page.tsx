"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { ChartData } from "../../components/TurtleChart.js";
import ParamsSheet from "../../components/ParamsSheet.js";

const TurtleChart = dynamic(() => import("../../components/TurtleChart.js"), { ssr: false });

interface CandlesResp {
  symbol: string;
  tf: string;
  funding: number | null;
  params: { atrPeriod: number; entryPeriod: number; filters: { adx: { min: number } } };
  candles: ChartData["candles"];
  overlays: ChartData["overlays"] & { atr: (number | null)[]; adx: (number | null)[] };
}

export default function ChartPage() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [tf, setTf] = useState<"4h" | "1d">("4h");
  const [resp, setResp] = useState<CandlesResp | null>(null);
  const [signals, setSignals] = useState<ChartData["signals"]>([]);
  const [position, setPosition] = useState<ChartData["position"]>(null);
  const [showParams, setShowParams] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/watchlist")
      .then((r) => r.json())
      .then((d) => setSymbols(d.symbols ?? []));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cRes, sRes, pRes] = await Promise.all([
        fetch(`/api/candles?symbol=${symbol}&tf=${tf}&limit=500`),
        fetch(`/api/signals?limit=500`),
        fetch(`/api/positions`),
      ]);
      const c = (await cRes.json()) as CandlesResp;
      const s = await sRes.json();
      const p = await pRes.json();
      setResp(c);
      setSignals(
        (s.signals ?? []).filter(
          (x: { symbol: string; timeframe: string }) => x.symbol === symbol && x.timeframe === tf,
        ),
      );
      const open = (p.positions ?? []).find(
        (x: { symbol: string; timeframe: string; status: string }) =>
          x.symbol === symbol && x.timeframe === tf && x.status === "open",
      );
      setPosition(open ? { side: open.side, entryPrice: open.entryPrice, stop: open.stop } : null);
    } finally {
      setLoading(false);
    }
  }, [symbol, tf]);

  useEffect(() => {
    load();
  }, [load]);

  const last = resp?.candles[resp.candles.length - 1];
  const atrV = resp?.overlays.atr[resp.overlays.atr.length - 1];
  const adxV = resp?.overlays.adx[resp.overlays.adx.length - 1];
  const band = resp?.overlays.entryChannel[resp.overlays.entryChannel.length - 1];
  const distToBreakout =
    last && band ? (((band.upper - last.close) / last.close) * 100).toFixed(2) : null;

  return (
    <div>
      <div className="row" style={{ padding: "10px 10px 0" }}>
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} style={{ flex: 2 }}>
          {[...new Set([symbol, ...symbols])].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <div className="seg" style={{ flex: 1 }}>
          {(["4h", "1d"] as const).map((x) => (
            <button key={x} className={tf === x ? "on" : ""} onClick={() => setTf(x)}>
              {x.toUpperCase()}
            </button>
          ))}
        </div>
        <button className="secondary" onClick={() => setShowParams(true)}>
          ⚙
        </button>
      </div>

      {resp ? <TurtleChart data={{ candles: resp.candles, overlays: resp.overlays, signals, position }} /> : (
        <p className="muted" style={{ padding: 20 }}>{loading ? "차트 로딩 중..." : "데이터 없음"}</p>
      )}

      {resp && last && (
        <div className="card row" style={{ gap: 14 }}>
          <span className="muted mono">종가 {last.close.toLocaleString()}</span>
          <span className="muted mono">ATR {atrV ? atrV.toFixed(1) : "-"}</span>
          <span className="muted mono">
            ADX{" "}
            {adxV ? (
              <b style={{ color: adxV >= 20 ? "var(--green)" : "var(--amber)" }}>{adxV.toFixed(1)}</b>
            ) : (
              "-"
            )}
          </span>
          <span className="muted mono">
            펀딩 {resp.funding !== null ? (resp.funding * 100).toFixed(4) + "%" : "-"}
          </span>
          {distToBreakout && (
            <span className="muted mono">돌파까지 {distToBreakout}%</span>
          )}
        </div>
      )}

      {showParams && (
        <ParamsSheet
          symbol={symbol}
          tf={tf}
          onClose={() => {
            setShowParams(false);
            load();
          }}
        />
      )}
    </div>
  );
}
