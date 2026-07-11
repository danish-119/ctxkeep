import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/graph/schema';
import { planSync } from '../../src/analysis/syncPlan';
import { getCheckpoint } from '../../src/graph/checkpoints';
import { compileAndWriteRegions } from '../../src/compiler/compileRegions';

let repoDir: string;
let db: Database.Database;

async function initTestRepo(): Promise<void> {
  fs.mkdirSync(path.join(repoDir, 'src', 'moduleA'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'src', 'moduleB'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'moduleA', 'a.ts'), 'export function fooA() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'moduleB', 'b.ts'), 'export function fooB() {\n  return 2;\n}\n');

  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.add('.');
  await git.commit('initial commit');
}

beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxkeep-sync-test-'));
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  await initTestRepo();
});

afterEach(() => {
  db.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('planSync — no prior checkpoint means everything is stale (no special-casing)', () => {
  it('marks every module stale on the very first sync', async () => {
    const plan = await planSync(repoDir, db);

    expect(plan.outcomes.map((o) => o.moduleName).sort()).toEqual(['moduleA', 'moduleB']);
    expect(plan.outcomes.every((o) => o.stale)).toBe(true);
  });

  it('records a checkpoint at HEAD for every module after the first sync', async () => {
    const plan = await planSync(repoDir, db);

    const cpA = getCheckpoint(db, 'moduleA');
    const cpB = getCheckpoint(db, 'moduleB');
    expect(cpA?.sha).toBe(plan.headSha);
    expect(cpB?.sha).toBe(plan.headSha);
  });

  it('the reconstructed snapshot includes real symbols from the fresh parse', async () => {
    const plan = await planSync(repoDir, db);
    const fileA = plan.snapshot.parsedFiles.find((f) => f.relPath === 'src/moduleA/a.ts');
    expect(fileA?.symbols.map((s) => s.name)).toEqual(['fooA']);
  });
});

describe('planSync — changing one module only marks only that module stale', () => {
  it('leaves the untouched module\'s checkpoint at its original SHA', async () => {
    const firstPlan = await planSync(repoDir, db);
    const originalHeadSha = firstPlan.headSha;

    // Change only moduleA, commit.
    fs.writeFileSync(
      path.join(repoDir, 'src', 'moduleA', 'a.ts'),
      'export function fooA() {\n  return 999; // changed\n}\n',
    );
    const git = simpleGit(repoDir);
    await git.add('.');
    await git.commit('change moduleA only');

    const secondPlan = await planSync(repoDir, db);
    expect(secondPlan.headSha).not.toBe(originalHeadSha);

    const outcomeA = secondPlan.outcomes.find((o) => o.moduleName === 'moduleA');
    const outcomeB = secondPlan.outcomes.find((o) => o.moduleName === 'moduleB');
    expect(outcomeA?.stale).toBe(true);
    expect(outcomeB?.stale).toBe(false);

    const cpA = getCheckpoint(db, 'moduleA');
    const cpB = getCheckpoint(db, 'moduleB');
    expect(cpA?.sha).toBe(secondPlan.headSha);
    expect(cpB?.sha).toBe(originalHeadSha); // untouched — still the OLD sha, per spec's "update only resynced modules"
  });
});

describe('planSync — a second sync with no new commits is a full no-op', () => {
  it('marks every module non-stale and writes no new checkpoint rows', async () => {
    await planSync(repoDir, db); // first sync: establishes checkpoints
    const countBefore = (db.prepare('SELECT COUNT(*) as n FROM checkpoints').get() as { n: number }).n;

    const secondPlan = await planSync(repoDir, db); // no commits in between
    const countAfter = (db.prepare('SELECT COUNT(*) as n FROM checkpoints').get() as { n: number }).n;

    expect(secondPlan.outcomes.every((o) => !o.stale)).toBe(true);
    expect(countAfter).toBe(countBefore);
  });

  it('the snapshot after a no-op sync still reflects the correct symbols (read back from the graph, not re-parsed)', async () => {
    await planSync(repoDir, db);
    const secondPlan = await planSync(repoDir, db);

    const fileA = secondPlan.snapshot.parsedFiles.find((f) => f.relPath === 'src/moduleA/a.ts');
    const fileB = secondPlan.snapshot.parsedFiles.find((f) => f.relPath === 'src/moduleB/b.ts');
    expect(fileA?.symbols.map((s) => s.name)).toEqual(['fooA']);
    expect(fileB?.symbols.map((s) => s.name)).toEqual(['fooB']);
  });
});

describe('planSync — resyncing the SAME module twice diffs against the SECOND checkpoint, not the first', () => {
  it('detects staleness on a third sync even when the file reverts to its original (first-checkpoint) content', async () => {
    // This is the scenario an unordered/first-match checkpoint lookup would
    // get wrong: if the code picked the OLDEST row instead of the most
    // recent one, diffing commit1..commit3 would show ZERO byte difference
    // (content is back to exactly what it was at commit1) and moduleA would
    // be wrongly reported as NOT stale — even though a real, un-verified
    // change happened in between (commit1 -> commit2 -> commit3).
    const git = simpleGit(repoDir);

    const firstPlan = await planSync(repoDir, db); // checkpoint A/B @ commit1
    const commit1Sha = firstPlan.headSha;

    fs.writeFileSync(path.join(repoDir, 'src', 'moduleA', 'a.ts'), 'export function fooA() {\n  return 2;\n}\n');
    await git.add('.');
    await git.commit('moduleA v2');
    const secondPlan = await planSync(repoDir, db); // checkpoint A @ commit2 (2nd row), B untouched
    const commit2Sha = secondPlan.headSha;
    expect(commit2Sha).not.toBe(commit1Sha);
    expect(getCheckpoint(db, 'moduleA')?.sha).toBe(commit2Sha);

    // Revert moduleA's file back to byte-identical original content.
    fs.writeFileSync(path.join(repoDir, 'src', 'moduleA', 'a.ts'), 'export function fooA() {\n  return 1;\n}\n');
    await git.add('.');
    await git.commit('moduleA v3 (revert to v1 content)');

    const thirdPlan = await planSync(repoDir, db);
    const outcomeA = thirdPlan.outcomes.find((o) => o.moduleName === 'moduleA');

    expect(outcomeA?.stale).toBe(true); // fails if the lookup picked commit1 instead of commit2
    expect(getCheckpoint(db, 'moduleA')?.sha).toBe(thirdPlan.headSha);

    const checkpointCount = (
      db.prepare("SELECT COUNT(*) as n FROM checkpoints WHERE module_id = 'moduleA'").get() as { n: number }
    ).n;
    expect(checkpointCount).toBe(3); // one row per sync that actually resynced moduleA
  });
});

describe('end-to-end: sync + region compilation only touches the changed module\'s region', () => {
  it('after changing one module, only its module:<name> region is WRITTEN — every other region is NO_OP', async () => {
    const firstPlan = await planSync(repoDir, db);
    compileAndWriteRegions(db, repoDir, firstPlan.snapshot);

    // Add a new exported symbol — a body-only edit wouldn't change the
    // rendered region text at all (it only lists name/kind/file), which
    // would make this test pass for the wrong reason.
    fs.writeFileSync(
      path.join(repoDir, 'src', 'moduleA', 'a.ts'),
      'export function fooA() {\n  return 1;\n}\n\nexport function barA() {\n  return 2;\n}\n',
    );
    const git = simpleGit(repoDir);
    await git.add('.');
    await git.commit('add a new symbol to moduleA only');

    const secondPlan = await planSync(repoDir, db);

    // Capture every region's content hash right before the second compile.
    const before = db
      .prepare('SELECT artifact_path as artifactPath, region_id as regionId, content_hash as contentHash FROM artifact_bindings')
      .all() as { artifactPath: string; regionId: string; contentHash: string }[];

    compileAndWriteRegions(db, repoDir, secondPlan.snapshot);

    const after = db
      .prepare('SELECT artifact_path as artifactPath, region_id as regionId, content_hash as contentHash FROM artifact_bindings')
      .all() as { artifactPath: string; regionId: string; contentHash: string }[];

    const changedRegions = after.filter((row) => {
      const match = before.find((b) => b.artifactPath === row.artifactPath && b.regionId === row.regionId);
      return !match || match.contentHash !== row.contentHash;
    });

    // Two regions legitimately change, not one: CLAUDE.md's module:moduleA
    // (its symbol list grew) AND .ai/manifest.md's shared "modules" region
    // (its one table has a row per module, and moduleA's Symbols column went
    // 1 -> 2). That table lives in a single region covering every module, so
    // it updates whenever ANY module's counts change - that's a correct,
    // proportionate diff, not a violation of "other modules' regions stay
    // untouched." The property under test is that module:moduleB (a
    // genuinely different module's region) and the file-count-driven
    // overview/modules-list regions (unaffected, since file count didn't
    // change) stay NO_OP.
    const changedKeys = changedRegions.map((r) => `${r.artifactPath}#${r.regionId}`).sort();
    expect(changedKeys).toEqual(['.ai/manifest.md#modules', 'CLAUDE.md#module:moduleA']);
  });
});
