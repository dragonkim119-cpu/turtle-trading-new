"use client";

import { useCallback, useEffect, useState } from "react";

const NOTIF_LABELS: [string, string][] = [
  ["notif:entry", "진입 신호"],
  ["notif:exit", "청산 신호"],
  ["notif:stop", "손절 도달"],
  ["notif:trail", "스톱 갱신"],
  ["notif:blocked", "필터 차단 알림"],
  ["notif:partial", "부분 익절 (1R 도달)"],
  ["notif:volspike", "1분 급변 경보"],
  ["notif:stopnear", "손절선 임박 선경고"],
  ["notif:timestop", "타임스톱 (N봉 내 +1R 미도달)"],
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

      <PortfolioGateCard settings={settings} setSettings={setSettings} put={put} />

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

const GATE_DEFAULTS = { maxOpenRiskPct: 6, maxSameDir: 3, dailyLossPct: 4, monthlyLossPct: 10 };
const GATE_FIELDS: [keyof typeof GATE_DEFAULTS, string][] = [
  ["maxOpenRiskPct", "동시 오픈 리스크 캡 (%)"],
  ["maxSameDir", "방향 편중 경고 (개)"],
  ["dailyLossPct", "일 손실 스로틀 (%)"],
  ["monthlyLossPct", "월 손실 스로틀 (%)"],
];

function PortfolioGateCard({
  settings,
  setSettings,
  put,
}: {
  settings: Record<string, string | null>;
  setSettings: React.Dispatch<React.SetStateAction<Record<string, string | null>>>;
  put: (patch: Record<string, string>) => void;
}) {
  const parsed = (() => {
    try {
      return { ...GATE_DEFAULTS, ...(settings["portfolioGate"] ? JSON.parse(settings["portfolioGate"]!) : {}) };
    } catch {
      return { ...GATE_DEFAULTS };
    }
  })();

  const update = (key: keyof typeof GATE_DEFAULTS, value: number) => {
    const next = { ...parsed, [key]: value };
    setSettings((s) => ({ ...s, portfolioGate: JSON.stringify(next) }));
    put({ portfolioGate: JSON.stringify(next) });
  };

  return (
    <div className="card">
      <h2>포트폴리오 리스크 규칙</h2>
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>거래당 리스크 % (전역 기준)</label>
          <input
            type="number"
            step="0.1"
            value={settings["riskPct"] ?? "2"}
            onChange={(e) => setSettings((s) => ({ ...s, riskPct: e.target.value }))}
            onBlur={(e) => put({ riskPct: e.target.value })}
          />
        </div>
      </div>
      {GATE_FIELDS.map(([key, label]) => (
        <div key={key} className="row" style={{ marginTop: 4 }}>
          <div style={{ flex: 1 }}>
            <label>{label}</label>
            <input
              type="number"
              step="0.1"
              value={parsed[key]}
              onChange={(e) => update(key, Number(e.target.value))}
            />
          </div>
        </div>
      ))}
      <p className="muted" style={{ marginTop: 6 }}>
        초과 시 신규 진입 신호를 &quot;비권장&quot;으로 강등(차단 아님). 신호 탭에 실시간 상태 표시.
      </p>
    </div>
  );
}
