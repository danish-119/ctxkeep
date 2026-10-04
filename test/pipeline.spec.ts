import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipeline, type PipelineReport } from '../src/pipeline';
import { graphPath } from '../src/graph/db';
import { commitAll, initGitRepo, read, tempDir, writeFiles } from './helpers';

/**
 * In-process integration tests for the analyze/sync pipeline: change
 * detection, the artifact system, and the safety guarantees, on real
 * temp-dir repos.
 */

function repo(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const root = tempDir('ctxkeep-pipe-');
  writeFiles(root, files);
  if (opts.git !== false) initGitRepo(root);
  return root;
}

const BASE = {
  'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }),
  'src/api/routes.ts': "import { add } from '../util/math';\nexport function route() {\n  return add(1, 2);\n}\n",
  'src/util/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
};

const analyze = (root: string, extra: object = {}) => runPipeline({ rootDir: root, mode: 'analyze', ...extra });
const sync = (root: string, extra: object = {}) => runPipeline({ rootDir: root, mode: 'sync', ...extra });

function changed(report: PipelineReport): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of report.results) {
    const ids = r.outcomes.filter((o) => o.status !== 'unchanged').map((o) => `${o.status}:${o.id}`);
    if (r.action !== 'unchanged' || ids.length) out[r.path] = r.action === 'create' || r.action === 'delete' ? [r.action] : ids;
  }
  return out;
}

function snapshot(root: string): Record<string, string> {
  const files = ['AGENTS.md', 'ARCHITECTURE.md', '.ai/manifest.md', 'CLAUDE.md'];
  return Object.fromEntries(files.filter((f) => fs.existsSync(path.join(root, f))).map((f) => [f, read(root, f)]));
}

describe('change detection', () => {
  it('a sync right after analyze changes nothing and writes nothing (no first-sync full rescan)', () => {
    const root = repo(BASE);
    analyze(root);
    const before = snapshot(root);
    const mtimes = Object.keys(before).map((f) => fs.statSync(path.join(root, f)).mtimeMs);

    const report = sync(root);
    expect(report.refresh.full).toBe(false);
    expect(report.refresh.parsedCount).toBe(0);
    expect(changed(report)).toEqual({});
    expect(snapshot(root)).toEqual(before);
    expect(Object.keys(before).map((f) => fs.statSync(path.join(root, f)).mtimeMs)).toEqual(mtimes);
  });

  it('picks up UNCOMMITTED edits and re-parses only the changed file', () => {
    const root = repo(BASE);
    analyze(root);
    fs.appendFileSync(path.join(root, 'src/util/math.ts'), 'export function sub(a: number, b: number) {\n  return a - b;\n}\n');

    const report = sync(root);
    expect(report.refresh.changes.modified).toEqual(['src/util/math.ts']);
    expect(report.refresh.parsedCount).toBe(1);
    expect(changed(report)).toEqual({ '.ai/manifest.md': ['updated:module:src/util'] });
    expect(read(root, '.ai/manifest.md')).toContain('`sub` function');
  });

  it('a body-only edit re-parses the file but rewrites no artifact (nothing it states changed)', () => {
    const root = repo(BASE);
    analyze(root);
    fs.writeFileSync(path.join(root, 'src/util/math.ts'), 'export function add(a: number, b: number) {\n  return b + a; // swapped\n}\n');
    const report = sync(root);
    expect(report.refresh.changes.modified).toEqual(['src/util/math.ts']);
    expect(changed(report)).toEqual({});
  });

  it('handles a deleted file: its symbols disappear (v0.1 kept them forever)', () => {
    const root = repo({ ...BASE, 'src/util/extra.ts': 'export function extra() {}\n' });
    analyze(root);
    expect(read(root, '.ai/manifest.md')).toContain('`extra`');
    fs.rmSync(path.join(root, 'src/util/extra.ts'));

    const report = sync(root);
    expect(report.refresh.changes.deleted).toEqual(['src/util/extra.ts']);
    expect(read(root, '.ai/manifest.md')).not.toContain('`extra`');
  });

  it('handles a rename as delete + add, with both sides reflected', () => {
    const root = repo(BASE);
    analyze(root);
    fs.renameSync(path.join(root, 'src/util/math.ts'), path.join(root, 'src/util/arith.ts'));
    fs.writeFileSync(path.join(root, 'src/api/routes.ts'), "import { add } from '../util/arith';\nexport function route() {\n  return add(1, 2);\n}\n");

    const report = sync(root);
    expect(report.refresh.changes).toMatchObject({ added: ['src/util/arith.ts'], deleted: ['src/util/math.ts'] });
    const manifest = read(root, '.ai/manifest.md');
    expect(manifest).toContain('src/util/arith.ts');
    expect(manifest).not.toContain('src/util/math.ts');
  });

  it('survives history rewrites — no stored SHA to go missing', () => {
    const root = repo(BASE);
    analyze(root);
    commitAll(root, 'artifacts');
    fs.appendFileSync(path.join(root, 'src/util/math.ts'), 'export const PI = 3;\n');
    commitAll(root, 'pi');
    // Rewrite history: squash the last commit away and recommit differently.
    require('node:child_process').execFileSync('git', ['reset', '--soft', 'HEAD~1'], { cwd: root });
    commitAll(root, 'pi (amended)');
    const report = sync(root);
    expect(report.refresh.changes.modified).toEqual(['src/util/math.ts']);
    expect(read(root, '.ai/manifest.md')).toContain('`PI`');
  });

  it('works in a directory that is not a git repository', () => {
    const root = repo(BASE, { git: false });
    analyze(root);
    fs.appendFileSync(path.join(root, 'src/util/math.ts'), 'export const E = 2;\n');
    expect(sync(root).refresh.changes.modified).toEqual(['src/util/math.ts']);
  });

  it('a newly added file that satisfies an existing import updates the dependency graph without re-parsing the importer', () => {
    const root = repo({ ...BASE, 'src/api/routes.ts': "import { fmt } from '../fmt/format';\nexport function route() {\n  return fmt();\n}\n" });
    analyze(root);
    expect(read(root, 'ARCHITECTURE.md')).toContain('No imports between modules');
    writeFiles(root, { 'src/fmt/format.ts': 'export function fmt() {}\n' });

    const report = sync(root);
    expect(report.refresh.parsedCount).toBe(1); // only the new file
    expect(read(root, 'ARCHITECTURE.md')).toContain('`src/fmt/` (1)');
  });

  it('honours config `ignore:` patterns', () => {
    const root = repo({ ...BASE, 'src/generated/api.ts': 'export const X = 1;\n', '.ctxkeep/config.yaml': 'ignore: ["src/generated/"]\n' });
    analyze(root);
    expect(read(root, 'AGENTS.md')).not.toContain('src/generated');
  });
});

describe('module lifecycle in artifacts', () => {
  it('adds a new module region next to its siblings and removes a deleted module region', () => {
    const root = repo(BASE);
    analyze(root);
    writeFiles(root, { 'src/auth/session.ts': 'export class Session {}\n' });
    fs.rmSync(path.join(root, 'src/api'), { recursive: true });

    const report = sync(root);
    // src/util is updated too: its "Used by" lost src/api. That's a real change to what the region states.
    expect(changed(report)['.ai/manifest.md']).toEqual(['removed:module:src/api', 'added:module:src/auth', 'updated:module:src/util']);
    const manifest = read(root, '.ai/manifest.md');
    expect(manifest.indexOf('module:src/auth')).toBeLessThan(manifest.indexOf('module:src/util'));
    expect(manifest).not.toContain('module:src/api');
  });

  it('AGENTS.md only changes on structural change, not when a file is added to an existing module', () => {
    const root = repo(BASE);
    analyze(root);
    const agents = read(root, 'AGENTS.md');
    writeFiles(root, { 'src/util/strings.ts': 'export function upper(s: string) {\n  return s;\n}\n' });
    sync(root);
    expect(read(root, 'AGENTS.md')).toBe(agents);
  });
});

describe('safety', () => {
  it('never touches human content, and never overwrites a hand-edited region', () => {
    const root = repo(BASE);
    analyze(root);
    const human = '\n## Team rules\n\nNever commit secrets.\n';
    fs.appendFileSync(path.join(root, 'AGENTS.md'), human);
    const edited = read(root, 'AGENTS.md').replace('## Commands', '## Commands (edited)');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), edited);
    writeFiles(root, { 'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', lint: 'eslint .' } }) });

    const report = sync(root);
    const agents = report.results.find((r) => r.path === 'AGENTS.md')!;
    expect(agents.outcomes.find((o) => o.id === 'commands')?.status).toBe('conflict');
    expect(read(root, 'AGENTS.md')).toBe(edited);

    sync(root, { force: true });
    const forced = read(root, 'AGENTS.md');
    expect(forced).toContain('npm run lint');
    expect(forced).not.toContain('(edited)');
    expect(forced).toContain(human.trim());
  });

  it('reports malformed markers as an artifact error, writing nothing to that file', () => {
    const root = repo(BASE);
    analyze(root);
    const broken = read(root, 'ARCHITECTURE.md').replace('<!-- ctxkeep:end:key-files -->', '');
    fs.writeFileSync(path.join(root, 'ARCHITECTURE.md'), broken);
    const report = sync(root);
    const arch = report.results.find((r) => r.path === 'ARCHITECTURE.md')!;
    expect(arch.action).toBe('error');
    expect(arch.error).toMatch(/region "key-files" has no end marker/);
    expect(read(root, 'ARCHITECTURE.md')).toBe(broken);
  });

  it('preview (--dry-run / --check) writes neither artifacts nor the graph', () => {
    const root = repo(BASE);
    const report = runPipeline({ rootDir: root, mode: 'analyze', preview: true });
    expect(report.results.every((r) => r.action === 'create')).toBe(true);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(graphPath(root))).toBe(false);

    analyze(root);
    fs.appendFileSync(path.join(root, 'src/util/math.ts'), 'export const Z = 0;\n');
    const graphBefore = fs.readFileSync(graphPath(root));
    const preview = runPipeline({ rootDir: root, mode: 'sync', preview: true });
    expect(changed(preview)).toEqual({ '.ai/manifest.md': ['updated:module:src/util'] });
    expect(read(root, '.ai/manifest.md')).not.toContain('`Z`');
    // The real sync still sees the change: preview didn't consume it.
    expect(sync(root).refresh.changes.modified).toEqual(['src/util/math.ts']);
    expect(graphBefore.length).toBeGreaterThan(0);
  });

  it('`try` mode needs no config and creates no .ctxkeep directory', () => {
    const root = repo(BASE);
    runPipeline({ rootDir: root, mode: 'try' });
    expect(fs.existsSync(path.join(root, '.ctxkeep'))).toBe(false);
  });
});

describe('artifact system', () => {
  it('maintains extra configured docs: DESIGN.md with key-abstractions, per-module docs, nested AGENTS.md', () => {
    const root = repo({
      ...BASE,
      'src/util/types.ts': 'export interface Money {\n  cents: number;\n}\n',
      'src/api/handler.ts': "import type { Money } from '../util/types';\nexport function pay(m: Money) {\n  return m;\n}\n",
      '.ctxkeep/config.yaml': [
        'artifacts:',
        '  - path: AGENTS.md',
        '    sections: [overview, commands, layout]',
        '  - path: DESIGN.md',
        '    title: Design',
        '    sections: [key-abstractions]',
        '  - path: docs/modules/{module}.md',
        '    modules: ["src/*"]',
        '    sections: [module-summary, module-api]',
        '  - path: "{module_dir}/AGENTS.md"',
        '    modules: ["src/*"]',
        '    sections: [module-summary]',
        '',
      ].join('\n'),
    });
    const report = analyze(root);
    expect(report.results.map((r) => r.path).sort()).toEqual([
      'AGENTS.md',
      'DESIGN.md',
      'docs/modules/src-api.md',
      'docs/modules/src-util.md',
      'src/api/AGENTS.md',
      'src/util/AGENTS.md',
    ]);
    expect(read(root, 'DESIGN.md')).toMatch(/^# Design\n/);
    expect(read(root, 'DESIGN.md')).toContain('| `Money` | interface | `src/util/types.ts` | 1 file |');
    expect(read(root, 'docs/modules/src-api.md')).toContain('`pay` function');
    expect(read(root, 'src/util/AGENTS.md')).toContain('- Used by: `src/api/` (2)');
  });

  it('deletes a per-module doc when its module disappears, but keeps it if a human wrote in it', () => {
    const config = 'artifacts:\n  - path: docs/{module}.md\n    sections: [module]\n';
    const root = repo({ ...BASE, 'src/old/a.ts': 'export const A = 1;\n', 'src/kept/b.ts': 'export const B = 1;\n', '.ctxkeep/config.yaml': config });
    analyze(root);
    fs.appendFileSync(path.join(root, 'docs/src-kept.md'), '\nHuman notes about kept.\n');
    fs.rmSync(path.join(root, 'src/old'), { recursive: true });
    fs.rmSync(path.join(root, 'src/kept'), { recursive: true });

    const report = sync(root);
    expect(report.results.find((r) => r.path === 'docs/src-old.md')?.action).toBe('delete');
    expect(fs.existsSync(path.join(root, 'docs/src-old.md'))).toBe(false);
    expect(read(root, 'docs/src-kept.md').trim()).toMatch(/Human notes about kept\.$/);
    expect(read(root, 'docs/src-kept.md')).not.toContain('<!-- ctxkeep:start:');
  });

  it('fill mode: an artifact without `sections` only fills markers the author placed, where they placed them', () => {
    const design = '# Design\n\nOur domain model:\n\n<!-- ctxkeep:start:key-abstractions -->\n<!-- ctxkeep:end:key-abstractions -->\n\nHand-written rationale.\n';
    const root = repo({ ...BASE, 'src/util/types.ts': 'export type Id = string;\n', 'DESIGN.md': design, '.ctxkeep/config.yaml': 'artifacts:\n  - path: DESIGN.md\n' });
    analyze(root);
    const text = read(root, 'DESIGN.md');
    expect(text.startsWith('# Design\n\nOur domain model:\n\n<!-- ctxkeep:start:key-abstractions sha=')).toBe(true);
    expect(text).toContain('`Id`');
    expect(text.endsWith('\n\nHand-written rationale.\n')).toBe(true);
  });

  it('rejects unknown sections and misplaced tokens with actionable errors', () => {
    const root = repo({ ...BASE, '.ctxkeep/config.yaml': 'artifacts:\n  - path: X.md\n    sections: [nope]\n' });
    expect(() => analyze(root)).toThrow(/unknown section "nope". Available sections: overview, commands/);
    writeFiles(root, { '.ctxkeep/config.yaml': 'artifacts:\n  - path: docs/{module_dir}.md\n    sections: [module]\n' });
    expect(() => analyze(root)).toThrow(/must start the path/);
    writeFiles(root, { '.ctxkeep/config.yaml': 'artifact:\n  - path: X.md\n' });
    expect(() => analyze(root)).toThrow(/Unrecognized key/);
  });
});

describe('agent pointer files (tool-agnostic)', () => {
  it('emits no pointer files when the repo shows no tool that needs one', () => {
    const root = repo(BASE);
    expect(analyze(root).results.map((r) => r.path)).toEqual(['AGENTS.md', 'ARCHITECTURE.md', '.ai/manifest.md']);
  });

  it('adds CLAUDE.md / GEMINI.md when the repo uses those tools, each with its own import syntax', () => {
    const root = repo({ ...BASE, '.claude/settings.json': '{}', 'GEMINI.md': '# Gemini notes\n' });
    analyze(root);
    expect(read(root, 'CLAUDE.md')).toContain('\n@AGENTS.md\n');
    expect(read(root, 'GEMINI.md')).toMatch(/^# Gemini notes\n\n<!-- ctxkeep:start:agents-import sha=\w+ -->\n@\.\/AGENTS\.md\n/);
  });

  it('respects an explicit `agents:` list, including an empty one', () => {
    const root = repo({ ...BASE, 'CLAUDE.md': '# mine\n', '.ctxkeep/config.yaml': 'agents: []\n' });
    expect(analyze(root).results.map((r) => r.path)).not.toContain('CLAUDE.md');
    writeFiles(root, { '.ctxkeep/config.yaml': 'agents: [gemini]\n' });
    expect(analyze(root).results.map((r) => r.path)).toContain('GEMINI.md');
  });

  it('upgrades a v0.1 CLAUDE.md: retires the duplicated regions, keeps human text, imports AGENTS.md', () => {
    const v01 = [
      '# Human header',
      '<!-- ctxkeep:start:overview -->',
      '# demo',
      '<!-- ctxkeep:end -->',
      '<!-- ctxkeep:start:modules -->',
      '## Modules',
      '<!-- ctxkeep:end -->',
      '<!-- ctxkeep:start:module:api -->',
      '### api/',
      '<!-- ctxkeep:end -->',
      '',
    ].join('\n');
    const root = repo({ ...BASE, 'CLAUDE.md': v01, '.ctxkeep/config.yaml': 'adapters:\n  claude:\n    enabled: true\nmodules: []\nignore: []\n' });
    analyze(root);
    const claude = read(root, 'CLAUDE.md');
    expect(claude.startsWith('# Human header\n')).toBe(true);
    expect(claude).toContain('@AGENTS.md');
    expect(claude).not.toMatch(/ctxkeep:start:(overview|modules|module:api)/);
  });
});

describe('repos holding several apps', () => {
  it('finds nested projects: their stack and commands (with the cd they need) and per-app modules', () => {
    const root = repo({
      'README.md': '# Monorepo\n',
      'web/package.json': JSON.stringify({ name: 'web', scripts: { dev: 'next dev' }, dependencies: { next: '15', react: '19' } }),
      'web/src/app/page.tsx': 'export default function Page() {\n  return null;\n}\n',
      'web/src/lib/api.ts': 'export function get() {}\n',
      'mobile/pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n',
      'mobile/lib/features/auth/login.dart': 'class LoginScreen {}\n',
      'test/fixtures/demo/package.json': '{"name":"fixture"}',
      'test/fixtures/demo/a.ts': 'export const a = 1;\n',
    });
    analyze(root);
    const agents = read(root, 'AGENTS.md');
    expect(agents).toContain('Next.js, React (`web/package.json`)');
    expect(agents).toContain('Flutter (`mobile/pubspec.yaml`)');
    expect(agents).toContain('- `cd web && npm run dev` — runs `next dev`');
    expect(agents).toContain('- `cd mobile && flutter test`');
    expect(agents).toContain('| `web/src/app/` |');
    expect(agents).toContain('| `mobile/lib/features/auth/` |');
    expect(agents).not.toContain('fixture'); // fixtures with manifests are not projects
  });

  it('strips markdown links from module descriptions (they would break once copied)', () => {
    const root = repo({ ...BASE, 'src/api/README.md': '# API\n\nRoutes for [the app](../../README.md), see ![logo](x.png) docs.\n' });
    analyze(root);
    expect(read(root, 'AGENTS.md')).toContain('| Routes for the app, see docs. |');
  });
});

describe('determinism', () => {
  it('two fresh analyses of the same tree produce byte-identical artifacts', () => {
    const a = repo(BASE);
    const b = repo(BASE);
    analyze(a);
    analyze(b);
    expect(snapshot(a)).toEqual(snapshot(b));
  });
});
