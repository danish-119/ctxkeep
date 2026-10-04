import type { Command } from 'commander';
import { runPipeline } from '../../pipeline';
import { findDrift, formatFinding } from '../../drift';
import { handleError, hasPendingWrites, needsAttention, printArtifactResults, resolveTarget } from '../shared';

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description(
      'Verifies the docs without writing anything: (1) generated sections are up to date with the code, and ' +
        '(2) hand-written text in AGENTS.md, CLAUDE.md, README.md, CONTRIBUTING.md and other configured docs only mentions ' +
        'commands, paths, links and code names that still exist. Exits 1 if anything is stale or wrong — use it in CI, ' +
        'or let your coding agent run it and fix what it reports.',
    )
    .argument('[path]', 'path to the repo', '.')
    .option('--json', 'machine-readable output (for coding agents and CI)')
    .action((targetPathArg: string, options: { json?: boolean }) => {
      const targetDir = resolveTarget(targetPathArg);
      if (!targetDir) return;

      let report;
      let drift;
      try {
        report = runPipeline({ rootDir: targetDir, mode: 'sync', preview: true });
        drift = findDrift(targetDir, report.config, report.artifacts, report.model);
      } catch (err) {
        handleError(err);
        return;
      }

      const stale = report.results.filter(
        (r) => r.action !== 'unchanged' || r.outcomes.some((o) => o.status === 'conflict'),
      );
      const ok = !hasPendingWrites(report.results) && !needsAttention(report.results) && drift.length === 0;
      if (!ok) process.exitCode = 1;

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ok,
              stale: stale.map((r) => ({
                path: r.path,
                action: r.action,
                regions: r.outcomes.filter((o) => o.status !== 'unchanged').map((o) => ({ id: o.id, status: o.status, note: o.note })),
                error: r.error,
              })),
              drift,
              fix: {
                stale: 'run `ctxkeep sync`',
                drift: 'edit the hand-written text at each file:line so it matches the code; never edit inside ctxkeep markers',
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      if (stale.length === 0) {
        console.log(`Generated sections: up to date (${report.results.length} artifacts).`);
      } else {
        console.log('Generated sections: out of date. Run `ctxkeep sync`.');
        printArtifactResults(report.results);
      }

      if (drift.length === 0) {
        console.log('Hand-written docs: every command, path, link and code name they mention exists.');
      } else {
        console.log(`\nHand-written docs: ${drift.length} statement(s) no longer match the code:\n`);
        for (const f of drift) console.log(`  ${formatFinding(f)}`);
        console.log(
          '\nFix the text at each location (outside the ctxkeep markers). To accept a reference on purpose, add ' +
            '`<!-- ctxkeep-ignore -->` to that line, or list it under `drift.ignore` in .ctxkeep/config.yaml.',
        );
      }
    });
}
