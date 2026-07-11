import type Database from 'better-sqlite3';

export interface ArtifactBindingRow {
  artifactPath: string;
  regionId: string;
  contentHash: string;
  lastEmittedAt: string;
}

export function getBinding(db: Database.Database, artifactPath: string, regionId: string): ArtifactBindingRow | undefined {
  const row = db
    .prepare(
      `SELECT artifact_path as artifactPath, region_id as regionId, content_hash as contentHash, last_emitted_at as lastEmittedAt
       FROM artifact_bindings WHERE artifact_path = ? AND region_id = ?`,
    )
    .get(artifactPath, regionId) as ArtifactBindingRow | undefined;
  return row;
}

/** Every currently tracked (artifact, region) pair — what `ctxkeep rollback` iterates over. */
export function listAllBindings(db: Database.Database): ArtifactBindingRow[] {
  return db
    .prepare(
      `SELECT artifact_path as artifactPath, region_id as regionId, content_hash as contentHash, last_emitted_at as lastEmittedAt
       FROM artifact_bindings ORDER BY artifact_path, region_id`,
    )
    .all() as ArtifactBindingRow[];
}

export function upsertBinding(
  db: Database.Database,
  artifactPath: string,
  regionId: string,
  contentHash: string,
  emittedAt: string,
): void {
  db.prepare(
    `INSERT INTO artifact_bindings (id, artifact_path, region_id, content_hash, last_emitted_at)
     VALUES (@id, @artifactPath, @regionId, @contentHash, @lastEmittedAt)
     ON CONFLICT(artifact_path, region_id) DO UPDATE SET
       content_hash = excluded.content_hash,
       last_emitted_at = excluded.last_emitted_at`,
  ).run({
    id: `${artifactPath}:${regionId}`,
    artifactPath,
    regionId,
    contentHash,
    lastEmittedAt: emittedAt,
  });
}
