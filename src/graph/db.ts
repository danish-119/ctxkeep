import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

export const GRAPH_FILENAME = 'graph.sqlite';

export class GraphError extends Error {}

export function graphPath(rootDir: string): string {
  return path.join(rootDir, '.ctxkeep', GRAPH_FILENAME);
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** Old v0.1 convention statements carried the detected value only in prose; recover it so decisions survive. */
function legacyConventionValue(pattern: string, statement: string): string | null {
  if (pattern === 'export-style') {
    if (statement.includes('a mix of default and named')) return 'mixed';
    if (statement.includes('named exports')) return 'named';
    if (statement.includes('default exports')) return 'default';
  }
  if (pattern === 'file-naming') return statement.match(/use (\S+) naming/)?.[1] ?? null;
  return null; // v0.1's error-handling pattern no longer exists
}

/**
 * v0.1 → v2. Everything except human convention decisions is a cache and is
 * simply rebuilt by the next scan. Module ids changed from bare folder names
 * (`api`) to paths (`src/api`); the old `modules.path_glob` column records
 * which path each old name meant, so confirmed/rejected rows are re-keyed
 * rather than lost.
 */
function migrateFromV1(db: Database.Database): void {
  const globs = new Map<string, string>();
  for (const row of db.prepare('SELECT id, path_glob FROM modules').all() as { id: string; path_glob: string }[]) {
    globs.set(row.id, row.path_glob);
  }
  const decided = hasTable(db, 'conventions')
    ? (db
        .prepare("SELECT id, module_id, statement, status FROM conventions WHERE status != 'pending'")
        .all() as { id: string; module_id: string; statement: string; status: string }[])
    : [];

  db.exec(`
    DROP TABLE IF EXISTS artifact_bindings;
    DROP TABLE IF EXISTS checkpoints;
    DROP TABLE IF EXISTS conventions;
    DROP TABLE IF EXISTS symbols;
    DROP TABLE IF EXISTS modules;
  `);
  db.exec(SCHEMA_SQL);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO conventions (id, module_id, pattern_type, value, statement, matched, sample_size, status, active, evidence_file_paths)
    VALUES (@id, @moduleId, @pattern, @value, @statement, 0, 0, @status, 0, '[]')
  `);
  for (const row of decided) {
    const pattern = row.id.slice(row.id.lastIndexOf(':') + 1);
    const value = legacyConventionValue(pattern, row.statement);
    if (!value) continue;
    const glob = globs.get(row.module_id) ?? `${row.module_id}/**`;
    const stripped = glob.replace(/\/\*\*?$/, '');
    const moduleId = stripped === '*' || stripped === '' ? '.' : stripped;
    insert.run({ id: `${moduleId}:${pattern}:${value}`, moduleId, pattern, value, statement: row.statement, status: row.status });
  }
}

function prepare(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new GraphError(
      `.ctxkeep/${GRAPH_FILENAME} was written by a newer CtxKeep (schema v${version}). ` +
        'Upgrade CtxKeep, or delete the file to rebuild it (only convention review decisions are lost).',
    );
  }
  if (version < SCHEMA_VERSION) {
    db.transaction(() => {
      if (hasTable(db, 'modules')) migrateFromV1(db);
      else db.exec(SCHEMA_SQL);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }
}

/** Opens (creating or migrating if needed) .ctxkeep/graph.sqlite. */
export function openGraph(rootDir: string): Database.Database {
  const dbPath = graphPath(rootDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    prepare(db);
    return db;
  } catch (err) {
    db?.close();
    if (err instanceof GraphError) throw err;
    throw new GraphError(
      `could not open .ctxkeep/${GRAPH_FILENAME}: ${(err as Error).message}. ` +
        'The graph is a regenerable cache — delete it and rerun `ctxkeep analyze` (only convention review decisions are lost).',
    );
  }
}

/** A throwaway graph: used by `try` (no files written at all). */
export function openMemoryGraph(): Database.Database {
  const db = new Database(':memory:');
  prepare(db);
  return db;
}
