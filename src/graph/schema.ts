/**
 * MVP subset of the graph schema (build spec §3). All five tables are
 * created now even though only `modules` and `symbols` are populated at
 * this milestone — `conventions`, `checkpoints`, and `artifact_bindings` are load-
 * bearing for Milestones 3-5 and are deliberately not deferred to avoid a later
 * migration.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  path_glob TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  module_id TEXT REFERENCES modules(id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  span_start INTEGER,
  span_end INTEGER,
  signature_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conventions (
  id TEXT PRIMARY KEY,
  module_id TEXT REFERENCES modules(id),
  statement TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  evidence_file_paths TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  module_id TEXT REFERENCES modules(id),
  sha TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_bindings (
  id TEXT PRIMARY KEY,
  artifact_path TEXT NOT NULL,
  region_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  last_emitted_at TEXT NOT NULL,
  UNIQUE(artifact_path, region_id)
);
`;
