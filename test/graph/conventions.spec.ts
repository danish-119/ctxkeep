import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/graph/schema';
import { listConfirmedConventions, listPendingConventions, setConventionStatus, upsertConventions } from '../../src/graph/conventions';
import type { DetectedConvention } from '../../src/analysis/conventions';

let db: Database.Database;

function candidate(overrides: Partial<DetectedConvention> = {}): DetectedConvention {
  return {
    patternType: 'file-naming',
    moduleId: 'mod',
    statement: '3/3 files use kebab-case naming.',
    confidence: 1,
    evidenceFilePaths: ['src/mod/a.ts'],
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT INTO modules (id, path_glob, name) VALUES (?, ?, ?)').run('mod', 'src/mod/**', 'mod');
});

afterEach(() => {
  db.close();
});

describe('upsertConventions + listPendingConventions', () => {
  it('a freshly detected convention starts as pending', () => {
    upsertConventions(db, [candidate()]);
    const pending = listPendingConventions(db, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
  });

  it('orders pending conventions by confidence descending and respects the limit', () => {
    upsertConventions(db, [
      candidate({ patternType: 'file-naming', confidence: 0.5 }),
      candidate({ patternType: 'export-style', confidence: 0.9 }),
      candidate({ patternType: 'error-handling', confidence: 0.7 }),
    ]);
    const pending = listPendingConventions(db, 2);
    expect(pending).toHaveLength(2);
    expect(pending.map((c) => c.confidence)).toEqual([0.9, 0.7]);
  });

  it('re-running upsertConventions with the same candidates does not duplicate rows', () => {
    const c = candidate();
    upsertConventions(db, [c]);
    upsertConventions(db, [c]);
    const countRow = db.prepare('SELECT COUNT(*) as n FROM conventions').get() as { n: number };
    expect(countRow.n).toBe(1);
  });
});

describe('confirm/reject/skip semantics', () => {
  it('confirming moves a convention out of pending and into listConfirmedConventions', () => {
    upsertConventions(db, [candidate()]);
    const [pending] = listPendingConventions(db, 10);
    setConventionStatus(db, pending.id, 'confirmed');

    expect(listPendingConventions(db, 10)).toHaveLength(0);
    const confirmed = listConfirmedConventions(db);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].id).toBe(pending.id);
  });

  it('rejecting moves a convention out of pending and it does NOT appear in listConfirmedConventions', () => {
    upsertConventions(db, [candidate()]);
    const [pending] = listPendingConventions(db, 10);
    setConventionStatus(db, pending.id, 'rejected');

    expect(listPendingConventions(db, 10)).toHaveLength(0);
    expect(listConfirmedConventions(db)).toHaveLength(0);
  });

  it('"skip" is simply not calling setConventionStatus — the convention stays pending and reappears', () => {
    upsertConventions(db, [candidate()]);
    const before = listPendingConventions(db, 10);
    // Simulate a review run where the user answers anything other than y/n — no status write happens.
    const after = listPendingConventions(db, 10);
    expect(after).toEqual(before);
    expect(after[0].status).toBe('pending');
  });
});

describe('rejected conventions do not resurface across re-analysis (build spec §5 demo criterion)', () => {
  it('stays rejected after upsertConventions runs again with fresh detection results for the same slot', () => {
    upsertConventions(db, [candidate({ confidence: 1 })]);
    const [pending] = listPendingConventions(db, 10);
    setConventionStatus(db, pending.id, 'rejected');

    // Re-analysis: the same (module, patternType) slot is detected again,
    // possibly with a slightly different confidence/statement (e.g. a file
    // was added elsewhere in the module) — this must NOT reset status.
    upsertConventions(db, [candidate({ confidence: 0.8, statement: '4/5 files use kebab-case naming.' })]);

    expect(listPendingConventions(db, 10)).toHaveLength(0);
    expect(listConfirmedConventions(db)).toHaveLength(0);

    const row = db.prepare('SELECT status, confidence FROM conventions WHERE id = ?').get(pending.id) as {
      status: string;
      confidence: number;
    };
    expect(row.status).toBe('rejected');
    expect(row.confidence).toBe(0.8); // stats still refresh — only status is preserved
  });

  it('stays confirmed across re-analysis the same way', () => {
    upsertConventions(db, [candidate()]);
    const [pending] = listPendingConventions(db, 10);
    setConventionStatus(db, pending.id, 'confirmed');

    upsertConventions(db, [candidate({ confidence: 0.6 })]);

    const confirmed = listConfirmedConventions(db);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].confidence).toBe(0.6);
  });
});
