import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  buildAgentsRegions,
  buildClaudeRegions,
  buildConventionsRegion,
  buildManifestRegions,
  type RegionInput,
} from '../adapters/claude/regions';
import { listConfirmedConventions } from '../graph/conventions';
import { patchRegion, type PatchResult } from './patchRegion';

export type CompileStats = Record<PatchResult, number>;

/**
 * Shared by `ctxkeep analyze` (full re-parse) and `ctxkeep sync`
 * (module-scoped re-parse, build spec §4 Milestone 4) — both end up with a
 * `RegionInput` snapshot of the repo's current facts, and from there the
 * compile-and-write step is identical. patchRegion's content-hash NO_OP is
 * what makes this safe to call with a full snapshot every time: a region
 * whose underlying facts didn't change hashes the same and is never touched,
 * whether it came from `analyze` or `sync`.
 *
 * The `conventions` region is the one exception to "pure function of
 * snapshot": it reads confirmed rows from the graph directly (build spec §4
 * Milestone 5), since confirm/reject decisions live in the DB, not in the
 * analysis snapshot. Confirming a convention and re-running compiles this
 * region's new content and nothing else — same NO_OP guarantee, applied to
 * one more region.
 */
export function compileAndWriteRegions(db: Database.Database, targetDir: string, snapshot: RegionInput): CompileStats {
  const regions = [
    ...buildClaudeRegions(snapshot),
    buildConventionsRegion(listConfirmedConventions(db)),
    ...buildAgentsRegions(snapshot),
    ...buildManifestRegions(snapshot),
  ];

  const counts: CompileStats = { WRITTEN: 0, NO_OP: 0 };
  for (const region of regions) {
    const outcome = patchRegion({
      db,
      filePath: path.join(targetDir, region.artifactRelPath),
      artifactPath: region.artifactRelPath,
      regionId: region.regionId,
      newContent: region.content,
    });
    counts[outcome] += 1;
  }

  return counts;
}
