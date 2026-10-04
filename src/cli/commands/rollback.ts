import type { Command } from 'commander';
import { loadConfig } from '../../config/io';
import { listArtifactPaths, resolveArtifactConfigs } from '../../artifacts/plan';
import { hasGitHead } from '../../analysis/git';
import { planRollback, writeRollback } from '../../compiler/rollback';
import { handleError, resolveTarget } from '../shared';

export const ROLLBACK_NOTE =
  'Note: this reverts the FILES to match HEAD. A subsequent `ctxkeep analyze`/`sync` recomputes from the code ' +
  "and will reintroduce the same content if the underlying code hasn't changed.";

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback')
    .description(
      'Restores every CtxKeep region in the configured artifacts to its content at git HEAD. ' +
        'Text outside the markers is left alone; regions added since HEAD are kept.',
    )
    .argument('[path]', 'path to the repo', '.')
    .option('--dry-run', 'list what would be restored; write nothing')
    .action((targetPathArg: string, options: { dryRun?: boolean }) => {
      const targetDir = resolveTarget(targetPathArg);
      if (!targetDir) return;

      if (!hasGitHead(targetDir)) {
        console.error('error: rollback restores from git HEAD, but this is not a git repository with at least one commit.');
        process.exitCode = 1;
        return;
      }

      let results;
      try {
        const artifacts = resolveArtifactConfigs(loadConfig(targetDir).config, targetDir);
        results = planRollback(targetDir, listArtifactPaths(targetDir, artifacts));
      } catch (err) {
        handleError(err);
        return;
      }

      const verb = options.dryRun ? 'would restore' : 'restored';
      for (const r of results) {
        if (r.action === 'restore') {
          const restored = r.outcomes.filter((o) => o.status === 'updated' || o.status === 'added').map((o) => o.id);
          console.log(`${verb.padEnd(13)} ${r.path}  ${r.reason ?? restored.join(', ')}`);
        } else if (r.action === 'unchanged') {
          console.log(`${'unchanged'.padEnd(13)} ${r.path}  (matches HEAD)`);
        } else if (r.action === 'skipped') {
          console.log(`${'skipped'.padEnd(13)} ${r.path}  ${r.reason}`);
        } else {
          console.log(`${'ERROR'.padEnd(13)} ${r.path}  ${r.reason}`);
          process.exitCode = 1;
        }
        if (r.newSinceHead.length) console.log(`${''.padEnd(13)} kept regions added since HEAD: ${r.newSinceHead.join(', ')}`);
      }

      if (!options.dryRun) writeRollback(targetDir, results);
      if (results.some((r) => r.action === 'restore')) console.log(`\n${ROLLBACK_NOTE}`);
    });
}
