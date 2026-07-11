import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { analyzeRepo } from '../../analysis/analyzeRepo';
import { hasSrcRoot, moduleGlob } from '../../analysis/modules';
import { configExists, configPath, writeConfig } from '../../config/io';
import { ConfigSchema, type Config } from '../../config/schema';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Detects languages/modules and scaffolds .ctxkeep/config.yaml.')
    .argument('[path]', 'path to the repo to initialize', '.')
    .option('--force', 'overwrite an existing config.yaml (discards manual edits)', false)
    .action((targetPathArg: string, options: { force: boolean }) => {
      const targetDir = path.resolve(targetPathArg);

      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        console.error(`error: ${targetDir} is not a directory`);
        process.exitCode = 1;
        return;
      }

      const relConfigPath = path.relative(targetDir, configPath(targetDir)).split(path.sep).join('/');

      if (configExists(targetDir) && !options.force) {
        console.error(`${relConfigPath} already exists — refusing to overwrite.`);
        console.error('Re-run with --force if you want to regenerate it (this discards any manual edits).');
        process.exitCode = 1;
        return;
      }

      const result = analyzeRepo(targetDir);
      for (const warning of result.warnings) {
        console.error(`warning: ${warning}`);
      }

      const srcRooted = hasSrcRoot(result.parsedFiles);
      const config: Config = ConfigSchema.parse({
        adapters: { claude: { enabled: true } },
        modules: result.modules.map((m) => ({ name: m.name, path: moduleGlob(m.name, srcRooted) })),
        ignore: [],
      });

      writeConfig(targetDir, config);

      console.log(`Wrote ${relConfigPath}`);
      console.log(
        `Detected ${result.languagesPresent.join(', ') || 'no Tier-1 languages'} across ${
          result.modules.length
        } module(s), ${result.parsedFiles.length} file(s).`,
      );
      console.log('Next: run `ctxkeep analyze` to populate the graph.');
    });
}
