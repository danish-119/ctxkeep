import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { listSourceFiles } from './walker';
import { parseFile } from './parser';
import { isParsedLanguage, languageForPath } from './languages';
import { deleteFile, getFileRecords, getMeta, setMeta, touchFile, writeFile, type FileRecord, type ParseStatus } from '../graph/store';

/**
 * Bump whenever parser output changes shape or meaning: a mismatch with the
 * value stored in the graph forces a full re-parse, so upgrading CtxKeep
 * never leaves symbols extracted by an older parser behind.
 */
export const PARSER_VERSION = '3';

/** Files larger than this are tracked but not parsed — they're almost always generated or vendored. */
export const MAX_PARSE_BYTES = 512 * 1024;

/**
 * File-system timestamps are coarse. A file modified within this window of
 * the previous scan could have changed again without moving its mtime, so it
 * is always re-hashed (the same "racy clean" rule git's index uses).
 */
const RACY_WINDOW_MS = 2000;

export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: number;
}

export interface RefreshResult {
  changes: ChangeSet;
  /** Files actually parsed this time (not just hashed). */
  parsedCount: number;
  /** True when every file was re-parsed (analyze, first sync, or a parser upgrade). */
  full: boolean;
  warnings: string[];
}

export interface RefreshOptions {
  /** Re-parse everything even if hashes match (`ctxkeep analyze`). */
  full?: boolean;
  extraIgnores?: string[];
  /** Injectable clock for tests. */
  now?: () => number;
}

function sha1(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/**
 * Brings the graph in line with the working tree and reports exactly what
 * changed. Change detection is content-based, not git-history-based:
 *
 *   unchanged size+mtime (outside the racy window) → skipped without reading
 *   otherwise → hashed; same hash → metadata-only update, no re-parse
 *   new hash → re-parsed;  path gone → deleted (symbols/imports cascade)
 *
 * This catches what a `git diff <checkpoint>..HEAD` approach can't:
 * uncommitted edits, deleted files, both sides of a rename, history rewrites
 * that orphan a checkpoint SHA, and repos without git. Only changed files
 * are parsed, so a sync costs one `stat` per file plus work proportional to
 * the change.
 */
export function refreshGraph(db: Database.Database, rootDir: string, options: RefreshOptions = {}): RefreshResult {
  const now = options.now ?? Date.now;
  const scanStartedAt = now();
  const warnings: string[] = [];
  const changes: ChangeSet = { added: [], modified: [], deleted: [], unchanged: 0 };

  const known = getFileRecords(db);
  const parserUpgraded = known.size > 0 && getMeta(db, 'parser_version') !== PARSER_VERSION;
  const full = Boolean(options.full) || known.size === 0 || parserUpgraded;
  if (parserUpgraded) warnings.push('CtxKeep\'s parser changed since the last scan — re-parsing every file once.');

  const lastScan = Number(getMeta(db, 'last_scan_started_ms') ?? '0');
  const current = listSourceFiles(rootDir, { extraIgnores: options.extraIgnores });
  const currentSet = new Set(current);
  let parsedCount = 0;

  const run = db.transaction(() => {
    for (const relPath of current) {
      const absPath = path.join(rootDir, relPath);
      const language = languageForPath(relPath)!;
      const prior = known.get(relPath);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch (err) {
        warnings.push(`could not read ${relPath}: ${(err as Error).message}`);
        continue;
      }

      const metadataMatches =
        prior !== undefined && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs && stat.mtimeMs < lastScan - RACY_WINDOW_MS;
      if (!full && metadataMatches) {
        changes.unchanged += 1;
        continue;
      }

      let content: Buffer;
      try {
        content = fs.readFileSync(absPath);
      } catch (err) {
        warnings.push(`could not read ${relPath}: ${(err as Error).message}`);
        continue;
      }
      const contentHash = sha1(content);
      const contentChanged = prior === undefined || prior.contentHash !== contentHash;

      if (!full && !contentChanged) {
        touchFile(db, relPath, stat.mtimeMs);
        changes.unchanged += 1;
        continue;
      }

      if (prior === undefined) changes.added.push(relPath);
      else if (contentChanged) changes.modified.push(relPath);
      else changes.unchanged += 1;

      let parseStatus: ParseStatus = 'file-only';
      let parsed = null;
      if (isParsedLanguage(language)) {
        if (stat.size > MAX_PARSE_BYTES) {
          parseStatus = 'too-large';
        } else {
          try {
            parsed = parseFile(relPath, content.toString('utf8'));
            parseStatus = 'parsed';
            parsedCount += 1;
          } catch (err) {
            parseStatus = 'error';
            warnings.push(`could not parse ${relPath}: ${(err as Error).message}`);
          }
        }
      }

      const record: FileRecord = {
        path: relPath,
        language,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        contentHash,
        parseStatus,
        docSummary: parsed?.docSummary ?? null,
      };
      writeFile(db, record, parsed);
    }

    for (const relPath of known.keys()) {
      if (!currentSet.has(relPath)) {
        deleteFile(db, relPath);
        changes.deleted.push(relPath);
      }
    }

    setMeta(db, 'last_scan_started_ms', String(scanStartedAt));
    setMeta(db, 'parser_version', PARSER_VERSION);
  });
  run();

  return { changes, parsedCount, full, warnings };
}
