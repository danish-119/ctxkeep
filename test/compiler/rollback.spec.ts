import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planRollback, writeRollback } from '../../src/compiler/rollback';
import { formatRegion } from '../../src/compiler/markers';
import { commitAll, initGitRepo, read, tempDir, writeFiles } from '../helpers';

/** Rollback works from the files alone: no graph, so it behaves the same on a fresh clone. */

function committedRepo(files: Record<string, string>): string {
  const root = tempDir('ctxkeep-rb-');
  writeFiles(root, files);
  initGitRepo(root);
  return root;
}

describe('planRollback', () => {
  it('restores a drifted region to HEAD, leaving human text and other regions alone', () => {
    const committed = `# Mine\n\nHuman intro.\n\n${formatRegion('a', 'A at head')}\n\n${formatRegion('b', 'B')}\n`;
    const root = committedRepo({ 'AGENTS.md': committed });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), committed.replace('A at head', 'A drifted').replace('Human intro.', 'Human intro, edited.'));

    const [r] = planRollback(root, ['AGENTS.md']);
    expect(r.action).toBe('restore');
    expect(r.outcomes.filter((o) => o.status === 'updated').map((o) => o.id)).toEqual(['a']);
    writeRollback(root, [r]);
    const text = read(root, 'AGENTS.md');
    expect(text).toContain('A at head');
    expect(text).toContain('Human intro, edited.'); // rollback only touches regions
  });

  it('is a no-op when regions already match HEAD', () => {
    const root = committedRepo({ 'AGENTS.md': `${formatRegion('a', 'A')}\n` });
    expect(planRollback(root, ['AGENTS.md'])[0].action).toBe('unchanged');
  });

  it('keeps regions added since HEAD and re-inserts regions removed since HEAD', () => {
    const root = committedRepo({ 'AGENTS.md': `${formatRegion('a', 'A')}\n\n${formatRegion('b', 'B')}\n` });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), `${formatRegion('a', 'A')}\n\n${formatRegion('c', 'C new')}\n`);
    const [r] = planRollback(root, ['AGENTS.md']);
    expect(r.newSinceHead).toEqual(['c']);
    writeRollback(root, [r]);
    const text = read(root, 'AGENTS.md');
    expect(text).toContain('C new');
    expect(text).toContain(formatRegion('b', 'B'));
  });

  it('restores an artifact file deleted since HEAD, and skips one never committed', () => {
    const root = committedRepo({ 'docs/src-api.md': `${formatRegion('module:src/api', 'X')}\n` });
    fs.rmSync(path.join(root, 'docs/src-api.md'));
    writeFiles(root, { 'NEW.md': `${formatRegion('a', 'A')}\n` });
    const results = planRollback(root, ['docs/src-api.md', 'NEW.md']);
    expect(results.map((r) => r.action)).toEqual(['restore', 'skipped']);
    writeRollback(root, results);
    expect(read(root, 'docs/src-api.md')).toContain('module:src/api');
  });

  it('works from a subdirectory of a larger repository', () => {
    const outer = tempDir('ctxkeep-rb-outer-');
    writeFiles(outer, { 'pkg/AGENTS.md': `${formatRegion('a', 'A')}\n` });
    initGitRepo(outer);
    const root = path.join(outer, 'pkg');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), `${formatRegion('a', 'changed')}\n`);
    expect(planRollback(root, ['AGENTS.md'])[0].action).toBe('restore');
    commitAll(outer, 'x');
  });
});
