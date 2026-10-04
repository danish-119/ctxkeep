import crypto from 'node:crypto';

/**
 * Region marker format (v2):
 *
 *   <!-- ctxkeep:start:<id> sha=<12 hex> -->
 *   ...generated content...
 *   <!-- ctxkeep:end:<id> -->
 *
 * The `sha` is a hash of the content CtxKeep last wrote. It makes every
 * artifact self-describing: on any clone, with or without the (gitignored)
 * graph, CtxKeep can tell whether a region was edited by hand since it was
 * generated, and refuse to overwrite it. Named end markers mean a stray
 * `ctxkeep:end` can never close the wrong region.
 *
 * The v0.1 format (`<!-- ctxkeep:start:<id> -->` ... `<!-- ctxkeep:end -->`)
 * is still read; such regions are treated as unedited and upgraded on the
 * next write.
 */

export interface ParsedRegion {
  id: string;
  /** Hash recorded in the start marker; null for v0.1 markers. */
  sha: string | null;
  content: string;
  /** Line index of the start marker. */
  startLine: number;
  /** Line index of the end marker. */
  endLine: number;
  /** v0.1 marker syntax — needs rewriting to the current format. */
  legacy: boolean;
}

export class MarkerError extends Error {}

const START_RE = /^\s*<!-- ctxkeep:start:(.+?)(?: sha=([0-9a-f]{6,64}))? -->\s*$/;
const END_RE = /^\s*<!-- ctxkeep:end(?::(.+?))? -->\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

export function startMarker(id: string, content: string): string {
  return `<!-- ctxkeep:start:${id} sha=${contentHash(content)} -->`;
}

export function endMarker(id: string): string {
  return `<!-- ctxkeep:end:${id} -->`;
}

export function formatRegion(id: string, content: string): string {
  return `${startMarker(id, content)}\n${content}\n${endMarker(id)}`;
}

/** True when the region's content no longer matches the hash CtxKeep recorded when writing it. */
export function isHandEdited(region: ParsedRegion): boolean {
  return region.sha !== null && region.sha !== contentHash(region.content);
}

/**
 * Parses every region in LF-normalized text. Markers must sit on their own
 * line and are ignored inside fenced code blocks, so a doc that *shows* the
 * marker syntax in an example isn't mistaken for a region. Malformed pairs
 * throw rather than guess — guessing wrong would delete human text.
 */
export function parseRegions(text: string, fileLabel: string): ParsedRegion[] {
  const lines = text.split('\n');
  const regions: ParsedRegion[] = [];
  let open: { id: string; sha: string | null; line: number } | null = null;
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      if (!open) inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const start = START_RE.exec(line);
    if (start) {
      if (open) {
        throw new MarkerError(
          `${fileLabel}:${i + 1}: region "${start[1]}" starts inside region "${open.id}" (opened on line ${open.line + 1}) — ` +
            'nested or unterminated CtxKeep markers. Fix or remove the broken marker pair, then rerun.',
        );
      }
      if (regions.some((r) => r.id === start[1])) {
        throw new MarkerError(`${fileLabel}:${i + 1}: region "${start[1]}" appears twice. Delete one copy, then rerun.`);
      }
      open = { id: start[1], sha: start[2] ?? null, line: i };
      continue;
    }

    const end = END_RE.exec(line);
    if (end) {
      if (!open) {
        throw new MarkerError(`${fileLabel}:${i + 1}: CtxKeep end marker without a matching start marker. Remove it, then rerun.`);
      }
      if (end[1] !== undefined && end[1] !== open.id) {
        throw new MarkerError(
          `${fileLabel}:${i + 1}: end marker for "${end[1]}" closes region "${open.id}" (opened on line ${open.line + 1}).`,
        );
      }
      regions.push({
        id: open.id,
        sha: open.sha,
        content: lines.slice(open.line + 1, i).join('\n'),
        startLine: open.line,
        endLine: i,
        legacy: open.sha === null || end[1] === undefined,
      });
      open = null;
    }
  }

  if (open) {
    throw new MarkerError(
      `${fileLabel}:${open.line + 1}: region "${open.id}" has no end marker — refusing to guess where it ends. ` +
        `Add \`${endMarker(open.id)}\` where the generated block should end, or delete the start marker.`,
    );
  }
  return regions;
}
