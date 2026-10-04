import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { DetectedConvention } from '../../src/analysis/conventions';
import { openGraph, openMemoryGraph } from '../../src/graph/db';
import {
  listEmittableConventions,
  listLapsedConventions,
  listPendingConventions,
  setConventionStatus,
  syncConventions,
} from '../../src/graph/conventions';
import { applyReviewAnswer } from '../../src/cli/commands/reviewConventions';
import { tempDir } from '../helpers';

function candidate(overrides: Partial<DetectedConvention> = {}): DetectedConvention {
  return {
    moduleId: 'src/api',
    patternType: 'export-style',
    value: 'named',
    statement: 'Files in `src/api/` use named exports only (no default exports).',
    matched: 5,
    sampleSize: 5,
    evidenceFilePaths: ['src/api/a.ts'],
    ...overrides,
  };
}

describe('convention lifecycle', () => {
  it('starts pending; a confirmation survives re-detection with new counts', () => {
    const db = openMemoryGraph();
    syncConventions(db, [candidate()]);
    const [pending] = listPendingConventions(db, 10);
    expect(pending.status).toBe('pending');

    setConventionStatus(db, pending.id, 'confirmed');
    syncConventions(db, [candidate({ matched: 9, sampleSize: 9 })]);
    expect(listEmittableConventions(db)).toEqual([expect.objectContaining({ id: pending.id, matched: 9, status: 'confirmed' })]);
  });

  it('a confirmed convention that stops holding is no longer emitted, and is reported as lapsed', () => {
    const db = openMemoryGraph();
    syncConventions(db, [candidate()]);
    setConventionStatus(db, listPendingConventions(db, 10)[0].id, 'confirmed');

    syncConventions(db, []); // pattern no longer detected (code drifted, or module deleted)
    expect(listEmittableConventions(db)).toEqual([]);
    expect(listLapsedConventions(db).map((c) => c.id)).toEqual(['src/api:export-style:named']);

    syncConventions(db, [candidate()]); // and comes back if the code returns to it
    expect(listEmittableConventions(db)).toHaveLength(1);
  });

  it('a flipped pattern is a NEW candidate — a confirmation never transfers to a different claim', () => {
    const db = openMemoryGraph();
    syncConventions(db, [candidate()]);
    setConventionStatus(db, listPendingConventions(db, 10)[0].id, 'confirmed');

    syncConventions(db, [candidate({ value: 'default', statement: 'Files in `src/api/` use a single default export.' })]);
    expect(listEmittableConventions(db)).toEqual([]);
    expect(listPendingConventions(db, 10).map((c) => c.id)).toEqual(['src/api:export-style:default']);
  });

  it('a rejected convention never resurfaces in the queue', () => {
    const db = openMemoryGraph();
    syncConventions(db, [candidate()]);
    setConventionStatus(db, listPendingConventions(db, 10)[0].id, 'rejected');
    syncConventions(db, [candidate()]);
    expect(listPendingConventions(db, 10)).toEqual([]);
  });

  it('ranks the queue by agreement, then by sample size', () => {
    const db = openMemoryGraph();
    syncConventions(db, [
      candidate({ moduleId: 'a', matched: 4, sampleSize: 5 }),
      candidate({ moduleId: 'b', matched: 3, sampleSize: 3 }),
      candidate({ moduleId: 'c', matched: 9, sampleSize: 9 }),
    ]);
    expect(listPendingConventions(db, 10).map((c) => c.moduleId)).toEqual(['c', 'b', 'a']);
  });
});

describe('applyReviewAnswer', () => {
  it('maps y/yes → confirmed, n/no → rejected, anything else → skipped (no write)', () => {
    const db = openMemoryGraph();
    syncConventions(db, [candidate(), candidate({ moduleId: 'x' }), candidate({ moduleId: 'y' })]);
    const [a, b, c] = listPendingConventions(db, 10);
    expect(applyReviewAnswer(db, a, ' YES ')).toBe('confirmed');
    expect(applyReviewAnswer(db, b, 'n')).toBe('rejected');
    expect(applyReviewAnswer(db, c, 'maybe')).toBe('skipped');
    expect(listPendingConventions(db, 10).map((r) => r.id)).toEqual([c.id]);
  });
});

describe('v0.1 → v2 graph migration', () => {
  it('rebuilds the cache tables and re-keys human convention decisions to path-based module ids', () => {
    const root = tempDir('ctxkeep-migrate-');
    fs.mkdirSync(path.join(root, '.ctxkeep'));
    const old = new Database(path.join(root, '.ctxkeep', 'graph.sqlite'));
    old.exec(`
      CREATE TABLE modules (id TEXT PRIMARY KEY, path_glob TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE symbols (id TEXT PRIMARY KEY, module_id TEXT, kind TEXT, name TEXT, file_path TEXT, span_start INT, span_end INT, signature_hash TEXT);
      CREATE TABLE conventions (id TEXT PRIMARY KEY, module_id TEXT, statement TEXT, confidence REAL, status TEXT, evidence_file_paths TEXT);
      CREATE TABLE checkpoints (id TEXT PRIMARY KEY, module_id TEXT, sha TEXT, verified_at TEXT);
      CREATE TABLE artifact_bindings (id TEXT PRIMARY KEY, artifact_path TEXT, region_id TEXT, content_hash TEXT, last_emitted_at TEXT);
      INSERT INTO modules VALUES ('api', 'src/api/**', 'api'), ('(root)', 'src/*', '(root)');
      INSERT INTO conventions VALUES
        ('api:export-style', 'api', '9/9 files with exports in \`api/\` use named exports.', 1, 'confirmed', '[]'),
        ('api:file-naming', 'api', '5/6 files in \`api/\` use kebab-case naming.', 0.8, 'rejected', '[]'),
        ('api:error-handling', 'api', '3/4 top-level functions in \`api/\` use try/catch error handling.', 0.75, 'confirmed', '[]'),
        ('(root):export-style', '(root)', '2/2 files use default exports.', 1, 'pending', '[]');
    `);
    old.close();

    const db = openGraph(root);
    const rows = db.prepare('SELECT id, status, active FROM conventions ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'src/api:export-style:named', status: 'confirmed', active: 0 },
      { id: 'src/api:file-naming:kebab-case', status: 'rejected', active: 0 },
    ]);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(['conventions', 'files', 'imports', 'meta', 'symbols']);
    db.close();
  });

  it('refuses a graph from a newer CtxKeep with an actionable message', () => {
    const root = tempDir('ctxkeep-newer-');
    fs.mkdirSync(path.join(root, '.ctxkeep'));
    const future = new Database(path.join(root, '.ctxkeep', 'graph.sqlite'));
    future.pragma('user_version = 99');
    future.close();
    expect(() => openGraph(root)).toThrow(/newer CtxKeep \(schema v99\)/);
  });

  it('turns a corrupt graph file into an actionable error', () => {
    const root = tempDir('ctxkeep-corrupt-');
    fs.mkdirSync(path.join(root, '.ctxkeep'));
    fs.writeFileSync(path.join(root, '.ctxkeep', 'graph.sqlite'), 'this is not sqlite');
    expect(() => openGraph(root)).toThrow(/regenerable cache — delete it/);
  });
});
