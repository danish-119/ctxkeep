#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { registerTryCommand } from './commands/try';
import { registerInitCommand } from './commands/init';
import { registerAnalyzeCommand } from './commands/analyze';
import { registerSyncCommand } from './commands/sync';
import { registerReviewCommand } from './commands/reviewConventions';
import { registerRollbackCommand } from './commands/rollback';
import { registerCheckCommand } from './commands/check';

function readVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command();

program
  .name('ctxkeep')
  .description('CtxKeep — keeps AGENTS.md, ARCHITECTURE.md, and your other project docs in sync with the code.')
  .version(readVersion());

registerTryCommand(program);
registerInitCommand(program);
registerAnalyzeCommand(program);
registerSyncCommand(program);
registerCheckCommand(program);
registerReviewCommand(program);
registerRollbackCommand(program);

// One line each in `ctxkeep --help`; the full description stays in `ctxkeep <command> --help`.
const SUMMARIES: Record<string, string> = {
  try: 'preview everything CtxKeep would write (writes nothing)',
  init: 'create a commented .ctxkeep/config.yaml for this repo',
  analyze: 'full scan: generate or refresh every doc',
  sync: 'update the docs for what changed since the last run',
  check: 'verify docs: stale generated sections and hand-written text that no longer matches the code',
  review: 'confirm or reject detected conventions',
  rollback: 'restore generated sections to their content at git HEAD',
};
for (const command of program.commands) {
  const summary = SUMMARIES[command.name()];
  if (summary) command.summary(summary);
}

program.addHelpText(
  'after',
  `
Getting started:
  ctxkeep try          see what would be generated (writes nothing)
  ctxkeep init         create .ctxkeep/config.yaml
  ctxkeep analyze      generate the docs
  ctxkeep sync         after changing code
  ctxkeep check        before committing / in CI: exits 1 if docs are stale or wrong

Run \`ctxkeep <command> --help\` for a command's options.
Docs: https://github.com/danish-119/ctxkeep#readme`,
);
program.showHelpAfterError('(run `ctxkeep --help` to see all commands)');

if (process.argv.length <= 2) {
  // Bare `ctxkeep` is how most people discover a CLI: show the help, successfully.
  program.outputHelp();
} else {
  program.parseAsync(process.argv);
}
