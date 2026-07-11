import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { loadConfig, ConfigError } from '../../config/io';
import { openGraph } from '../../graph/db';
import { planSync } from '../../analysis/syncPlan';
import { compileAndWriteRegions } from '../../compiler/compileRegions';

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description(
      'Incremental sync: uses git diff against each module\'s last checkpoint to find stale modules, ' +
        're-parses only those, and recompiles only their regions (build spec §4 Milestone 4).',
    )
    .argument('[path]', 'path to the repo to sync', '.')
    .action(async (targetPathArg: string) => {
      const targetDir = path.resolve(targetPathArg);

      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        console.error(`error: ${targetDir} is not a directory`);
        process.exitCode = 1;
        return;
      }

      let config;
      try {
        config = loadConfig(targetDir);
      } catch (err) {
        if (err instanceof ConfigError) {
          console.error(`error: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      const db = openGraph(targetDir);
      try {
        let plan;
        try {
          plan = await planSync(targetDir, db);
        } catch (err) {
          console.error(
            `error: ${(err as Error).message}\n` +
              '(ctxkeep sync requires a git repository with at least one commit)',
          );
          process.exitCode = 1;
          return;
        }

        for (const warning of plan.warnings) {
          console.error(`warning: ${warning}`);
        }

        const staleModules = plan.outcomes.filter((o) => o.stale);
        if (staleModules.length === 0) {
          console.log('No modules stale — nothing changed since the last sync.');
        } else {
          for (const outcome of staleModules) {
            console.log(`Resynced module "${outcome.moduleName}" (${outcome.symbolCount} symbol(s)).`);
          }
        }
        console.log(`HEAD is ${plan.headSha}. ${staleModules.length}/${plan.outcomes.length} module(s) resynced.`);

        if (!config.adapters.claude.enabled) {
          console.log('adapters.claude.enabled is false in config — skipping CLAUDE.md/AGENTS.md/manifest writes.');
          return;
        }

        const counts = compileAndWriteRegions(db, targetDir, plan.snapshot);
        const total = counts.WRITTEN + counts.NO_OP;
        console.log(`Compiled ${total} region(s): ${counts.WRITTEN} written, ${counts.NO_OP} unchanged (no-op).`);
      } finally {
        db.close();
      }
    });
}
