"use client";

import { useEffect, useState } from "react";

interface Sig {
  id: number;
  symbol: string;
  timeframe: string;
  event: string;
  candleTime: number;
  createdAt: number;
  delivered: number;
  payload: {
    price?: number;
    stop?: number;
    newStop?: number;
    prevStop?: number;
    dir?: string;
    filters?: { name: string; passed: boolean; detail: string }[];
  };
}

const EVENT_LABEL: Record<string, { text: string; cls: string }> = {
  ENTRY_LONG: { text: "롱 진입", cls: "green" },
  ENTRY_SHORT: { text: "숏 진입", cls: "red" },
  ENTRY_BLOCKED: { text: "진입 보류", cls: "amber" },
  EXIT_LONG: { text: "롱 청산", cls: "muted" },
  EXIT_SHORT: { text: "숏 청산", cls: "muted" },
  TRAIL_UPDATE: { text: "스톱 갱신", cls: "blue" },
};

function label(event: string) {
  if (event.startsWith("STOP_HIT")) return { text: "손절 도달", cls: "red" };
  if (event.startsWith("PARTIAL_TP")) return { text: "부분 익절", cls: "amber" };
  return EVENT_LABEL[event] ?? { text: event, cls: "muted" };
}

export default function SignalsPage() {
  const [signals, setSignals] = useState<Sig[]>([]);
  const [health, setHealth] = useState<{ status: string } | null>(null);

  useEffect(() => {
    fetch("/api/signals?limit=200")
      .then((r) => r.json())
      .then((d) => setSignals(d.signals ?? []));
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => setHealth(d.health));
  }, []);

  return (
    <div>
      <h1>
        신호 히스토리{" "}
        {health && (
          <span className={`badge ${health.status === "ok" ? "green" : "red"}`}>
            엔진 {health.status === "ok" ? "정상" : "이상"}
          </span>
        )}
      </h1>
      <div className="card">
        {signals.length === 0 && <p className="muted">아직 신호 없음. 엔진이 봉 마감마다 감시 중.</p>}
        {signals.map((s) => {
          const l = label(s.event);
          return (
            <div key={s.id} className="list-item">
              <div className="row spread">
                <span>
                  <span className={`badge ${l.cls}`}>{l.text}</span>{" "}
                  <b>{s.symbol}</b> <span className="muted">{s.timeframe.toUpperCase()}</span>
                </span>
                <span className="muted">{new Date(s.createdAt).toLocaleString("ko-KR")}</span>
              </div>
              <div className="muted mono" style={{ marginTop: 4 }}>
                {s.payload.price !== undefined && <>가격 {s.payload.price.toLocaleString()} </>}
                {s.payload.stop !== undefined && <>| 손절 {s.payload.stop.toLocaleString()} </>}
                {s.payload.newStop !== undefined && (
                  <>
                    {s.payload.prevStop?.toLocaleString()} → {s.payload.newStop.toLocaleString()}
                  </>
                )}
                {s.delivered === -1 && <span className="badge red">발송실패</span>}
              </div>
              {s.payload.filters && (
                <div className="muted" style={{ marginTop: 2, fontSize: 11 }}>
                  {s.payload.filters.map((f) => `${f.passed ? "✅" : "❌"} ${f.detail}`).join(" · ")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
