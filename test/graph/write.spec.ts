import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/graph/schema';
import { persistAnalysis } from '../../src/graph/write';
import { recordCheckpoint } from '../../src/graph/checkpoints';
import { upsertConventions } from '../../src/graph/conventions';
import type { AnalysisResult } from '../../src/analysis/analyzeRepo';

let db: Database.Database;

function fakeResult(): AnalysisResult {
  return {
    targetDir: '/repo',
    projectName: 'demo',
    languagesPresent: ['typescript'],
    warnings: [],
    modules: [{ name: 'mod', fileCount: 1, languages: ['typescript'], sampleSymbols: [] }],
    parsedFiles: [
      {
        relPath: 'src/mod/a.ts',
        language: 'typescript',
        symbols: [
          {
            kind: 'function',
            name: 'foo',
            line: 1,
            startIndex: 0,
            endIndex: 10,
            exported: true,
            signatureHash: 'hash1',
            usesTryCatch: false,
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

describe('persistAnalysis — re-running after checkpoints/conventions exist (regression)', () => {
  it('does not throw a foreign key constraint error when a module already has checkpoint history', () => {
    persistAnalysis(db, fakeResult());
    recordCheckpoint(db, 'mod', 'sha-1', '2026-01-01T00:00:00.000Z');

    // This used to DELETE FROM modules, which fails once a checkpoint row
    // references that module's id under foreign_keys=ON (this better-sqlite3
    // build's default) — found by dogfooding `ctxkeep analyze` against a
    // real repo that already had Milestone 4 checkpoint history in its graph.
    expect(() => persistAnalysis(db, fakeResult())).not.toThrow();

    // The checkpoint itself must survive an analyze re-run untouched — analyze
    // doesn't own checkpoints, sync does.
    const checkpointCount = (db.prepare('SELECT COUNT(*) as n FROM checkpoints').get() as { n: number }).n;
    expect(checkpointCount).toBe(1);
  });

  it('does not throw when a module already has convention history', () => {
    persistAnalysis(db, fakeResult());
    upsertConventions(db, [
      {
        patternType: 'file-naming',
        moduleId: 'mod',
        statement: '1/1 files use kebab-case naming.',
        confidence: 1,
        evidenceFilePaths: ['src/mod/a.ts'],
      },
    ]);

    expect(() => persistAnalysis(db, fakeResult())).not.toThrow();

    const conventionCount = (db.prepare('SELECT COUNT(*) as n FROM conventions').get() as { n: number }).n;
    expect(conventionCount).toBe(1);
  });

  it('running analyze twice in a row with no changes does not duplicate module or symbol rows', () => {
    persistAnalysis(db, fakeResult());
    persistAnalysis(db, fakeResult());

    const moduleCount = (db.prepare('SELECT COUNT(*) as n FROM modules').get() as { n: number }).n;
    const symbolCount = (db.prepare('SELECT COUNT(*) as n FROM symbols').get() as { n: number }).n;
    expect(moduleCount).toBe(1);
    expect(symbolCount).toBe(1);
  });
});
