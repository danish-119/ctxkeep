import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/graph/schema';
import { patchRegion } from '../../src/compiler/patchRegion';
import { rollbackArtifacts } from '../../src/compiler/rollback';

let repoDir: string;
let db: Database.Database;

async function initGitRepo(): Promise<ReturnType<typeof simpleGit>> {
  const git = simpleGit(repoDir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  return git;
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxkeep-rollback-test-'));
  db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('rollbackArtifacts — restores drifted regions to their last-committed content', () => {
  it('reverts a region that was hand-edited after the last commit', async () => {
    const filePath = path.join(repoDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'committed content' });

    const git = await initGitRepo();
    await git.add('.');
    await git.commit('initial analyze');

    // Simulate drift: a hand-edit (or an undesired sync) changes the region's
    // content without a new commit.
    fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replace('committed content', 'accidental edit'), 'utf8');

    const outcomes = await rollbackArtifacts(db, repoDir);
    expect(outcomes).toEqual([{ artifactPath: 'CLAUDE.md', regionId: 'overview', status: 'restored' }]);

    const restored = fs.readFileSync(filePath, 'utf8');
    expect(restored).toContain('committed content');
    expect(restored).not.toContain('accidental edit');
  });

  it('reports no_op (and does not touch the file) when the region already matches HEAD', async () => {
    const filePath = path.join(repoDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'stable content' });

    const git = await initGitRepo();
    await git.add('.');
    await git.commit('initial analyze');

    fs.chmodSync(filePath, 0o444); // any write attempt would throw
    let outcomes;
    try {
      outcomes = await rollbackArtifacts(db, repoDir);
    } finally {
      fs.chmodSync(filePath, 0o644);
    }

    expect(outcomes).toEqual([{ artifactPath: 'CLAUDE.md', regionId: 'overview', status: 'no_op' }]);
  });

  it('preserves human-owned content outside the markers, and other unaffected regions', async () => {
    const filePath = path.join(repoDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, '# My Project\n\nHuman intro paragraph.\n', 'utf8');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'overview v1' });
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'modules', newContent: 'modules v1' });

    const git = await initGitRepo();
    await git.add('.');
    await git.commit('initial analyze');

    // Drift only the overview region.
    const drifted = fs.readFileSync(filePath, 'utf8').replace('overview v1', 'overview DRIFTED');
    fs.writeFileSync(filePath, drifted, 'utf8');

    await rollbackArtifacts(db, repoDir);

    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).toContain('# My Project');
    expect(text).toContain('Human intro paragraph.');
    expect(text).toContain('overview v1');
    expect(text).not.toContain('overview DRIFTED');
    expect(text).toContain('modules v1'); // untouched region survives too
  });

  it('reports not_found_at_head for an artifact that was never committed', async () => {
    const filePath = path.join(repoDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'uncommitted content' });

    await initGitRepo(); // repo exists, but nothing has been committed yet

    const outcomes = await rollbackArtifacts(db, repoDir);
    expect(outcomes).toEqual([{ artifactPath: 'CLAUDE.md', regionId: 'overview', status: 'not_found_at_head' }]);
  });

  it('reports region_not_in_head for a region added after the last commit', async () => {
    const filePath = path.join(repoDir, 'CLAUDE.md');
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'overview', newContent: 'v1' });

    const git = await initGitRepo();
    await git.add('.');
    await git.commit('initial analyze');

    // A brand new region added after the commit, never yet committed.
    patchRegion({ db, filePath, artifactPath: 'CLAUDE.md', regionId: 'modules', newContent: 'brand new region' });

    const outcomes = await rollbackArtifacts(db, repoDir);
    const modulesOutcome = outcomes.find((o) => o.regionId === 'modules');
    expect(modulesOutcome?.status).toBe('region_not_in_head');

    // And the new region's content must survive rollback — nothing to revert it to.
    expect(fs.readFileSync(filePath, 'utf8')).toContain('brand new region');
  });

  it('returns an empty list when nothing has ever been analyzed (no bindings)', async () => {
    await initGitRepo();
    const outcomes = await rollbackArtifacts(db, repoDir);
    expect(outcomes).toEqual([]);
  });
});
