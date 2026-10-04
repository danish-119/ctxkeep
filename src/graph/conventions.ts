import type Database from 'better-sqlite3';
import { conventionId, type DetectedConvention } from '../analysis/conventions';

export type ConventionStatus = 'pending' | 'confirmed' | 'rejected';

export interface ConventionRow {
  id: string;
  moduleId: string;
  patternType: string;
  value: string;
  statement: string;
  matched: number;
  sampleSize: number;
  status: ConventionStatus;
  /** Detected in the most recent scan. A confirmed-but-inactive row no longer holds and is not emitted. */
  active: boolean;
  evidenceFilePaths: string[];
}

interface RawRow extends Omit<ConventionRow, 'active' | 'evidenceFilePaths'> {
  active: number;
  evidence: string;
}

const SELECT = `SELECT id, module_id as moduleId, pattern_type as patternType, value, statement, matched,
  sample_size as sampleSize, status, active, evidence_file_paths as evidence FROM conventions`;

function fromRaw(row: RawRow): ConventionRow {
  return { ...row, active: row.active === 1, evidenceFilePaths: JSON.parse(row.evidence) };
}

/**
 * Replaces the detected set: every row is marked inactive, then each current
 * detection is upserted as active. `status` is never touched by detection —
 * a human's confirm/reject survives every re-scan. A convention whose module
 * disappears, or whose pattern stops holding, simply goes inactive (and is
 * dropped from artifacts) instead of being orphaned or emitted stale.
 */
export function syncConventions(db: Database.Database, detected: DetectedConvention[]): void {
  const upsert = db.prepare(`
    INSERT INTO conventions (id, module_id, pattern_type, value, statement, matched, sample_size, status, active, evidence_file_paths)
    VALUES (@id, @moduleId, @patternType, @value, @statement, @matched, @sampleSize, 'pending', 1, @evidence)
    ON CONFLICT(id) DO UPDATE SET
      statement = excluded.statement, matched = excluded.matched, sample_size = excluded.sample_size,
      active = 1, evidence_file_paths = excluded.evidence_file_paths
  `);
  db.transaction(() => {
    db.prepare('UPDATE conventions SET active = 0').run();
    for (const c of detected) {
      upsert.run({
        id: conventionId(c),
        moduleId: c.moduleId,
        patternType: c.patternType,
        value: c.value,
        statement: c.statement,
        matched: c.matched,
        sampleSize: c.sampleSize,
        evidence: JSON.stringify(c.evidenceFilePaths),
      });
    }
  })();
}

/** Ranked queue: highest agreement first, then the widest-reaching evidence. */
export function listPendingConventions(db: Database.Database, limit: number): ConventionRow[] {
  return (
    db
      .prepare(
        `${SELECT} WHERE status = 'pending' AND active = 1
         ORDER BY CAST(matched AS REAL) / MAX(sample_size, 1) DESC, sample_size DESC, id ASC LIMIT ?`,
      )
      .all(limit) as RawRow[]
  ).map(fromRaw);
}

export function countPendingConventions(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as n FROM conventions WHERE status = 'pending' AND active = 1").get() as { n: number }).n;
}

/** Confirmed AND still true in the current code — the only conventions artifacts may state. */
export function listEmittableConventions(db: Database.Database): ConventionRow[] {
  return (db.prepare(`${SELECT} WHERE status = 'confirmed' AND active = 1 ORDER BY module_id, pattern_type, id`).all() as RawRow[]).map(fromRaw);
}

/** Confirmed by a human but no longer detected — surfaced as a warning so the drift is visible. */
export function listLapsedConventions(db: Database.Database): ConventionRow[] {
  return (db.prepare(`${SELECT} WHERE status = 'confirmed' AND active = 0 ORDER BY id`).all() as RawRow[]).map(fromRaw);
}

export function setConventionStatus(db: Database.Database, id: string, status: 'confirmed' | 'rejected'): void {
  db.prepare('UPDATE conventions SET status = ? WHERE id = ?').run(status, id);
}
