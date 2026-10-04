import { runPipeline, type PipelineMode } from '../../pipeline';
import { findDrift, formatFinding } from '../../drift';
import {
  describeChanges,
  handleError,
  hasPendingWrites,
  needsAttention,
  printArtifactResults,
  printDiffs,
  printWarningsAndFollowUps,
  resolveTarget,
} from '../shared';

export interface GenerateOptions {
  dryRun?: boolean;
  check?: boolean;
  force?: boolean;
}

/**
 * Shared body of `analyze` and `sync` — they differ only in whether the
 * refresh is full or incremental.
 *
 * Exit codes: 0 success; 1 on errors, on hand-edit conflicts, and (with
 * --check) whenever any artifact is out of date, so CI can gate on it.
 */
export function runGenerate(mode: Exclude<PipelineMode, 'try'>, targetArg: string, options: GenerateOptions): void {
  const targetDir = resolveTarget(targetArg);
  if (!targetDir) return;

  const preview = Boolean(options.dryRun || options.check);
  let report;
  try {
    report = runPipeline({ rootDir: targetDir, mode, preview, force: options.force });
  } catch (err) {
    handleError(err);
    return;
  }

  if (!report.configFound && !options.check) {
    console.log('No .ctxkeep/config.yaml — using defaults (run `ctxkeep init` to customise artifacts and modules).');
  }
  console.log(describeChanges(report));

  const pending = hasPendingWrites(report.results);
  const attention = needsAttention(report.results);

  if (options.check) {
    if (!pending && !attention) {
      console.log(`All ${report.results.length} artifacts are up to date.`);
    } else {
      console.log('Out of date:');
      printArtifactResults(report.results);
      console.log('\nRun `ctxkeep sync` and commit the result.');
      process.exitCode = 1;
    }
    return;
  }

  if (options.dryRun) printDiffs(report.results);

  if (!pending && !attention) {
    console.log(`All ${report.results.length} artifacts are up to date — nothing ${options.dryRun ? 'would be ' : ''}written.`);
  } else {
    console.log(options.dryRun ? 'Dry run — would write:' : 'Artifacts:');
    printArtifactResults(report.results);
  }
  if (options.dryRun) console.log('\nDry run: nothing was written (graph included).');
  printWarningsAndFollowUps(report);

  // A reminder, not a failure: `ctxkeep check` is the command that fails on drift.
  const drift = findDrift(targetDir, report.config, report.artifacts, report.model);
  if (drift.length > 0) {
    console.log(`\nHand-written docs: ${drift.length} statement(s) no longer match the code, e.g.`);
    for (const f of drift.slice(0, 3)) console.log(`  ${formatFinding(f)}`);
    console.log('Run `ctxkeep check` for the full list.');
  }

  if (attention) process.exitCode = 1;
}
