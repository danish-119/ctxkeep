import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const REPO_ROOT = path.resolve(__dirname, '..');
export const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TSX_CLI = require.resolve('tsx/cli');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

export interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Runs the real CLI as a subprocess, exactly the way a user invokes it. */
export function runCli(args: string[], input?: string): CliResult {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
}

export function tempDir(prefix = 'ctxkeep-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Copies a fixture into a temp directory, keeping the fixture's own folder
 * name as the leaf so directory-name-based project names are deterministic.
 * `__golden__` snapshots are not copied.
 */
export function copyFixture(name: string): string {
  const target = path.join(tempDir('ctxkeep-fixture-'), name);
  fs.cpSync(path.join(FIXTURES_DIR, name), target, {
    recursive: true,
    filter: (src) => path.basename(src) !== '__golden__',
  });
  return target;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

export function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Initialises a git repo (LF line endings, no autocrlf surprises) and commits everything. */
export function initGitRepo(root: string): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  commitAll(root, 'initial');
}

export function commitAll(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message, '--allow-empty');
}
