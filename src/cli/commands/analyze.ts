import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { analyzeRepo } from '../../analysis/analyzeRepo';
import { groupFilesByModule } from '../../analysis/modules';
import { detectConventions } from '../../analysis/conventions';
import { loadConfig, ConfigError } from '../../config/io';
import { openGraph, graphPath } from '../../graph/db';
import { persistAnalysis } from '../../graph/write';
import { upsertConventions } from '../../graph/conventions';
import { compileAndWriteRegions } from '../../compiler/compileRegions';

export function registerAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description(
      'Full baseline scan: parses the repo, persists modules/symbols into .ctxkeep/graph.sqlite, and ' +
        'writes CLAUDE.md/AGENTS.md/.ai/manifest.md via marker-based region patching.',
    )
    .argument('[path]', 'path to the repo to analyze', '.')
    .action((targetPathArg: string) => {
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

      const result = analyzeRepo(targetDir);
      for (const warning of result.warnings) {
        console.error(`warning: ${warning}`);
      }

      const db = openGraph(targetDir);
      try {
        const stats = persistAnalysis(db, result);
        const relGraphPath = path.relative(targetDir, graphPath(targetDir)).split(path.sep).join('/');
        console.log(`Analyzed ${result.parsedFiles.length} file(s).`);
        console.log(`Wrote ${stats.moduleCount} module(s) and ${stats.symbolCount} symbol(s) to ${relGraphPath}`);

        const conventions = detectConventions(groupFilesByModule(result.parsedFiles));
        upsertConventions(db, conventions);
        console.log(`Detected ${conventions.length} convention candidate(s) (existing confirm/reject decisions preserved).`);

        if (!config.adapters.claude.enabled) {
          console.log('adapters.claude.enabled is false in config — skipping CLAUDE.md/AGENTS.md/manifest writes.');
          return;
        }

        const counts = compileAndWriteRegions(db, targetDir, result);
        const total = counts.WRITTEN + counts.NO_OP;
        console.log(`Compiled ${total} region(s): ${counts.WRITTEN} written, ${counts.NO_OP} unchanged (no-op).`);
      } finally {
        db.close();
      }
    });
}
