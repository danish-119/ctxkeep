import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Command } from 'commander';
import type Database from 'better-sqlite3';
import { openGraph } from '../../graph/db';
import { listPendingConventions, setConventionStatus, type ConventionRow } from '../../graph/conventions';

/** Ranked, not dumped (build spec §34) — top 10 by confidence, never the full backlog even if more exist. */
const REVIEW_LIMIT = 10;

export type ReviewOutcome = 'confirmed' | 'rejected' | 'skipped';

/** The testable core: given one answer string, applies (or doesn't) a status change. Separated from the I/O loop so it doesn't need a terminal/pipe to test. */
export function applyReviewAnswer(db: Database.Database, conv: ConventionRow, rawAnswer: string): ReviewOutcome {
  const answer = rawAnswer.trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') {
    setConventionStatus(db, conv.id, 'confirmed');
    return 'confirmed';
  }
  if (answer === 'n' || answer === 'no') {
    setConventionStatus(db, conv.id, 'rejected');
    return 'rejected';
  }
  return 'skipped'; // anything else (including literal "s") — no DB write, stays pending
}

function promptFor(conv: ConventionRow): string {
  return `[${Math.round(conv.confidence * 100)}%] ${conv.statement}\nConfirm? (y/n/s to skip) `;
}

export function registerReviewCommand(program: Command): void {
  const review = program.command('review').description('Review pending inferred facts (currently: conventions).');

  review
    .command('conventions')
    .description(
      `Confirm, reject, or skip up to the top ${REVIEW_LIMIT} pending conventions (by confidence). ` +
        'Confirmed ones appear in CLAUDE.md; rejected ones never resurface; skipped ones reappear next run.',
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
        const pending = listPendingConventions(db, REVIEW_LIMIT);
        if (pending.length === 0) {
          console.log('No pending conventions to review. Run `ctxkeep analyze` first if you haven\'t yet.');
          return;
        }

        console.log(`${pending.length} pending convention(s), top ${REVIEW_LIMIT} by confidence:\n`);

        // A rl.question()-in-a-loop stalls after the first question when stdin
        // is piped (non-TTY) rather than a real terminal — reproduced and
        // confirmed with a minimal repro outside this codebase. The
        // for-await-of async-iterator form is the documented, correct pattern
        // for consuming readline input line-by-line and works in both modes.
        const rl = readline.createInterface({ input: process.stdin });
        let index = 0;
        console.log(promptFor(pending[index]));

        for await (const line of rl) {
          const outcome = applyReviewAnswer(db, pending[index], line);
          const note = outcome === 'skipped' ? ' (stays pending, will reappear next run)' : '';
          console.log(`  -> ${outcome}${note}\n`);

          index += 1;
          if (index >= pending.length) break;
          console.log(promptFor(pending[index]));
        }
        rl.close();

        console.log('Run `ctxkeep analyze` or `ctxkeep sync` to recompile CLAUDE.md with any newly confirmed conventions.');
      } finally {
        db.close();
      }
    });
}
