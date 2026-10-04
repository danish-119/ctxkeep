import type { Command } from 'commander';
import { runPipeline } from '../../pipeline';
import { describeChanges, handleError, printArtifactResults, printDiffs, resolveTarget } from '../shared';

export function registerTryCommand(program: Command): void {
  program
    .command('try')
    .description(
      'Zero-commitment preview: shows exactly what `ctxkeep analyze` would write, as a diff against what is on disk. ' +
        'Writes nothing — no files, no .ctxkeep/ directory.',
    )
    .argument('[path]', 'path to the repo', '.')
    .action((targetPathArg: string) => {
      const targetDir = resolveTarget(targetPathArg);
      if (!targetDir) return;

      let report;
      try {
        report = runPipeline({ rootDir: targetDir, mode: 'try' });
      } catch (err) {
        handleError(err);
        return;
      }

      for (const w of report.refresh.warnings) console.error(`warning: ${w}`);
      console.log(describeChanges(report));
      console.log('');
      printDiffs(report.results);
      console.log('Preview — would write:');
      printArtifactResults(report.results);
      console.log('\nNothing was written. To adopt: `ctxkeep init`, then `ctxkeep analyze`.');
    });
}
