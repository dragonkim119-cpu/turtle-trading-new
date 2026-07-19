"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  type IChartApi,
  type SeriesMarker,
  type Time,
  LineStyle,
} from "lightweight-charts";

interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Band {
  upper: number;
  lower: number;
}

export interface ChartSignal {
  event: string;
  candleTime: number;
  payload: { price?: number; stop?: number };
}

export interface ChartPosition {
  side: "long" | "short";
  entryPrice: number;
  stop: number;
}

export interface ChartData {
  candles: Candle[];
  overlays: {
    entryChannel: (Band | null)[];
    exitChannel: (Band | null)[];
    ema: (number | null)[];
    vwap: (number | null)[];
  };
  signals: ChartSignal[];
  position: ChartPosition | null;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// lightweight-charts renders time marks using UTC getters, so shift the
// timestamp by KST's offset to make the UTC-formatted label read as KST.
const t = (ms: number): Time => ((ms + KST_OFFSET_MS) / 1000) as Time;

function lineData(candles: Candle[], values: (number | null)[]) {
  const out: { time: Time; value: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = values[i];
    if (v !== null && v !== undefined) out.push({ time: t(candles[i].openTime), value: v });
  }
  return out;
}

interface OhlcInfo {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const LEGEND: { name: string; color: string; dashed?: boolean }[] = [
  { name: "진입상단", color: "rgba(38,166,154,0.9)" },
  { name: "진입하단", color: "rgba(239,83,80,0.9)" },
  { name: "청산하단", color: "rgba(38,166,154,0.9)", dashed: true },
  { name: "청산상단", color: "rgba(239,83,80,0.9)", dashed: true },
  { name: "EMA", color: "#e8a33d" },
  { name: "VWAP", color: "#4a90d9" },
];

export default function TurtleChart({ data }: { data: ChartData }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [hovered, setHovered] = useState<OhlcInfo | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { color: "#0b0e14" }, textColor: "#7a8194", fontSize: 11 },
      grid: {
        vertLines: { color: "#161b26" },
        horzLines: { color: "#161b26" },
      },
      timeScale: { timeVisible: true, borderColor: "#232838" },
      rightPriceScale: { borderColor: "#232838" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const { candles, overlays, signals, position } = data;

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    candleSeries.setData(
      candles.map((c) => ({
        time: t(c.openTime),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    const last = candles[candles.length - 1];
    if (last) {
      setHovered({ time: last.openTime, open: last.open, high: last.high, low: last.low, close: last.close });
    }
    chart.subscribeCrosshairMove((param) => {
      const bar = param.seriesData.get(candleSeries) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      if (!bar || param.time === undefined) {
        if (last) {
          setHovered({ time: last.openTime, open: last.open, high: last.high, low: last.low, close: last.close });
        }
        return;
      }
      setHovered({
        time: (param.time as number) * 1000,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });
    });

    const mk = (color: string, width: 2 | 3, style = LineStyle.Solid) =>
      chart.addLineSeries({
        color,
        lineWidth: width,
        lineStyle: style,
        priceLineVisible: false,
        lastValueVisible: false,
        title: "",
        crosshairMarkerVisible: false,
      });

    // Donchian entry channel (green/red band edges)
    mk("rgba(38,166,154,0.7)", 2, LineStyle.Solid).setData(
      lineData(candles, data.overlays.entryChannel.map((b) => b?.upper ?? null)),
    );
    mk("rgba(239,83,80,0.7)", 2, LineStyle.Solid).setData(
      lineData(candles, overlays.entryChannel.map((b) => b?.lower ?? null)),
    );
    // Exit channel dashed (상단=숏 청산 트리거, 하단=롱 청산 트리거)
    mk("rgba(38,166,154,0.7)", 2, LineStyle.Dashed).setData(
      lineData(candles, overlays.exitChannel.map((b) => b?.lower ?? null)),
    );
    mk("rgba(239,83,80,0.7)", 2, LineStyle.Dashed).setData(
      lineData(candles, overlays.exitChannel.map((b) => b?.upper ?? null)),
    );
    // EMA 200
    mk("#e8a33d", 3, LineStyle.Solid).setData(lineData(candles, overlays.ema));
    // Rolling VWAP
    mk("#4a90d9", 3, LineStyle.Solid).setData(lineData(candles, overlays.vwap));

    // Signal markers
    const markers: SeriesMarker<Time>[] = [];
    for (const s of signals) {
      if (s.event === "ENTRY_LONG")
        markers.push({ time: t(s.candleTime), position: "belowBar", color: "#26a69a", shape: "arrowUp", text: "롱" });
      else if (s.event === "ENTRY_SHORT")
        markers.push({ time: t(s.candleTime), position: "aboveBar", color: "#ef5350", shape: "arrowDown", text: "숏" });
      else if (s.event === "EXIT_LONG" || s.event === "EXIT_SHORT")
        markers.push({ time: t(s.candleTime), position: "aboveBar", color: "#7a8194", shape: "circle", text: "청산" });
      else if (s.event === "ENTRY_BLOCKED")
        markers.push({ time: t(s.candleTime), position: "belowBar", color: "#e8a33d", shape: "circle", text: "보류" });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    candleSeries.setMarkers(markers);

    // Open position lines
    if (position) {
      candleSeries.createPriceLine({
        price: position.entryPrice,
        color: "#4a90d9",
        lineStyle: LineStyle.Solid,
        lineWidth: 1,
        title: "진입",
      });
      candleSeries.createPriceLine({
        price: position.stop,
        color: "#ef5350",
        lineStyle: LineStyle.Dashed,
        lineWidth: 2,
        title: "손절",
      });
    }

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [data]);

  const up = hovered ? hovered.close >= hovered.open : true;

  const resetAutoScale = () => {
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "58vh", minHeight: 320 }}>
      <div ref={ref} style={{ width: "100%", height: "100%" }} />
      <div
        style={{
          position: "absolute",
          top: hovered ? 28 : 6,
          left: 8,
          zIndex: 10,
          display: "flex",
          flexWrap: "wrap",
          gap: "2px 10px",
          fontSize: 11,
          fontFamily: "monospace",
          color: "#7a8194",
          background: "rgba(11,14,20,0.6)",
          padding: "2px 6px",
          borderRadius: 4,
          pointerEvents: "none",
        }}
      >
        {LEGEND.map((l) => (
          <span key={l.name} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 0,
                borderTop: `2px ${l.dashed ? "dashed" : "solid"} ${l.color}`,
              }}
            />
            {l.name}
          </span>
        ))}
      </div>
      <button
        onClick={resetAutoScale}
        title="Y축 자동 스케일"
        style={{
          position: "absolute",
          bottom: 6,
          right: 8,
          zIndex: 10,
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1,
          color: "#7a8194",
          background: "rgba(11,14,20,0.7)",
          border: "1px solid #232838",
          borderRadius: 4,
          padding: "4px 7px",
          cursor: "pointer",
        }}
      >
        A
      </button>
      {hovered && (
        <div
          style={{
            position: "absolute",
            top: 6,
            left: 8,
            zIndex: 10,
            fontSize: 14,
            fontFamily: "monospace",
            color: up ? "#26a69a" : "#ef5350",
            background: "rgba(11,14,20,0.6)",
            padding: "2px 6px",
            borderRadius: 4,
            pointerEvents: "none",
          }}
        >
          O {hovered.open.toLocaleString()} H {hovered.high.toLocaleString()} L{" "}
          {hovered.low.toLocaleString()} C {hovered.close.toLocaleString()}
        </div>
      )}
    </div>
  );
}
