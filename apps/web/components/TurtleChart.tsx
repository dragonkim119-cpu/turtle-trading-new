"use client";

import { useEffect, useRef } from "react";
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

const t = (ms: number): Time => (ms / 1000) as Time;

function lineData(candles: Candle[], values: (number | null)[]) {
  const out: { time: Time; value: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = values[i];
    if (v !== null && v !== undefined) out.push({ time: t(candles[i].openTime), value: v });
  }
  return out;
}

export default function TurtleChart({ data }: { data: ChartData }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

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

    const mk = (color: string, width: 1 | 2, style = LineStyle.Solid, title = "") =>
      chart.addLineSeries({
        color,
        lineWidth: width,
        lineStyle: style,
        priceLineVisible: false,
        lastValueVisible: false,
        title,
        crosshairMarkerVisible: false,
      });

    // Donchian entry channel (green/red band edges)
    mk("rgba(38,166,154,0.7)", 1, LineStyle.Solid, "진입상단").setData(
      lineData(candles, data.overlays.entryChannel.map((b) => b?.upper ?? null)),
    );
    mk("rgba(239,83,80,0.7)", 1, LineStyle.Solid, "진입하단").setData(
      lineData(candles, overlays.entryChannel.map((b) => b?.lower ?? null)),
    );
    // Exit channel dashed
    mk("rgba(122,129,148,0.6)", 1, LineStyle.Dashed, "청산하단").setData(
      lineData(candles, overlays.exitChannel.map((b) => b?.lower ?? null)),
    );
    mk("rgba(122,129,148,0.6)", 1, LineStyle.Dashed, "청산상단").setData(
      lineData(candles, overlays.exitChannel.map((b) => b?.upper ?? null)),
    );
    // EMA 200
    mk("#e8a33d", 2, LineStyle.Solid, "EMA").setData(lineData(candles, overlays.ema));
    // Rolling VWAP
    mk("#4a90d9", 2, LineStyle.Solid, "VWAP").setData(lineData(candles, overlays.vwap));

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

  return <div ref={ref} style={{ width: "100%", height: "58vh", minHeight: 320 }} />;
}
