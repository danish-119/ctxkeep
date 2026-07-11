import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import simpleGit from 'simple-git';
import { describe, expect, it } from 'vitest';

/**
 * Full-CLI (subprocess) test for `ctxkeep rollback`'s own console output —
 * not the compiler logic (already covered by test/compiler/rollback.spec.ts),
 * but the specific stdout message warning the user that a subsequent
 * analyze/sync can reintroduce whatever rollback just reverted, since
 * rollback doesn't touch graph state (see DECISIONS.md).
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = require.resolve('tsx/cli');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const EXPECTED_NOTE =
  'Note: this reverts the FILE to match HEAD. A subsequent `ctxkeep analyze`/`sync` recomputes fresh ' +
  "from the graph and may reintroduce the same content again if the underlying code hasn't changed.";

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

describe('ctxkeep rollback — CLI output', () => {
  it('prints the reintroduction-warning note after a successful rollback', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxkeep-rollback-cli-'));
    const targetDir = path.join(tempRoot, 'repo');
    fs.mkdirSync(path.join(targetDir, 'src', 'mod'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'src', 'mod', 'a.ts'), 'export function foo() {\n  return 1;\n}\n');

    const git = simpleGit(targetDir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    await git.add('.');
    await git.commit('initial');

    try {
      runCli(['init', targetDir]);
      runCli(['analyze', targetDir]);

      await git.add('.');
      await git.commit('commit generated artifacts');

      // Hand-edit a CtxKeep-owned region so rollback has something real to restore.
      const claudePath = path.join(targetDir, 'CLAUDE.md');
      const original = fs.readFileSync(claudePath, 'utf8');
      fs.writeFileSync(claudePath, original.replace('<!-- ctxkeep:end -->', 'DRIFTED\n<!-- ctxkeep:end -->'), 'utf8');

      const output = runCli(['rollback', targetDir]);

      expect(output).toContain('restored to HEAD');
      expect(output).toContain(EXPECTED_NOTE);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30000); // three real subprocess CLI invocations + git ops comfortably exceed vitest's 5s default
});
