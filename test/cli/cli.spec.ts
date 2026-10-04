import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/config/schema';
import { buildConfigTemplate } from '../../src/cli/commands/init';
import { ROLLBACK_NOTE } from '../../src/cli/commands/rollback';
import { commitAll, copyFixture, initGitRepo, read, runCli, writeFiles } from '../helpers';

/** The real CLI as a subprocess: exit codes, user-facing messages, and the end-to-end loop. */

describe('init', () => {
  it('writes a commented template that is valid config, plus .ctxkeep/.gitignore; refuses to overwrite', () => {
    const dir = copyFixture('react-web');
    const first = runCli(['init', dir]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Wrote .ctxkeep/config.yaml and .ctxkeep/.gitignore');
    expect(first.stdout).toContain('CLAUDE.md pointing to it (detected Claude Code)');
    expect(read(dir, '.ctxkeep/.gitignore')).toContain('graph.sqlite*');
    expect(ConfigSchema.safeParse(yaml.load(read(dir, '.ctxkeep/config.yaml'))).success).toBe(true);

    const before = read(dir, '.ctxkeep/config.yaml');
    const second = runCli(['init', dir]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already exists — refusing to overwrite');
    expect(read(dir, '.ctxkeep/config.yaml')).toBe(before);
  }, 30_000);

  it('the template parses with every combination of options', () => {
    for (const [docs, agents] of [
      [[], []],
      [['DESIGN.md'], ['claude', 'gemini']],
    ] as [string[], string[]][]) {
      expect(ConfigSchema.safeParse(yaml.load(buildConfigTemplate(docs, agents))).success).toBe(true);
    }
  });
});

describe('the demo loop: analyze → edit → sync --check → sync → rollback', () => {
  it('behaves end to end with correct exit codes', () => {
    const dir = copyFixture('simple-ts');
    initGitRepo(dir);

    // Works with no config at all, and says so.
    const analyze = runCli(['analyze', dir]);
    expect(analyze.status).toBe(0);
    expect(analyze.stdout).toContain('No .ctxkeep/config.yaml — using defaults');
    commitAll(dir, 'generated');

    expect(runCli(['sync', '--check', dir]).status).toBe(0);

    writeFiles(dir, { 'src/utils/strings.ts': 'export function upper(s: string) {\n  return s.toUpperCase();\n}\n' });
    const check = runCli(['sync', '--check', dir]);
    expect(check.status).toBe(1);
    expect(check.stdout).toMatch(/updated\s+\.ai\/manifest\.md\s+updated module:src\/utils/);

    const dry = runCli(['sync', '--dry-run', dir]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('+- `upper` function — `src/utils/strings.ts`');
    expect(read(dir, '.ai/manifest.md')).not.toContain('upper');

    const sync = runCli(['sync', dir]);
    expect(sync.status).toBe(0);
    expect(sync.stdout).toContain('Source changes: 1 added in src/utils — re-parsed 1 file.');
    expect(read(dir, '.ai/manifest.md')).toContain('`upper` function');

    const rollback = runCli(['rollback', dir]);
    expect(rollback.status).toBe(0);
    expect(rollback.stdout).toContain('restored      .ai/manifest.md  module:src/utils');
    expect(rollback.stdout).toContain(ROLLBACK_NOTE);
    expect(read(dir, '.ai/manifest.md')).not.toContain('upper');
  }, 90_000);

  it('a hand-edit conflict exits 1 with a clear message and leaves the file alone', () => {
    const dir = copyFixture('simple-ts');
    runCli(['analyze', dir]);
    const edited = read(dir, 'AGENTS.md').replace('## Layout', '## Layout (mine)');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), edited);
    writeFiles(dir, { 'src/newmod/x.ts': 'export const X = 1;\n' });

    const sync = runCli(['sync', dir]);
    expect(sync.status).toBe(1);
    expect(sync.stdout).toMatch(/CONFLICT\s+AGENTS\.md\s+layout: edited by hand/);
    expect(read(dir, 'AGENTS.md')).toBe(edited);
  }, 60_000);
});

describe('error messages', () => {
  it('reports a missing directory, an invalid config, and rollback outside git — without stack traces', () => {
    const missing = runCli(['sync', path.join(__dirname, 'does-not-exist')]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/is not a directory/);

    const dir = copyFixture('simple-python');
    writeFiles(dir, { '.ctxkeep/config.yaml': 'artifacts:\n  - path: A.md\n    sections: [typo]\n' });
    const bad = runCli(['analyze', dir]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('error: artifacts: "A.md" lists unknown section "typo"');
    expect(bad.stderr).not.toContain('    at ');

    const rb = runCli(['rollback', dir]);
    expect(rb.status).toBe(1);
    expect(rb.stderr).toContain('not a git repository');
  }, 60_000);

  it('`review conventions` with nothing to review explains the bar for proposing one', () => {
    const dir = copyFixture('simple-ts');
    const out = runCli(['review', 'conventions', dir]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('No pending conventions');
  }, 30_000);

  it('`review conventions` confirms via piped stdin, and the next sync writes it into AGENTS.md', () => {
    const dir = copyFixture('python-ai');
    const review = runCli(['review', 'conventions', dir], 'y\ny\n');
    expect(review.status).toBe(0);
    expect(review.stdout).toContain('2 confirmed, 0 rejected, 0 skipped.');
    runCli(['sync', dir]);
    expect(read(dir, 'AGENTS.md')).toContain('- Tests live in a separate `tests/` tree, not next to source files.');
  }, 60_000);
});
