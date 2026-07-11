import path from 'node:path';
import type Database from 'better-sqlite3';
import { readFileAtHead } from '../analysis/gitChanges';
import { listAllBindings } from '../graph/bindings';
import { patchRegion, extractRegionContent } from './patchRegion';

export type RollbackStatus = 'restored' | 'no_op' | 'not_found_at_head' | 'region_not_in_head';

export interface RollbackOutcome {
  artifactPath: string;
  regionId: string;
  status: RollbackStatus;
}

/**
 * `ctxkeep rollback` (build spec §22/§34): reverts every CtxKeep-owned
 * region back to its content as of the last git commit (HEAD) — see
 * DECISIONS.md for why this is "regenerate from HEAD," not a from-scratch
 * SQLite history/backup mechanism. Reuses patchRegion for the actual splice,
 * so it inherits the exact same marker-only, NO_OP, and human-content-
 * preserving guarantees as every other write path in the compiler.
 */
export async function rollbackArtifacts(db: Database.Database, targetDir: string): Promise<RollbackOutcome[]> {
  const bindings = listAllBindings(db);
  const headContentCache = new Map<string, string | null>();
  const outcomes: RollbackOutcome[] = [];

  for (const binding of bindings) {
    let headContent = headContentCache.get(binding.artifactPath);
    if (headContent === undefined) {
      headContent = await readFileAtHead(targetDir, binding.artifactPath);
      headContentCache.set(binding.artifactPath, headContent);
    }

    if (headContent === null) {
      outcomes.push({ artifactPath: binding.artifactPath, regionId: binding.regionId, status: 'not_found_at_head' });
      continue;
    }

    const regionContent = extractRegionContent(headContent, binding.regionId);
    if (regionContent === null) {
      outcomes.push({ artifactPath: binding.artifactPath, regionId: binding.regionId, status: 'region_not_in_head' });
      continue;
    }

    const result = patchRegion({
      db,
      filePath: path.join(targetDir, binding.artifactPath),
      artifactPath: binding.artifactPath,
      regionId: binding.regionId,
      newContent: regionContent,
      // The cached hash in artifact_bindings reflects the last WRITE, not
      // necessarily what's on disk right now — rollback exists specifically
      // to handle drift the cache doesn't know about (hand-edits, or an
      // undesired prior sync). Compare against disk reality, not the cache.
      verifyAgainstDisk: true,
    });

    outcomes.push({
      artifactPath: binding.artifactPath,
      regionId: binding.regionId,
      status: result === 'NO_OP' ? 'no_op' : 'restored',
    });
  }

  return outcomes;
}
