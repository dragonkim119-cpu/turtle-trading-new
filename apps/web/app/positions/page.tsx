"use client";

import { useCallback, useEffect, useState } from "react";

interface Pos {
  id: number;
  symbol: string;
  timeframe: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  stop: number;
  status: string;
  openedAt: number;
  closePrice: number | null;
  closeReason: string | null;
}

export default function PositionsPage() {
  const [positions, setPositions] = useState<Pos[]>([]);
  const [equity, setEquity] = useState("");
  const [form, setForm] = useState({
    symbol: "BTCUSDT",
    timeframe: "4h",
    side: "long",
    entryPrice: "",
    qty: "",
    stop: "",
  });
  const [msg, setMsg] = useState("");
  const [calc, setCalc] = useState<{ atr: number | null; riskPct: number; stopMult: number }>({
    atr: null,
    riskPct: 2,
    stopMult: 2,
  });

  const load = useCallback(() => {
    fetch("/api/positions")
      .then((r) => r.json())
      .then((d) => setPositions(d.positions ?? []));
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => setEquity(d.settings?.equity ?? ""));
  }, []);

  useEffect(load, [load]);

  // pull ATR for the calculator whenever symbol/tf changes
  useEffect(() => {
    fetch(`/api/candles?symbol=${form.symbol}&tf=${form.timeframe}&limit=300`)
      .then((r) => r.json())
      .then((d) => {
        const atrArr = d.overlays?.atr ?? [];
        const atrV = atrArr[atrArr.length - 1] ?? null;
        setCalc({ atr: atrV, riskPct: d.params?.riskPct ?? 2, stopMult: d.params?.stopMult ?? 2 });
        const last = d.candles?.[d.candles.length - 1];
        if (last && atrV) {
          setForm((f) => ({
            ...f,
            entryPrice: f.entryPrice || String(last.close),
            stop:
              f.stop ||
              String(
                f.side === "long"
                  ? (last.close - atrV * (d.params?.stopMult ?? 2)).toFixed(2)
                  : (last.close + atrV * (d.params?.stopMult ?? 2)).toFixed(2),
              ),
          }));
        }
      })
      .catch(() => {});
  }, [form.symbol, form.timeframe, form.side]);

  const eq = Number(equity) || 0;
  const suggestedQty =
    eq > 0 && calc.atr ? (eq * (calc.riskPct / 100)) / (calc.atr * calc.stopMult) : null;

  const submit = async () => {
    setMsg("");
    const res = await fetch("/api/positions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        entryPrice: Number(form.entryPrice),
        qty: Number(form.qty),
        stop: Number(form.stop),
      }),
    });
    const d = await res.json();
    setMsg(res.ok ? "포지션 등록 완료 — 손절/트레일링 감시 시작" : d.error ?? "오류");
    load();
  };

  const close = async (p: Pos) => {
    const price = prompt(`${p.symbol} 청산 가격 입력:`);
    if (!price) return;
    await fetch("/api/positions", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: p.id, closePrice: Number(price), reason: "manual" }),
    });
    load();
  };

  const open = positions.filter((p) => p.status === "open");
  const closed = positions.filter((p) => p.status !== "open");

  return (
    <div>
      <h1>포지션</h1>

      <div className="card">
        <h2>수동 포지션 등록 + 2% 계산기</h2>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>심볼</label>
            <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>타임프레임</label>
            <select value={form.timeframe} onChange={(e) => setForm({ ...form, timeframe: e.target.value })}>
              <option value="4h">4H</option>
              <option value="1d">1D</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>방향</label>
            <select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value })}>
              <option value="long">롱</option>
              <option value="short">숏</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>진입가</label>
            <input type="number" value={form.entryPrice} onChange={(e) => setForm({ ...form, entryPrice: e.target.value })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>손절가</label>
            <input type="number" value={form.stop} onChange={(e) => setForm({ ...form, stop: e.target.value })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>수량</label>
            <input type="number" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          </div>
        </div>
        {suggestedQty !== null && (
          <p className="muted" style={{ marginTop: 8 }}>
            💡 2% 룰 권장수량: <b className="mono">{suggestedQty.toFixed(4)}</b>{" "}
            <button
              className="secondary"
              style={{ padding: "3px 10px", fontSize: 12 }}
              onClick={() => setForm({ ...form, qty: suggestedQty.toFixed(4) })}
            >
              적용
            </button>
            <br />
            (시드 {eq.toLocaleString()} × {calc.riskPct}% ÷ (ATR {calc.atr?.toFixed(1)} × {calc.stopMult}))
          </p>
        )}
        {eq === 0 && <p className="muted">설정 탭에서 계좌자산 입력 시 권장수량 자동 계산.</p>}
        <button style={{ marginTop: 10, width: "100%" }} onClick={submit}>
          등록
        </button>
        {msg && <p className="muted" style={{ marginTop: 6 }}>{msg}</p>}
      </div>

      <div className="card">
        <h2>보유 중 ({open.length})</h2>
        {open.length === 0 && <p className="muted">열린 포지션 없음</p>}
        {open.map((p) => (
          <div key={p.id} className="list-item">
            <div className="row spread">
              <span>
                <span className={`badge ${p.side === "long" ? "green" : "red"}`}>
                  {p.side === "long" ? "롱" : "숏"}
                </span>{" "}
                <b>{p.symbol}</b> <span className="muted">{p.timeframe.toUpperCase()}</span>
              </span>
              <button className="danger" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => close(p)}>
                청산 처리
              </button>
            </div>
            <div className="muted mono" style={{ marginTop: 4 }}>
              진입 {p.entryPrice.toLocaleString()} · 수량 {p.qty} · 손절{" "}
              <b style={{ color: "var(--red)" }}>{p.stop.toLocaleString()}</b>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>종료된 포지션</h2>
        {closed.slice(0, 20).map((p) => (
          <div key={p.id} className="list-item muted mono" style={{ fontSize: 13 }}>
            {p.symbol} {p.side} · 진입 {p.entryPrice.toLocaleString()} → 청산{" "}
            {p.closePrice?.toLocaleString() ?? "-"} ({p.closeReason})
          </div>
        ))}
        {closed.length === 0 && <p className="muted">기록 없음</p>}
      </div>
    </div>
  );
}
