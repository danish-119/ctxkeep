import fs from 'node:fs';
import path from 'node:path';
import { readFileAtHead } from '../analysis/git';
import { applyRegions, type RegionOutcome } from './apply';
import { parseRegions } from './markers';

export type RollbackAction = 'restore' | 'unchanged' | 'skipped' | 'error';

export interface RollbackResult {
  path: string;
  action: RollbackAction;
  /** Text to write (restore only). */
  after: string | null;
  /** Per-region outcome: `updated`/`added` here mean "restored to HEAD". */
  outcomes: RegionOutcome[];
  /** Regions present now but not at HEAD — left alone. */
  newSinceHead: string[];
  reason?: string;
}

/**
 * `ctxkeep rollback`: puts every CtxKeep region in the given artifacts back
 * to its content at HEAD, leaving everything outside the markers alone.
 *
 * Works purely from the files (markers carry their own ids and hashes), so
 * it behaves the same on a fresh clone with no graph. Regions added since
 * HEAD are kept — there is no earlier version to return to. If an artifact
 * file was deleted since HEAD (e.g. a per-module doc whose module was
 * removed), it's restored whole.
 */
export function planRollback(rootDir: string, artifactPaths: string[]): RollbackResult[] {
  return artifactPaths.map((relPath): RollbackResult => {
    const base = { path: relPath, after: null, outcomes: [] as RegionOutcome[], newSinceHead: [] as string[] };
    const head = readFileAtHead(rootDir, relPath);
    const absPath = path.join(rootDir, relPath);
    const current = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null;

    if (head === null) return { ...base, action: 'skipped', reason: 'not in HEAD (never committed) — nothing to roll back to' };
    if (current === null) {
      return { ...base, action: 'restore', after: head, reason: 'file was deleted since HEAD — restored whole' };
    }

    try {
      const headRegions = parseRegions(head.replace(/\r\n/g, '\n'), `${relPath}@HEAD`);
      const currentIds = parseRegions(current.replace(/\r\n/g, '\n'), relPath).map((r) => r.id);
      const headIds = new Set(headRegions.map((r) => r.id));
      const out = applyRegions({
        fileLabel: relPath,
        existing: current,
        desired: headRegions.map((r) => ({ id: r.id, content: r.content })),
        isOrphan: () => false,
        force: true, // rollback's whole purpose is to undo edits inside regions
      });
      const newSinceHead = currentIds.filter((id) => !headIds.has(id));
      return { ...base, action: out.changed ? 'restore' : 'unchanged', after: out.changed ? out.text : null, outcomes: out.outcomes, newSinceHead };
    } catch (err) {
      return { ...base, action: 'error', reason: (err as Error).message };
    }
  });
}

export function writeRollback(rootDir: string, results: RollbackResult[]): void {
  for (const r of results) {
    if (r.action !== 'restore' || r.after === null) continue;
    const absPath = path.join(rootDir, r.path);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const tmp = `${absPath}.ctxkeep-${process.pid}.tmp`;
    fs.writeFileSync(tmp, r.after, 'utf8');
    fs.renameSync(tmp, absPath);
  }
}
