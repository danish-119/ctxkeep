import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getBinding, upsertBinding } from '../graph/bindings';

export type PatchResult = 'NO_OP' | 'WRITTEN';

export interface PatchRegionOptions {
  db: Database.Database;
  /** Absolute path to the file on disk. */
  filePath: string;
  /** Stable key stored in artifact_bindings — repo-relative, e.g. "CLAUDE.md" or ".ai/manifest.md". */
  artifactPath: string;
  regionId: string;
  newContent: string;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => string;
  /**
   * When true, ignore the cached content_hash in artifact_bindings and
   * instead compare newContent against what's ACTUALLY on disk right now.
   * The default (false) trusts the cache and never touches the filesystem
   * on a cache hit — correct and fast for the analyze/sync hot path, where
   * patchRegion is the only writer of these regions. `ctxkeep rollback`
   * sets this: its entire job is detecting content that drifted from the
   * cache WITHOUT going through patchRegion (a hand-edit, or an undesired
   * prior write) — trusting the cache there would make rollback silently
   * do nothing in exactly the case it exists to handle.
   */
  verifyAgainstDisk?: boolean;
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Marker-based region patcher (build spec §5). The NO_OP path — when the
 * region's content hash is unchanged, the file is not opened for writing at
 * all — is the load-bearing property here: it's what keeps re-emission
 * minimal-diff and prompt-cache-friendly (architecture plan §16, §25).
 */
export function patchRegion(options: PatchRegionOptions): PatchResult {
  const { db, filePath, artifactPath, regionId, verifyAgainstDisk = false } = options;
  const now = options.now ?? (() => new Date().toISOString());

  // Normalize to LF up front — both the hashed content and anything read off
  // disk. Without this, a file checked out with CRLF (e.g. Windows + git
  // core.autocrlf=true) gets spliced with LF-only generated content, producing
  // a mixed-line-ending file: bytes that should read as "unchanged" actually
  // differ from what's committed, showing up as a spurious git diff on
  // regions nothing touched — silently defeating the "only the changed
  // region's diff shows up" guarantee this compiler exists to provide.
  const newContent = options.newContent.replace(/\r\n/g, '\n');

  const newHash = sha256Hex(newContent);
  const existingBinding = getBinding(db, artifactPath, regionId);

  if (!verifyAgainstDisk && existingBinding && existingBinding.contentHash === newHash) {
    return 'NO_OP';
  }

  const startMarker = `<!-- ctxkeep:start:${regionId} -->`;
  const endMarker = `<!-- ctxkeep:end -->`;

  const fileText = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n') : '';

  if (verifyAgainstDisk && extractRegionContent(fileText, regionId) === newContent) {
    return 'NO_OP';
  }

  const startIdx = fileText.indexOf(startMarker);

  let nextText: string;
  if (startIdx !== -1) {
    const contentStart = startIdx + startMarker.length;
    const endIdx = fileText.indexOf(endMarker, contentStart);
    if (endIdx === -1) {
      throw new Error(
        `${artifactPath}: found start marker for region "${regionId}" but no matching end marker — ` +
          'refusing to guess (the file may have been hand-edited in a way that broke the marker pair).',
      );
    }
    nextText = `${fileText.slice(0, contentStart)}\n${newContent}\n${fileText.slice(endIdx)}`;
  } else {
    const separator = fileText.length > 0 && !fileText.endsWith('\n') ? '\n' : '';
    nextText = `${fileText}${separator}${startMarker}\n${newContent}\n${endMarker}\n`;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextText, 'utf8');
  upsertBinding(db, artifactPath, regionId, newHash, now());

  return 'WRITTEN';
}

/**
 * The precise inverse of the splicing patchRegion performs: given a full
 * file's text and a region id, returns exactly the `newContent` a prior
 * patchRegion call would have inserted, or null if that region's markers
 * aren't present. Used by `ctxkeep rollback` to pull a region's content
 * back out of a historical (git HEAD) version of a file.
 */
export function extractRegionContent(text: string, regionId: string): string | null {
  const startMarker = `<!-- ctxkeep:start:${regionId} -->`;
  const endMarker = `<!-- ctxkeep:end -->`;

  const normalized = text.replace(/\r\n/g, '\n');
  const startIdx = normalized.indexOf(startMarker);
  if (startIdx === -1) return null;

  const contentStart = startIdx + startMarker.length;
  const endIdx = normalized.indexOf(endMarker, contentStart);
  if (endIdx === -1) return null;

  // patchRegion always writes the body as exactly `\n${newContent}\n` between
  // the markers (both the splice-in-place and append-fresh code paths) — so
  // stripping exactly one leading and one trailing newline recovers the
  // original newContent byte-for-byte.
  let body = normalized.slice(contentStart, endIdx);
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return body;
}
