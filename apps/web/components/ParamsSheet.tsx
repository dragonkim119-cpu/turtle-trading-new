"use client";

import { useEffect, useState } from "react";
import type { Params } from "@turtle/core";

export default function ParamsSheet({
  symbol,
  tf,
  onClose,
}: {
  symbol: string;
  tf: string;
  onClose: () => void;
}) {
  const [p, setP] = useState<Params | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/params?symbol=${symbol}&tf=${tf}`)
      .then((r) => r.json())
      .then((d) => setP(d.params));
  }, [symbol, tf]);

  if (!p) return null;

  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const save = async () => {
    setSaving(true);
    await fetch("/api/params", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, tf, params: p }),
    });
    setSaving(false);
    onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 100,
        display: "flex",
        alignItems: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: "100%", maxHeight: "85vh", overflowY: "auto", margin: 0, borderRadius: "16px 16px 0 0" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>
          {symbol} · {tf.toUpperCase()} 파라미터
        </h2>

        <div className="row">
          <div style={{ flex: 1 }}>
            <label>진입 채널 (봉)</label>
            <input type="number" value={p.entryPeriod} onChange={(e) => setP({ ...p, entryPeriod: num(e.target.value) })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>청산 채널 (봉)</label>
            <input type="number" value={p.exitPeriod} onChange={(e) => setP({ ...p, exitPeriod: num(e.target.value) })} />
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>ATR 기간</label>
            <input type="number" value={p.atrPeriod} onChange={(e) => setP({ ...p, atrPeriod: num(e.target.value) })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>손절 배수 (×ATR)</label>
            <input type="number" step="0.1" value={p.stopMult} onChange={(e) => setP({ ...p, stopMult: num(e.target.value) })} />
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>추세 EMA 기간</label>
            <input type="number" value={p.emaPeriod} onChange={(e) => setP({ ...p, emaPeriod: num(e.target.value) })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>리스크 % (거래당)</label>
            <input type="number" step="0.1" value={p.riskPct} onChange={(e) => setP({ ...p, riskPct: num(e.target.value) })} />
          </div>
        </div>

        <h2 style={{ marginTop: 16 }}>보완 필터</h2>

        <FilterRow
          label="ADX 추세강도"
          on={p.filters.adx.on}
          setOn={(on) => setP({ ...p, filters: { ...p.filters, adx: { ...p.filters.adx, on } } })}
        >
          <label>최소 ADX</label>
          <input
            type="number"
            value={p.filters.adx.min}
            onChange={(e) => setP({ ...p, filters: { ...p.filters, adx: { ...p.filters.adx, min: num(e.target.value) } } })}
          />
        </FilterRow>

        <FilterRow
          label="거래량 확인"
          on={p.filters.volume.on}
          setOn={(on) => setP({ ...p, filters: { ...p.filters, volume: { ...p.filters.volume, on } } })}
        >
          <label>배수 (×평균)</label>
          <input
            type="number"
            step="0.1"
            value={p.filters.volume.mult}
            onChange={(e) =>
              setP({ ...p, filters: { ...p.filters, volume: { ...p.filters.volume, mult: num(e.target.value) } } })
            }
          />
        </FilterRow>

        <FilterRow
          label="Rolling VWAP"
          on={p.filters.vwap.on}
          setOn={(on) => setP({ ...p, filters: { ...p.filters, vwap: { ...p.filters.vwap, on } } })}
        >
          <label>기간 (일)</label>
          <input
            type="number"
            value={p.filters.vwap.bars}
            onChange={(e) => setP({ ...p, filters: { ...p.filters, vwap: { ...p.filters.vwap, bars: num(e.target.value) } } })}
          />
        </FilterRow>

        <FilterRow
          label="펀딩비 과열"
          on={p.filters.funding.on}
          setOn={(on) => setP({ ...p, filters: { ...p.filters, funding: { ...p.filters.funding, on } } })}
        >
          <label>한도 (%, ±)</label>
          <input
            type="number"
            step="0.01"
            value={p.filters.funding.maxAbs * 100}
            onChange={(e) =>
              setP({
                ...p,
                filters: { ...p.filters, funding: { ...p.filters.funding, maxAbs: num(e.target.value) / 100 } },
              })
            }
          />
        </FilterRow>

        <h2 style={{ marginTop: 16 }}>부분 익절 (승률 개선)</h2>
        <div className="list-item">
          <div className="row spread">
            <b style={{ fontSize: 14 }}>부분 익절</b>
            <button
              className={p.partialTp ? "" : "secondary"}
              onClick={() =>
                setP({
                  ...p,
                  partialTp: p.partialTp ? null : { atR: 1, fraction: 0.5, moveStopToBreakeven: false },
                })
              }
              style={{ padding: "5px 12px" }}
            >
              {p.partialTp ? "ON" : "OFF"}
            </button>
          </div>
          {p.partialTp && (
            <>
              <div className="row">
                <div style={{ flex: 1 }}>
                  <label>익절 시점 (R 배수)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={p.partialTp.atR}
                    onChange={(e) =>
                      setP({ ...p, partialTp: { ...p.partialTp!, atR: num(e.target.value) } })
                    }
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label>익절 비율 (%)</label>
                  <input
                    type="number"
                    value={p.partialTp.fraction * 100}
                    onChange={(e) =>
                      setP({ ...p, partialTp: { ...p.partialTp!, fraction: num(e.target.value) / 100 } })
                    }
                  />
                </div>
              </div>
              <div className="row spread" style={{ marginTop: 8 }}>
                <span className="muted">익절 후 남은 물량 스톱 → 본전 이동</span>
                <button
                  className={p.partialTp.moveStopToBreakeven ? "" : "secondary"}
                  onClick={() =>
                    setP({
                      ...p,
                      partialTp: { ...p.partialTp!, moveStopToBreakeven: !p.partialTp!.moveStopToBreakeven },
                    })
                  }
                  style={{ padding: "5px 12px" }}
                >
                  {p.partialTp.moveStopToBreakeven ? "ON" : "OFF"}
                </button>
              </div>
              <p className="muted" style={{ marginTop: 4, fontSize: 11 }}>
                본전 이동: 승률↑·MDD↓ 경향이나 PF 소폭↓ (회복 거래 조기 청산). 백테스트로 확인 후 사용.
              </p>
            </>
          )}
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="secondary" style={{ flex: 1 }} onClick={onClose}>
            취소
          </button>
          <button style={{ flex: 2 }} onClick={save} disabled={saving}>
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterRow({
  label,
  on,
  setOn,
  children,
}: {
  label: string;
  on: boolean;
  setOn: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="list-item">
      <div className="row spread">
        <b style={{ fontSize: 14 }}>{label}</b>
        <button className={on ? "" : "secondary"} onClick={() => setOn(!on)} style={{ padding: "5px 12px" }}>
          {on ? "ON" : "OFF"}
        </button>
      </div>
      {on && <div className="row">{children}</div>}
    </div>
  );
}
