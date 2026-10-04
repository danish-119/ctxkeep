import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { copyFixture, FIXTURES_DIR, read, runCli } from './helpers';

/**
 * Golden-file suite: each fixture repo is run through the REAL CLI
 * (`init` then `analyze`, as a subprocess) and every generated artifact is
 * compared byte-for-byte against a checked-in snapshot. The fixtures span
 * the project types CtxKeep has to handle: plain TS, plain Python, mixed,
 * a React/Vite web app, a Flutter mobile app (Dart/Kotlin/Swift), and a
 * Python AI service.
 *
 * To regenerate after an intentional output change:
 *   UPDATE_GOLDEN=1 npx vitest run test/goldenFiles.spec.ts
 * then review the snapshot diff like any other code change.
 */

const FIXTURES = ['simple-ts', 'simple-python', 'mixed-lang', 'react-web', 'flutter-mobile', 'python-ai'];
/** Every artifact a default config can produce; pointer files appear only where the fixture shows that tool in use. */
const ARTIFACTS: [string, string][] = [
  ['AGENTS.md', 'AGENTS.md'],
  ['CLAUDE.md', 'CLAUDE.md'],
  ['GEMINI.md', 'GEMINI.md'],
  ['ARCHITECTURE.md', 'ARCHITECTURE.md'],
  ['.ai/manifest.md', 'manifest.md'],
];
const UPDATE = process.env.UPDATE_GOLDEN === '1';

describe.each(FIXTURES)('golden: %s', (fixture) => {
  let dir: string;

  beforeAll(() => {
    dir = copyFixture(fixture);
    expect(runCli(['init', dir]).status).toBe(0);
    const analyze = runCli(['analyze', dir]);
    expect(analyze.stderr).toBe('');
    expect(analyze.status).toBe(0);
  }, 60_000);

  it.each(ARTIFACTS)('%s matches its snapshot (or is correctly absent)', (artifact, goldenName) => {
    const actualPath = path.join(dir, artifact);
    const goldenPath = path.join(FIXTURES_DIR, fixture, '__golden__', goldenName);
    const actual = fs.existsSync(actualPath) ? fs.readFileSync(actualPath, 'utf8') : null;
    if (UPDATE) {
      fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
      if (actual === null) fs.rmSync(goldenPath, { force: true });
      else fs.writeFileSync(goldenPath, actual, 'utf8');
    }
    const expected = fs.existsSync(goldenPath) ? fs.readFileSync(goldenPath, 'utf8') : null;
    expect(actual).toBe(expected);
  });

  it('a second analyze is a byte-for-byte no-op', () => {
    const existing = ARTIFACTS.map(([a]) => a).filter((a) => fs.existsSync(path.join(dir, a)));
    const before = existing.map((a) => read(dir, a));
    const second = runCli(['analyze', dir]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/All \d+ artifacts are up to date/);
    expect(existing.map((a) => read(dir, a))).toEqual(before);
  }, 30_000);
});
