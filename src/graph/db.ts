import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema';

export const GRAPH_FILENAME = 'graph.sqlite';

export function graphPath(rootDir: string): string {
  return path.join(rootDir, '.ctxkeep', GRAPH_FILENAME);
}

/** Opens (creating if needed) .ctxkeep/graph.sqlite and ensures the MVP schema exists. */
export function openGraph(rootDir: string): Database.Database {
  const dbPath = graphPath(rootDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}
