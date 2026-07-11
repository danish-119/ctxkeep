import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/graph/schema';
import { getCheckpoint, recordCheckpoint } from '../../src/graph/checkpoints';

/**
 * `checkpoints` is append-only (build spec §3 — no UNIQUE constraint on
 * module_id), unlike `artifact_bindings`. getCheckpoint MUST return the most
 * recent row for a module, not an arbitrary or first-inserted one — a wrong
 * pick here silently diffs against the wrong baseline SHA in syncPlan.ts.
 */

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // checkpoints.module_id REFERENCES modules(id), and this better-sqlite3
  // build defaults foreign_keys=ON — seed both modules referenced below.
  const insertModule = db.prepare('INSERT INTO modules (id, path_glob, name) VALUES (?, ?, ?)');
  insertModule.run('moduleA', 'src/moduleA/**', 'moduleA');
  insertModule.run('moduleB', 'src/moduleB/**', 'moduleB');
});

afterEach(() => {
  db.close();
});

describe('getCheckpoint — selects the most recent row per module', () => {
  it('returns the only row when a module has exactly one checkpoint', () => {
    recordCheckpoint(db, 'moduleA', 'sha-1', '2026-01-01T00:00:00.000Z');
    expect(getCheckpoint(db, 'moduleA')?.sha).toBe('sha-1');
  });

  it('returns the LATEST row (by verified_at) when a module has been checkpointed multiple times, regardless of insertion order', () => {
    recordCheckpoint(db, 'moduleA', 'sha-1', '2026-01-01T00:00:00.000Z');
    recordCheckpoint(db, 'moduleA', 'sha-2', '2026-01-02T00:00:00.000Z');
    recordCheckpoint(db, 'moduleA', 'sha-3', '2026-01-03T00:00:00.000Z');

    expect(getCheckpoint(db, 'moduleA')?.sha).toBe('sha-3');
  });

  it('is not fooled by insertion order when timestamps are inserted out of chronological order', () => {
    // Deliberately insert an OLDER-timestamped row AFTER a newer one, to prove
    // this is genuinely ORDER BY verified_at, not "last row inserted" / rowid.
    recordCheckpoint(db, 'moduleA', 'sha-newest', '2026-03-01T00:00:00.000Z');
    recordCheckpoint(db, 'moduleA', 'sha-oldest', '2026-01-01T00:00:00.000Z');

    expect(getCheckpoint(db, 'moduleA')?.sha).toBe('sha-newest');
  });

  it('keeps modules independent — one module\'s history never leaks into another\'s lookup', () => {
    recordCheckpoint(db, 'moduleA', 'a-sha-1', '2026-01-01T00:00:00.000Z');
    recordCheckpoint(db, 'moduleA', 'a-sha-2', '2026-01-02T00:00:00.000Z');
    recordCheckpoint(db, 'moduleB', 'b-sha-1', '2026-01-05T00:00:00.000Z');

    expect(getCheckpoint(db, 'moduleA')?.sha).toBe('a-sha-2');
    expect(getCheckpoint(db, 'moduleB')?.sha).toBe('b-sha-1');
  });

  it('returns undefined for a module with no checkpoint at all', () => {
    recordCheckpoint(db, 'moduleA', 'sha-1', '2026-01-01T00:00:00.000Z');
    expect(getCheckpoint(db, 'moduleB')).toBeUndefined();
  });
});
