import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, beforeAll } from 'vitest';

/**
 * Golden-file test suite (build spec §4 Milestone 6): 3 small fixture repos under
 * test/fixtures/, each with a snapshotted expected CLAUDE.md/AGENTS.md. Runs
 * the ACTUAL CLI as a subprocess (not the internal library functions
 * directly) — this is the one place in the suite that exercises the full
 * `init`/`analyze` pipeline the way a real user invokes it.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const TSX_CLI = require.resolve('tsx/cli');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

/**
 * Copies a fixture into a temp directory, preserving the fixture's own
 * folder name as the leaf directory — so `detectProjectName`'s directory-
 * basename fallback (used by the Python fixture, which has no package.json)
 * is deterministic across runs, not the randomized mkdtemp parent name.
 */
function copyFixtureToTemp(fixtureName: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxkeep-golden-'));
  const targetDir = path.join(tempRoot, fixtureName);
  fs.cpSync(path.join(FIXTURES_DIR, fixtureName), targetDir, { recursive: true });
  return targetDir;
}

function readGolden(fixtureName: string, filename: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, fixtureName, '__golden__', filename), 'utf8');
}

const FIXTURES = ['simple-ts', 'simple-python', 'mixed-lang'];

describe.each(FIXTURES)('golden-file: %s', (fixtureName) => {
  let targetDir: string;

  beforeAll(() => {
    targetDir = copyFixtureToTemp(fixtureName);
    runCli(['init', targetDir]);
    runCli(['analyze', targetDir]);
  });

  it('produces the expected CLAUDE.md', () => {
    const actual = fs.readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf8');
    expect(actual).toBe(readGolden(fixtureName, 'CLAUDE.md'));
  });

  it('produces the expected AGENTS.md', () => {
    const actual = fs.readFileSync(path.join(targetDir, 'AGENTS.md'), 'utf8');
    expect(actual).toBe(readGolden(fixtureName, 'AGENTS.md'));
  });
});

describe('full CLI, end-to-end: init -> analyze -> analyze again is a full no-op', () => {
  it('the second `ctxkeep analyze` reports 0 written and leaves every compiled file byte-identical', () => {
    const targetDir = copyFixtureToTemp('simple-ts');

    runCli(['init', targetDir]);
    runCli(['analyze', targetDir]);

    const claudeBefore = fs.readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf8');
    const agentsBefore = fs.readFileSync(path.join(targetDir, 'AGENTS.md'), 'utf8');
    const manifestBefore = fs.readFileSync(path.join(targetDir, '.ai', 'manifest.md'), 'utf8');

    const secondRunOutput = runCli(['analyze', targetDir]);

    expect(secondRunOutput).toMatch(/0 written, \d+ unchanged \(no-op\)/);
    expect(fs.readFileSync(path.join(targetDir, 'CLAUDE.md'), 'utf8')).toBe(claudeBefore);
    expect(fs.readFileSync(path.join(targetDir, 'AGENTS.md'), 'utf8')).toBe(agentsBefore);
    expect(fs.readFileSync(path.join(targetDir, '.ai', 'manifest.md'), 'utf8')).toBe(manifestBefore);
  });

  it('running `ctxkeep init` a second time without --force refuses and leaves config.yaml untouched', () => {
    const targetDir = copyFixtureToTemp('simple-python');
    runCli(['init', targetDir]);

    const configPath = path.join(targetDir, '.ctxkeep', 'config.yaml');
    const configBefore = fs.readFileSync(configPath, 'utf8');

    expect(() => runCli(['init', targetDir])).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(configBefore);
  });
});
