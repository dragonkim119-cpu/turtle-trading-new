"use client";

import { useCallback, useEffect, useState } from "react";

const NOTIF_LABELS: [string, string][] = [
  ["notif:entry", "진입 신호"],
  ["notif:exit", "청산 신호"],
  ["notif:stop", "손절 도달"],
  ["notif:trail", "스톱 갱신"],
  ["notif:blocked", "필터 차단 알림"],
  ["notif:partial", "부분 익절 (1R 도달)"],
  ["notif:news", "키워드 속보"],
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string | null>>({});
  const [symbols, setSymbols] = useState<string[]>([]);
  const [newSymbol, setNewSymbol] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => setSettings(d.settings ?? {}));
    fetch("/api/watchlist")
      .then((r) => r.json())
      .then((d) => setSymbols(d.symbols ?? []));
  }, []);
  useEffect(load, [load]);

  const put = async (patch: Record<string, string>) => {
    setSettings((s) => ({ ...s, ...patch }));
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSaved("저장됨");
    setTimeout(() => setSaved(""), 1500);
  };

  const addSymbol = async () => {
    if (!newSymbol) return;
    const res = await fetch("/api/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: newSymbol }),
    });
    const d = await res.json();
    if (res.ok) setSymbols(d.symbols);
    setNewSymbol("");
  };

  const removeSymbol = async (symbol: string) => {
    const res = await fetch("/api/watchlist", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol }),
    });
    const d = await res.json();
    if (res.ok) setSymbols(d.symbols);
  };

  return (
    <div>
      <h1>설정 {saved && <span className="badge green">{saved}</span>}</h1>

      <div className="card">
        <h2>계좌</h2>
        <label>계좌자산 (USDT 또는 KRW — 수량 계산 기준)</label>
        <input
          type="number"
          value={settings["equity"] ?? ""}
          onChange={(e) => setSettings((s) => ({ ...s, equity: e.target.value }))}
          onBlur={(e) => put({ equity: e.target.value })}
          placeholder="예: 10000000"
        />
        <p className="muted" style={{ marginTop: 6 }}>
          2% 룰 권장수량 = 자산 × 리스크% ÷ (ATR × 손절배수). 리스크%는 차트 탭 파라미터에서 심볼별 설정.
        </p>
      </div>

      <div className="card">
        <h2>워치리스트 (바이낸스 선물 심볼)</h2>
        {symbols.map((s) => (
          <div key={s} className="list-item row spread">
            <b>{s}</b>
            <button className="danger" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => removeSymbol(s)}>
              제거
            </button>
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <input
            placeholder="예: SOLUSDT"
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
            style={{ flex: 1 }}
          />
          <button onClick={addSymbol}>추가</button>
        </div>
      </div>

      <div className="card">
        <h2>텔레그램 알림</h2>
        {NOTIF_LABELS.map(([key, label]) => {
          const on = settings[key] !== "off";
          return (
            <div key={key} className="list-item row spread">
              <span>{label}</span>
              <button
                className={on ? "" : "secondary"}
                style={{ padding: "5px 14px" }}
                onClick={() => put({ [key]: on ? "off" : "on" })}
              >
                {on ? "ON" : "OFF"}
              </button>
            </div>
          );
        })}
        <p className="muted" style={{ marginTop: 6 }}>
          봇 토큰/채팅 ID는 서버 환경변수 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID로 설정.
        </p>
      </div>

      <div className="card">
        <h2>속보 키워드 (쉼표 구분)</h2>
        <input
          value={settings["newsKeywords"] ?? ""}
          onChange={(e) => setSettings((s) => ({ ...s, newsKeywords: e.target.value }))}
          onBlur={(e) => put({ newsKeywords: e.target.value })}
          placeholder="트럼프,관세,연준,금리,전쟁,지정학"
        />
      </div>
    </div>
  );
}
