import { openDb, Repo } from "@turtle/db";
import type { Timeframe } from "@turtle/core";
import { createBinanceClient } from "./binance.js";
import { createTelegram } from "./telegram.js";
import { Health } from "./health.js";
import { checkStops, processSymbol, type RunnerDeps } from "./runner.js";
import { every, scheduleAtCloses } from "./scheduler.js";
import { pollRss } from "./rss.js";

const TIMEFRAMES: Timeframe[] = ["4h", "1d"];
const STOP_INTERVAL_MS = 60_000;
const RSS_INTERVAL_MS = 10 * 60_000;

function main() {
  const dbPath = process.env.DB_PATH ?? "data/turtle.db";
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  if (!token || !chatId) {
    console.warn("⚠ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 미설정 — 알림 발송 불가 (신호는 DB에 기록됨)");
  }

  const db = openDb(dbPath);
  const repo = new Repo(db);
  // Seed default watchlist on first run.
  if (repo.getWatchlist().length === 0) {
    repo.addSymbol("BTCUSDT");
    repo.addSymbol("ETHUSDT");
  }

  const telegram = token && chatId
    ? createTelegram(token, chatId)
    : { send: async () => (console.log("[telegram skipped]"), false) };
  const binance = createBinanceClient();
  const health = new Health(repo, telegram);
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
  const deps: RunnerDeps = { repo, binance, telegram, health, log };

  const runAll = async (tf: Timeframe) => {
    for (const symbol of repo.getWatchlist()) {
      await processSymbol(deps, symbol, tf);
    }
  };

  // Catch-up on boot, then schedule.
  (async () => {
    for (const tf of TIMEFRAMES) await runAll(tf).catch((e) => log(`boot ${tf}: ${e.message}`));
    log("boot catch-up complete");
  })();

  for (const tf of TIMEFRAMES) {
    scheduleAtCloses(tf, () => runAll(tf), (e) => log(`schedule ${tf}: ${e.message}`));
  }
  every(STOP_INTERVAL_MS, () => checkStops(deps), (e) => log(`stops: ${e.message}`));
  every(RSS_INTERVAL_MS, () => pollRss({ repo, telegram, log }), (e) => log(`rss: ${e.message}`));
  pollRss({ repo, telegram, log }).catch((e) => log(`rss boot: ${e.message}`));

  log(`engine started — db=${dbPath}, watchlist=${repo.getWatchlist().join(",")}`);
}

main();
