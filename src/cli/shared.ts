import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { ConfigError } from '../config/io';
import { GraphError } from '../graph/db';
import { MarkerError } from '../compiler/markers';
import type { ArtifactResult } from '../artifacts/plan';
import type { PipelineReport } from '../pipeline';
import type { RegionOutcome } from '../compiler/apply';

/** Resolves the [path] argument, or prints an error and returns null. */
export function resolveTarget(arg: string): string | null {
  const targetDir = path.resolve(arg);
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    console.error(`error: ${targetDir} is not a directory`);
    process.exitCode = 1;
    return null;
  }
  return targetDir;
}

/** Known, user-actionable failures print one clean message; anything else is a bug and keeps its stack. */
export function handleError(err: unknown): void {
  if (err instanceof ConfigError || err instanceof GraphError || err instanceof MarkerError) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  throw err;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function describeChanges(report: PipelineReport): string {
  const { refresh, model } = report;
  const { added, modified, deleted } = refresh.changes;
  const total = model.files.length;
  const parts = [
    modified.length && `${modified.length} modified`,
    added.length && `${added.length} added`,
    deleted.length && `${deleted.length} deleted`,
  ].filter(Boolean);

  if (refresh.full) {
    return `Analyzed ${plural(total, 'source file')} in ${plural(model.modules.length, 'module')} (parsed ${refresh.parsedCount}).`;
  }
  if (parts.length === 0) return `No source changes since the last sync (${plural(total, 'file')} checked).`;
  const modules = report.changedModules.map((m) => (m === '.' ? '(root)' : m)).join(', ');
  return `Source changes: ${parts.join(', ')} in ${modules} — re-parsed ${plural(refresh.parsedCount, 'file')}.`;
}

function summarizeOutcomes(outcomes: RegionOutcome[]): string {
  const by = (status: RegionOutcome['status']) => outcomes.filter((o) => o.status === status).map((o) => o.id);
  const parts: string[] = [];
  const updated = by('updated');
  const added = by('added');
  const removed = by('removed');
  if (updated.length) parts.push(`updated ${updated.join(', ')}`);
  if (added.length) parts.push(`added ${added.join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.join(', ')}`);
  return parts.join('; ');
}

const ACTION_LABEL: Record<ArtifactResult['action'], string> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  unchanged: 'unchanged',
  error: 'ERROR',
};

/** Per-artifact lines. Returns true if anything needs attention (conflict or error). */
export function printArtifactResults(results: ArtifactResult[]): boolean {
  let attention = false;
  const width = Math.max(...results.map((r) => r.path.length), 10);
  const unchanged: string[] = [];

  for (const r of results) {
    const conflicts = r.outcomes.filter((o) => o.status === 'conflict');
    if (r.action === 'unchanged' && conflicts.length === 0) {
      unchanged.push(r.path);
      continue;
    }
    if (r.action === 'error') {
      attention = true;
      console.log(`  ${'ERROR'.padEnd(10)} ${r.path}`);
      console.log(`             ${r.error}`);
      continue;
    }
    if (r.action !== 'unchanged') {
      const detail = r.action === 'create' || r.action === 'delete' ? '' : summarizeOutcomes(r.outcomes);
      console.log(`  ${ACTION_LABEL[r.action].padEnd(10)} ${r.path.padEnd(width)}  ${detail}`.trimEnd());
    }
    for (const c of conflicts) {
      attention = true;
      console.log(`  ${'CONFLICT'.padEnd(10)} ${r.path.padEnd(width)}  ${c.id}: ${c.note}`);
    }
    for (const id of r.unknownRegions) {
      console.log(`  ${'note'.padEnd(10)} ${r.path.padEnd(width)}  unrecognised region "${id}" left untouched`);
    }
  }
  if (unchanged.length > 0) console.log(`  ${'unchanged'.padEnd(10)} ${unchanged.join(', ')}`);
  return attention;
}

export function printDiffs(results: ArtifactResult[]): void {
  for (const r of results) {
    if (r.action === 'unchanged' || r.action === 'error') continue;
    const before = (r.before ?? '').replace(/\r\n/g, '\n');
    const after = r.action === 'delete' ? '' : (r.after ?? '').replace(/\r\n/g, '\n');
    const label = r.action === 'create' ? '(new file)' : r.action === 'delete' ? '(deleted)' : '';
    const patch = createTwoFilesPatch(`a/${r.path}`, `b/${r.path}`, before, after, label, '', { context: 3 });
    console.log(patch.split('\n').slice(1).join('\n').trimEnd()); // drop the "=====" banner line
    console.log('');
  }
}

export function printWarningsAndFollowUps(report: PipelineReport): void {
  for (const w of report.refresh.warnings) console.error(`warning: ${w}`);
  for (const c of report.lapsedConventions) {
    console.error(`warning: confirmed convention no longer holds and is no longer emitted: "${c.statement}" (${c.id})`);
  }
  if (report.pendingConventions > 0) {
    console.log(`\n${plural(report.pendingConventions, 'convention candidate')} awaiting review — run \`ctxkeep review conventions\`.`);
  }
}

export function hasPendingWrites(results: ArtifactResult[]): boolean {
  return results.some((r) => r.action === 'create' || r.action === 'update' || r.action === 'delete');
}

export function needsAttention(results: ArtifactResult[]): boolean {
  return results.some((r) => r.action === 'error' || r.outcomes.some((o) => o.status === 'conflict'));
}
