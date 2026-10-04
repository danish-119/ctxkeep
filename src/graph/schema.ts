/**
 * Graph schema v2. The graph is a regenerable cache of the working tree
 * (gitignored, like node_modules) with ONE exception: the human
 * confirm/reject decisions in `conventions`, which migrations must carry
 * forward.
 *
 * - `files` is the change-detection ledger: size + mtime + content hash per
 *   tracked source file. `sync` compares the working tree against it, so
 *   uncommitted edits, deletes, renames, rebases, and repos without git all
 *   behave the same way.
 * - `symbols` / `imports` hold per-file parse output and cascade-delete with
 *   their file. Imports are stored raw (specifier + names) and resolved at
 *   render time, so adding a file that satisfies an existing import never
 *   leaves a stale edge behind.
 * - Module membership is NOT stored: it's a pure function of the path and
 *   config, recomputed every run, so changing module overrides needs no
 *   migration or re-parse.
 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  content_hash TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  doc_summary TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  exported INTEGER NOT NULL,
  is_default INTEGER NOT NULL,
  line INTEGER NOT NULL,
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  signature_hash TEXT NOT NULL,
  PRIMARY KEY (file_path, ordinal)
);

CREATE TABLE IF NOT EXISTS imports (
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  specifier TEXT NOT NULL,
  names TEXT NOT NULL,
  PRIMARY KEY (file_path, ordinal)
);

CREATE TABLE IF NOT EXISTS conventions (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  value TEXT NOT NULL,
  statement TEXT NOT NULL,
  matched INTEGER NOT NULL,
  sample_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  active INTEGER NOT NULL DEFAULT 1,
  evidence_file_paths TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
