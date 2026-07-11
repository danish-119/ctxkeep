import type Database from 'better-sqlite3';
import type { DetectedConvention } from '../analysis/conventions';

export type ConventionStatus = 'pending' | 'confirmed' | 'rejected';

export interface ConventionRow {
  id: string;
  moduleId: string;
  statement: string;
  confidence: number;
  status: ConventionStatus;
  evidenceFilePaths: string[];
}

/** One convention slot per (module, pattern type) — stable across re-runs regardless of how the statement/confidence text drifts. */
export function conventionId(moduleId: string, patternType: string): string {
  return `${moduleId}:${patternType}`;
}

interface ConventionRowRaw {
  id: string;
  moduleId: string;
  statement: string;
  confidence: number;
  status: ConventionStatus;
  evidenceFilePathsJson: string;
}

function fromRaw(row: ConventionRowRaw): ConventionRow {
  return { ...row, evidenceFilePaths: JSON.parse(row.evidenceFilePathsJson) };
}

/**
 * Upserts detected conventions. Deliberately does NOT reset `status` on an
 * existing row — a human's confirm/reject decision must survive later
 * re-analysis even if the underlying stats shift slightly, which is what
 * makes "rejected conventions don't resurface" (build spec §5 demo
 * criterion) actually hold across repo changes, not just within one run.
 */
export function upsertConventions(db: Database.Database, conventions: DetectedConvention[]): void {
  const stmt = db.prepare(`
    INSERT INTO conventions (id, module_id, statement, confidence, status, evidence_file_paths)
    VALUES (@id, @moduleId, @statement, @confidence, 'pending', @evidenceFilePathsJson)
    ON CONFLICT(id) DO UPDATE SET
      statement = excluded.statement,
      confidence = excluded.confidence,
      evidence_file_paths = excluded.evidence_file_paths
  `);

  const run = db.transaction((items: DetectedConvention[]) => {
    for (const c of items) {
      stmt.run({
        id: conventionId(c.moduleId, c.patternType),
        moduleId: c.moduleId,
        statement: c.statement,
        confidence: c.confidence,
        evidenceFilePathsJson: JSON.stringify(c.evidenceFilePaths),
      });
    }
  });

  run(conventions);
}

export function listPendingConventions(db: Database.Database, limit: number): ConventionRow[] {
  const rows = db
    .prepare(
      `SELECT id, module_id as moduleId, statement, confidence, status, evidence_file_paths as evidenceFilePathsJson
       FROM conventions WHERE status = 'pending' ORDER BY confidence DESC, id ASC LIMIT ?`,
    )
    .all(limit) as ConventionRowRaw[];
  return rows.map(fromRaw);
}

export function listConfirmedConventions(db: Database.Database): ConventionRow[] {
  const rows = db
    .prepare(
      `SELECT id, module_id as moduleId, statement, confidence, status, evidence_file_paths as evidenceFilePathsJson
       FROM conventions WHERE status = 'confirmed' ORDER BY confidence DESC, id ASC`,
    )
    .all() as ConventionRowRaw[];
  return rows.map(fromRaw);
}

export function setConventionStatus(db: Database.Database, id: string, status: 'confirmed' | 'rejected'): void {
  db.prepare('UPDATE conventions SET status = ? WHERE id = ?').run(status, id);
}
