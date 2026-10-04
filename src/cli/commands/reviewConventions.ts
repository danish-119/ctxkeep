import readline from 'node:readline';
import type { Command } from 'commander';
import type Database from 'better-sqlite3';
import { openFreshGraph } from '../../pipeline';
import { countPendingConventions, decidedConventions, listPendingConventions, setConventionStatus, type ConventionRow } from '../../graph/conventions';
import { writeDecisions } from '../../config/decisions';
import { handleError, resolveTarget } from '../shared';

/** Ranked, not dumped — the top 10 by agreement, never the whole backlog at once. */
const REVIEW_LIMIT = 10;

export type ReviewOutcome = 'confirmed' | 'rejected' | 'skipped';

/** The testable core: applies (or doesn't) one answer. Separated from the I/O loop so it needs no terminal. */
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
  return 'skipped'; // anything else stays pending
}

export function promptFor(conv: ConventionRow): string {
  const evidence = conv.evidenceFilePaths.slice(0, 3).join(', ') + (conv.evidenceFilePaths.length > 3 ? ', …' : '');
  return (
    `${conv.statement}\n` +
    `  evidence: ${conv.matched}/${conv.sampleSize} files agree (${evidence})\n` +
    'Confirm? Confirmed conventions are written into AGENTS.md. (y/n/s to skip) '
  );
}

export function registerReviewCommand(program: Command): void {
  const review = program.command('review').description('Review inferred facts before they are written into artifacts.');

  review
    .command('conventions')
    .description(
      `Confirm, reject, or skip the top ${REVIEW_LIMIT} pending conventions. Confirmed ones are emitted while they still ` +
        'hold in the code; rejected ones never resurface; skipped ones reappear next time.',
    )
    .argument('[path]', 'path to the repo', '.')
    .action(async (targetPathArg: string) => {
      const targetDir = resolveTarget(targetPathArg);
      if (!targetDir) return;

      let db: Database.Database;
      try {
        db = openFreshGraph(targetDir);
      } catch (err) {
        handleError(err);
        return;
      }

      try {
        const pending = listPendingConventions(db, REVIEW_LIMIT);
        if (pending.length === 0) {
          console.log('No pending conventions. CtxKeep only proposes patterns followed by at least 80% of 3+ files.');
          return;
        }

        const total = countPendingConventions(db);
        console.log(`${total} pending convention(s)${total > REVIEW_LIMIT ? `, showing the top ${REVIEW_LIMIT}` : ''}:\n`);

        // rl.question() in a loop stalls after the first question when stdin is
        // piped (non-TTY); the async-iterator form works in both modes.
        const rl = readline.createInterface({ input: process.stdin });
        let index = 0;
        console.log(promptFor(pending[index]));

        const tally: Record<ReviewOutcome, number> = { confirmed: 0, rejected: 0, skipped: 0 };
        for await (const line of rl) {
          const outcome = applyReviewAnswer(db, pending[index], line);
          tally[outcome] += 1;
          // Saved after every answer, so an interrupted review keeps what was decided.
          if (outcome !== 'skipped') writeDecisions(targetDir, decidedConventions(db));
          console.log(`  -> ${outcome}${outcome === 'skipped' ? ' (will reappear next time)' : ''}\n`);
          index += 1;
          if (index >= pending.length) break;
          console.log(promptFor(pending[index]));
        }
        rl.close();

        console.log(`${tally.confirmed} confirmed, ${tally.rejected} rejected, ${tally.skipped} skipped.`);
        if (tally.confirmed + tally.rejected > 0) console.log('Decisions saved to .ctxkeep/conventions.yaml (commit it).');
        if (tally.confirmed > 0) console.log('Run `ctxkeep sync` to write confirmed conventions into your artifacts.');
      } finally {
        db.close();
      }
    });
}
