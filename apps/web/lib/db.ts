import path from "node:path";
import { openDb, Repo, type DB } from "@turtle/db";

declare global {
  // eslint-disable-next-line no-var
  var __turtleDb: DB | undefined;
}

export function getRepo(): Repo {
  if (!globalThis.__turtleDb) {
    const p = process.env.DB_PATH ?? path.join(process.cwd(), "..", "..", "data", "turtle.db");
    globalThis.__turtleDb = openDb(p);
  }
  return new Repo(globalThis.__turtleDb);
}
