import type Database from 'better-sqlite3';

export interface CheckpointRow {
  moduleId: string;
  sha: string;
  verifiedAt: string;
}

/**
 * `checkpoints` has no uniqueness constraint on module_id (build spec §3) —
 * it's an append-only verification log, not a single current-value table
 * like `artifact_bindings`. "The" checkpoint for a module is its most recent
 * row.
 */
export function getCheckpoint(db: Database.Database, moduleId: string): CheckpointRow | undefined {
  const row = db
    .prepare(
      `SELECT module_id as moduleId, sha, verified_at as verifiedAt
       FROM checkpoints WHERE module_id = ?
       ORDER BY verified_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(moduleId) as CheckpointRow | undefined;
  return row;
}

export function recordCheckpoint(db: Database.Database, moduleId: string, sha: string, verifiedAt: string): void {
  db.prepare('INSERT INTO checkpoints (id, module_id, sha, verified_at) VALUES (@id, @moduleId, @sha, @verifiedAt)').run(
    {
      id: `${moduleId}:${sha}:${verifiedAt}`,
      moduleId,
      sha,
      verifiedAt,
    },
  );
}
