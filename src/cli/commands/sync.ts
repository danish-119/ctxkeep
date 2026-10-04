import type { Command } from 'commander';
import { runGenerate } from './generate';

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description(
      'Incremental update: detects added/modified/deleted/renamed source files (committed or not) by content hash, ' +
        're-parses only those, and patches only the artifact regions whose content changed.',
    )
    .argument('[path]', 'path to the repo', '.')
    .option('--dry-run', 'show the diff of every artifact that would change; write nothing')
    .option('--check', 'write nothing; exit 1 if any artifact is out of date (for CI / pre-commit)')
    .option('--force', 'overwrite regions that were edited by hand')
    .action((targetPathArg: string, options: { dryRun?: boolean; check?: boolean; force?: boolean }) => {
      runGenerate('sync', targetPathArg, options);
    });
}
