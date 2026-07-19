import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

const DDL = `
CREATE TABLE IF NOT EXISTS symbols (
  symbol TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS params (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  event TEXT NOT NULL,
  candleTime INTEGER NOT NULL,
  payload TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  featureSnapshot TEXT,
  UNIQUE (symbol, timeframe, event, candleTime)
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL,
  entryPrice REAL NOT NULL,
  qty REAL NOT NULL,
  stop REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  stopHistory TEXT NOT NULL DEFAULT '[]',
  openedAt INTEGER NOT NULL,
  closedAt INTEGER,
  closePrice REAL,
  closeReason TEXT,
  partialTpTarget REAL,
  partialDone INTEGER NOT NULL DEFAULT 0,
  initialRisk REAL,
  realizedR REAL
);
CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  link TEXT NOT NULL UNIQUE,
  pubDate INTEGER,
  matched INTEGER NOT NULL DEFAULT 0,
  keywords TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS engine_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS macro_snapshots (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_signals_recent ON signals (createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_news_recent ON news_items (createdAt DESC);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(DDL);
  migrate(db);
  return db;
}

/** Additive migrations for DBs created before a column existed. */
function migrate(db: DB): void {
  const posCols = new Set(
    (db.prepare("PRAGMA table_info(positions)").all() as { name: string }[]).map((r) => r.name),
  );
  if (!posCols.has("partialTpTarget")) {
    db.exec("ALTER TABLE positions ADD COLUMN partialTpTarget REAL");
  }
  if (!posCols.has("partialDone")) {
    db.exec("ALTER TABLE positions ADD COLUMN partialDone INTEGER NOT NULL DEFAULT 0");
  }
  if (!posCols.has("initialRisk")) {
    db.exec("ALTER TABLE positions ADD COLUMN initialRisk REAL");
  }
  if (!posCols.has("realizedR")) {
    db.exec("ALTER TABLE positions ADD COLUMN realizedR REAL");
  }

  const sigCols = new Set(
    (db.prepare("PRAGMA table_info(signals)").all() as { name: string }[]).map((r) => r.name),
  );
  if (!sigCols.has("featureSnapshot")) {
    db.exec("ALTER TABLE signals ADD COLUMN featureSnapshot TEXT");
  }
}
