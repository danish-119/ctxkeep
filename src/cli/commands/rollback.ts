import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { openGraph } from '../../graph/db';
import { rollbackArtifacts, type RollbackOutcome } from '../../compiler/rollback';

function describe(outcome: RollbackOutcome): string {
  switch (outcome.status) {
    case 'restored':
      return `restored to HEAD`;
    case 'no_op':
      return `already matched HEAD — untouched`;
    case 'not_found_at_head':
      return `skipped — ${outcome.artifactPath} doesn't exist at HEAD (nothing committed to roll back to)`;
    case 'region_not_in_head':
      return `skipped — region not present in the HEAD version of ${outcome.artifactPath}`;
  }
}

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback')
    .description(
      'Reverts every CtxKeep-owned region to its content as of the last git commit (HEAD). ' +
        'Leaves human-owned content, and any region not tracked in artifact_bindings, untouched.',
    )
    .argument('[path]', 'path to the repo', '.')
    .action(async (targetPathArg: string) => {
      const targetDir = path.resolve(targetPathArg);

      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        console.error(`error: ${targetDir} is not a directory`);
        process.exitCode = 1;
        return;
      }

      const db = openGraph(targetDir);
      try {
        const outcomes = await rollbackArtifacts(db, targetDir);

        if (outcomes.length === 0) {
          console.log('No tracked regions to roll back — run `ctxkeep analyze` first.');
          return;
        }

        for (const outcome of outcomes) {
          console.log(`${outcome.artifactPath} [${outcome.regionId}]: ${describe(outcome)}`);
        }

        const restored = outcomes.filter((o) => o.status === 'restored').length;
        console.log(`\n${restored} region(s) restored, ${outcomes.length - restored} already matched or had nothing to restore.`);
        console.log(
          'Note: this reverts the FILE to match HEAD. A subsequent `ctxkeep analyze`/`sync` recomputes fresh ' +
            'from the graph and may reintroduce the same content again if the underlying code hasn\'t changed.',
        );
      } finally {
        db.close();
      }
    });
}
