import type { FilterCheck, SignalEvent, Timeframe } from "@turtle/core";

export interface TelegramSender {
  send(text: string): Promise<boolean>;
}

export function createTelegram(token: string, chatId: string): TelegramSender {
  return {
    async send(text: string): Promise<boolean> {
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) return true;
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
      return false;
    },
  };
}

export const nf = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 2 });

function fmtFilters(filters: FilterCheck[]): string {
  const label: Record<FilterCheck["name"], string> = {
    adx: "ADX",
    volume: "거래량",
    vwap: "VWAP",
    funding: "펀딩",
  };
  return filters
    .map((f) => `${label[f.name]} ${f.passed ? "✅" : "❌"}${f.detail === "off" ? "(off)" : ""}`)
    .join(" | ");
}

export interface EntryContext {
  symbol: string;
  timeframe: Timeframe;
  equity: number | null;
  riskPct: number;
  stopMult: number;
}

export function fmtEvent(ev: SignalEvent, ctx: EntryContext): string {
  const head = `${ctx.symbol} · ${ctx.timeframe.toUpperCase()}`;
  switch (ev.type) {
    case "ENTRY_LONG":
    case "ENTRY_SHORT": {
      const dir = ev.type === "ENTRY_LONG" ? "🟢 롱 진입 신호" : "🔴 숏 진입 신호";
      let sizeLine = "권장수량: 설정에서 계좌자산 입력 필요";
      if (ctx.equity && ctx.equity > 0) {
        const qty = (ctx.equity * (ctx.riskPct / 100)) / (ev.atr * ctx.stopMult);
        sizeLine = `권장수량: ${nf(qty)} (시드 ${nf(ctx.equity)} · 리스크 ${ctx.riskPct}%)`;
      }
      return [
        `${dir} — ${head}`,
        `진입가: ${nf(ev.price)}`,
        `손절가: ${nf(ev.stop)} (${ev.type === "ENTRY_LONG" ? "−" : "+"}${ctx.stopMult}×ATR, ATR=${nf(ev.atr)})`,
        sizeLine,
        `필터: ${fmtFilters(ev.filters)}`,
      ].join("\n");
    }
    case "ENTRY_BLOCKED": {
      const failed = ev.filters.filter((f) => !f.passed);
      return [
        `⚠️ 돌파 발생 — 진입 보류 — ${head}`,
        `방향: ${ev.dir === "long" ? "롱" : "숏"} / 종가 ${nf(ev.price)}`,
        `차단 사유: ${failed.map((f) => f.detail).join(", ")}`,
        `필터: ${fmtFilters(ev.filters)}`,
      ].join("\n");
    }
    case "EXIT_LONG":
      return `🔻 롱 청산 신호 — ${head}\n10봉 저점선 이탈 종가 마감: ${nf(ev.price)}`;
    case "EXIT_SHORT":
      return `🔺 숏 청산 신호 — ${head}\n10봉 고점선 돌파 종가 마감: ${nf(ev.price)}`;
    case "TRAIL_UPDATE":
      return `🔁 스톱 갱신 — ${head}\n${nf(ev.prevStop)} → ${nf(ev.newStop)}`;
  }
}

export function fmtStopHit(
  symbol: string,
  timeframe: Timeframe,
  side: "long" | "short",
  markPrice: number,
  stop: number,
): string {
  return [
    `⛔ 손절선 도달 — ${symbol} · ${timeframe.toUpperCase()}`,
    `${side === "long" ? "롱" : "숏"} 포지션 즉시 청산 권고`,
    `마크가격 ${nf(markPrice)} ${side === "long" ? "≤" : "≥"} 손절 ${nf(stop)}`,
  ].join("\n");
}

export function fmtPartialTp(
  symbol: string,
  timeframe: Timeframe,
  side: "long" | "short",
  target: number,
  mark: number,
  fraction: number,
  movedBreakeven = false,
): string {
  const lines = [
    `🟡 부분 익절 도달 — ${symbol} · ${timeframe.toUpperCase()}`,
    `${side === "long" ? "롱" : "숏"} 1R 목표 도달 — 물량 ${Math.round(fraction * 100)}% 익절 권고`,
    `목표 ${nf(target)} / 마크가격 ${nf(mark)}`,
  ];
  lines.push(
    movedBreakeven
      ? `🛡 남은 물량 스톱 → 본전(진입가)으로 이동 완료 (무손실 구간)`
      : `남은 물량은 트레일링 스톱으로 계속 관리`,
  );
  return lines.join("\n");
}

export function fmtEngineAlert(msg: string): string {
  return `🚨 엔진 경보\n${msg}`;
}

/** Prefix/suffix lines for a portfolio-gated entry signal (demotion + warnings). */
export function fmtGate(reasons: string[], warnings: string[]): { prefix: string; suffix: string } {
  const prefix = reasons.length
    ? `⚠️ 진입 비권장 — ${reasons.join(" · ")}\n`
    : "";
  const suffix = warnings.length ? `\n⚠️ ${warnings.join(" · ")}` : "";
  return { prefix, suffix };
}

export function fmtNews(source: string, title: string, link: string, keywords: string[]): string {
  return [`📰 속보 [${keywords.join(",")}] — ${source}`, title, link].join("\n");
}
