import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/graph/schema';
import { upsertConventions, listPendingConventions, listConfirmedConventions } from '../../src/graph/conventions';
import { applyReviewAnswer } from '../../src/cli/commands/reviewConventions';
import type { DetectedConvention } from '../../src/analysis/conventions';

let db: Database.Database;

function candidate(): DetectedConvention {
  return {
    patternType: 'file-naming',
    moduleId: 'mod',
    statement: '3/3 files use kebab-case naming.',
    confidence: 1,
    evidenceFilePaths: ['src/mod/a.ts'],
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT INTO modules (id, path_glob, name) VALUES (?, ?, ?)').run('mod', 'src/mod/**', 'mod');
  upsertConventions(db, [candidate()]);
});

afterEach(() => {
  db.close();
});

describe('applyReviewAnswer — the testable core behind `ctxkeep review conventions`', () => {
  it('"y" confirms and moves the row out of pending', () => {
    const [conv] = listPendingConventions(db, 10);
    const outcome = applyReviewAnswer(db, conv, 'y');
    expect(outcome).toBe('confirmed');
    expect(listPendingConventions(db, 10)).toHaveLength(0);
    expect(listConfirmedConventions(db)).toHaveLength(1);
  });

  it('"yes" is also accepted as confirm', () => {
    const [conv] = listPendingConventions(db, 10);
    expect(applyReviewAnswer(db, conv, 'YES')).toBe('confirmed'); // case-insensitive
  });

  it('"n" rejects and moves the row out of pending, but not into confirmed', () => {
    const [conv] = listPendingConventions(db, 10);
    const outcome = applyReviewAnswer(db, conv, 'n');
    expect(outcome).toBe('rejected');
    expect(listPendingConventions(db, 10)).toHaveLength(0);
    expect(listConfirmedConventions(db)).toHaveLength(0);
  });

  it('"s" (or anything else) skips — no DB write, row stays pending', () => {
    const [conv] = listPendingConventions(db, 10);
    const outcome = applyReviewAnswer(db, conv, 's');
    expect(outcome).toBe('skipped');
    const stillPending = listPendingConventions(db, 10);
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].id).toBe(conv.id);
  });

  it('an empty or garbage answer also skips rather than throwing or defaulting to confirm', () => {
    const [conv] = listPendingConventions(db, 10);
    expect(applyReviewAnswer(db, conv, '')).toBe('skipped');
    expect(applyReviewAnswer(db, conv, 'asdf')).toBe('skipped');
  });
});
