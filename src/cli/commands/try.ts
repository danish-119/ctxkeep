import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { createTwoFilesPatch } from 'diff';
import { analyzeRepo } from '../../analysis/analyzeRepo';
import { buildClaudeMdTemplate } from '../../adapters/claude/template';

export function registerTryCommand(program: Command): void {
  program
    .command('try')
    .description(
      'Zero-commitment preview: analyzes the repo and prints the proposed CLAUDE.md as a diff. Writes nothing to disk. No .ctxkeep/ config required.',
    )
    .argument('[path]', 'path to the repo to analyze', '.')
    .action((targetPathArg: string) => {
      const targetDir = path.resolve(targetPathArg);

      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        console.error(`error: ${targetDir} is not a directory`);
        process.exitCode = 1;
        return;
      }

      const result = analyzeRepo(targetDir);
      for (const warning of result.warnings) {
        console.error(`warning: ${warning}`);
      }

      const proposed = buildClaudeMdTemplate({
        projectName: result.projectName,
        languages: result.languagesPresent,
        totalFiles: result.parsedFiles.length,
        modules: result.modules,
      });

      const patch = createTwoFilesPatch('CLAUDE.md (empty)', 'CLAUDE.md (proposed)', '', proposed, '', '', {
        context: proposed.split('\n').length,
      });

      console.log(patch);
    });
}
