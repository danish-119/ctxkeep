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
  .description('CtxKeep — keeps CLAUDE.md and AGENTS.md in sync with a living codebase.')
  .version(readVersion());

registerTryCommand(program);
registerInitCommand(program);
registerAnalyzeCommand(program);
registerSyncCommand(program);
registerReviewCommand(program);
registerRollbackCommand(program);

program.parseAsync(process.argv);
