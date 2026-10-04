import type { Command } from 'commander';
import { runGenerate } from './generate';

export function registerAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description(
      'Full scan: re-parses every source file, rebuilds .ctxkeep/graph.sqlite, and updates every configured artifact. ' +
        'Use after upgrading CtxKeep or changing config; day to day, `sync` is faster.',
    )
    .argument('[path]', 'path to the repo', '.')
    .option('--dry-run', 'show the diff of every artifact that would change; write nothing')
    .option('--force', 'overwrite regions that were edited by hand')
    .action((targetPathArg: string, options: { dryRun?: boolean; force?: boolean }) => {
      runGenerate('analyze', targetPathArg, options);
    });
}
