import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifySpan, extractRefs, parseCommands } from '../src/drift/extract';
import { findDrift } from '../src/drift';
import { runPipeline } from '../src/pipeline';
import { initGitRepo, read, runCli, tempDir, writeFiles } from './helpers';

describe('extracting references from hand-written markdown', () => {
  it('parses package-manager and make commands, tracking `cd dir &&`', () => {
    expect(parseCommands('cd web && npm run dev')).toEqual([{ tool: 'npm', script: 'dev', cwd: 'web', text: 'npm run dev' }]);
    expect(parseCommands('npm test')).toEqual([{ tool: 'npm', script: 'test', cwd: undefined, text: 'npm test' }]);
    expect(parseCommands('pnpm lint && pnpm install')).toEqual([{ tool: 'pnpm', script: 'lint', cwd: undefined, text: 'pnpm lint' }]);
    expect(parseCommands('$ make -j4 build')[0]).toMatchObject({ tool: 'make', script: 'build' });
    expect(parseCommands('npm install && yarn add react && make')).toEqual([]);
  });

  it('classifies backticked spans conservatively', () => {
    expect(classifySpan('src/auth/session.ts')).toMatchObject({ kind: 'path' });
    expect(classifySpan('src/auth/session.ts:42')).toMatchObject({ kind: 'path', text: 'src/auth/session.ts' });
    expect(classifySpan('config.yaml')).toMatchObject({ kind: 'path' });
    expect(classifySpan('PaymentService.charge()')).toMatchObject({ kind: 'symbol', text: 'PaymentService.charge' });
    expect(classifySpan('formatPrice')).toMatchObject({ kind: 'symbol' });
    for (const notChecked of ['true', 'v1.2.3', 'src/**/*.ts', 'https://x.dev/a', '/api/users', '@scope/pkg', 'KEY=value', 'e.g.', 'hello world', 'data']) {
      expect(classifySpan(notChecked), notChecked).toBeNull();
    }
  });

  it('skips generated regions, ignore markers, and non-shell code blocks', () => {
    const md = [
      '# Doc',
      'Run `npm run a`.', // line 2: checked
      '<!-- ctxkeep:start:x sha=000000000000 -->',
      'Run `npm run generated`.',
      '<!-- ctxkeep:end:x -->',
      'Run `npm run b`. <!-- ctxkeep-ignore: intentional -->',
      '<!-- ctxkeep-ignore-start -->',
      'Run `npm run c`.',
      '<!-- ctxkeep-ignore-end -->',
      '```ts',
      'const x = `npm run d`;',
      '```',
      '```bash',
      '$ npm run e',
      '```',
      'See [setup](docs/setup.md) and [site](https://example.com).',
    ].join('\n');
    const refs = extractRefs('README.md', md);
    expect(refs.map((r) => `${r.line}:${r.kind}:${r.text}`)).toEqual([
      '2:command:npm run a',
      '14:command:npm run e',
      '16:link:docs/setup.md',
    ]);
  });
});

function repoWith(files: Record<string, string>): string {
  const root = tempDir('ctxkeep-drift-');
  writeFiles(root, files);
  initGitRepo(root);
  return root;
}

function drift(root: string) {
  const report = runPipeline({ rootDir: root, mode: 'analyze', preview: true });
  return findDrift(root, report.config, report.artifacts, report.model).map((f) => ({
    where: `${f.file}:${f.line}`,
    reference: f.reference,
    message: f.message,
    suggestion: f.suggestion,
  }));
}

const PKG = JSON.stringify({ name: 'app', scripts: { test: 'vitest', dev: 'vite', 'test:e2e': 'playwright test' }, dependencies: { react: '19' } });

describe('verifying references against the repo', () => {
  it('reports scripts that do not exist, with the closest real one', () => {
    const root = repoWith({ 'package.json': PKG, 'src/a.ts': 'export const a = 1;\n', 'README.md': 'Run `npm run test:unit` or `npm run dev`.\n' });
    expect(drift(root)).toEqual([
      { where: 'README.md:1', reference: 'npm run test:unit', message: '`test:unit` is not a script in package.json', suggestion: 'test' },
    ]);
  });

  it("checks commands against the right project's package.json when docs `cd` into it", () => {
    const root = repoWith({
      'web/package.json': JSON.stringify({ scripts: { dev: 'next dev' } }),
      'web/src/a.ts': 'export const a = 1;\n',
      'README.md': 'Start with `cd web && npm run dev`, then `cd web && npm run storybook`.\n',
    });
    expect(drift(root).map((f) => f.message)).toEqual(['`storybook` is not a script in web/package.json']);
  });

  it('does not check clone instructions that cd into a folder outside the repo', () => {
    const root = repoWith({ 'src/a.ts': 'export const a = 1;\n', 'README.md': '`git clone x && cd project && npm run build`\n' });
    expect(drift(root)).toEqual([]);
  });

  it('reports missing paths and links, suggesting where a moved file now lives', () => {
    const root = repoWith({
      'src/session/auth.ts': 'export function login() {}\n',
      'docs/setup.md': '# Setup\n',
      'README.md': 'Auth is in `src/auth/auth.ts`. See [setup](docs/setup.md), [old](docs/old.md), `src/session/`.\n',
    });
    expect(drift(root)).toEqual([
      { where: 'README.md:1', reference: 'docs/old.md', message: 'link target does not exist', suggestion: undefined },
      { where: 'README.md:1', reference: 'src/auth/auth.ts', message: 'path does not exist', suggestion: 'src/session/auth.ts' },
    ]);
  });

  it('does not report gitignored paths, package subpaths, placeholders, or generated artifacts', () => {
    const root = repoWith({
      '.gitignore': '.env\ndist/\n',
      'package.json': PKG,
      'src/a.ts': 'export const a = 1;\n',
      'README.md': 'Copy `.env` and build to `dist/app.js`; import `react/jsx-runtime`; edit `path/to/file.ts`; see `ARCHITECTURE.md`.\n',
    });
    expect(drift(root)).toEqual([]);
  });

  it('reports code names that appear nowhere in the code, but not ones that do (or runtime globals)', () => {
    const root = repoWith({
      'src/pay.ts': 'export class PaymentService {\n  charge() {}\n}\n',
      'README.md': 'Call `PaymentService.charge()`, not `PaymentService.refundAll()` or `LegacyBilling`. `JSON.parse()` is fine.\n',
    });
    expect(drift(root)).toEqual([
      { where: 'README.md:1', reference: 'LegacyBilling', message: '`LegacyBilling` does not appear anywhere in the code', suggestion: undefined },
      { where: 'README.md:1', reference: 'PaymentService.refundAll', message: '`refundAll` does not appear anywhere in the code', suggestion: undefined },
    ]);
  });

  it('accepts paths written loosely, as real docs do (found on real projects)', () => {
    const root = repoWith({
      'web/package.json': JSON.stringify({ scripts: { dev: 'next dev' } }),
      'web/src/lib/stores/user.ts': 'export const u = 1;\n',
      'web/src/lib/services/delay.ts': 'export const d = 1;\n',
      'web/lib/services/wallet-service.ts': 'export const w = 1;\n',
      'README.md': [
        'Stores live in `src/lib/stores`, delays in `services/delay.ts`, wallets in `lib/services/wallet-service`.', // relative to the app, ext-less import
        'Tools: `browser_open/snapshot/click`.', // prose joined by slashes, not a path
        '```bash',
        'cd web',
        'npm run dev', // the cd on the previous line applies
        '```',
      ].join('\n'),
    });
    expect(drift(root)).toEqual([]);
  });

  it('still catches a file that moved, even with loose matching (a real finding: Next.js route group)', () => {
    const root = repoWith({ 'app/(route)/page.tsx': 'export default function P() {}\n', 'README.md': 'The home page is `app/page.tsx`.\n' });
    expect(drift(root)).toEqual([{ where: 'README.md:1', reference: 'app/page.tsx', message: 'path does not exist', suggestion: 'app/(route)/page.tsx' }]);
  });

  it('does not crash on links that point outside the repo', () => {
    const root = repoWith({ 'src/a.ts': 'export const a = 1;\n', 'README.md': 'See [shared](../src) and [here](./src/a.ts).\n' });
    expect(() => drift(root)).not.toThrow();
  });

  it('honours drift.ignore in config', () => {
    const root = repoWith({
      '.ctxkeep/config.yaml': 'drift:\n  ignore: ["legacy/old.ts"]\n',
      'src/a.ts': 'export const a = 1;\n',
      'README.md': 'Removed: `legacy/old.ts`.\n',
    });
    expect(drift(root)).toEqual([]);
  });

  it('checks CLAUDE.md and extra configured docs, but never inside generated regions', () => {
    const root = repoWith({
      'src/a.ts': 'export const a = 1;\n',
      'CLAUDE.md': '# Notes\n\nUse `src/missing.ts`.\n',
      'docs/guide.md': 'See `src/gone.ts`.\n',
      '.ctxkeep/config.yaml': 'drift:\n  files: ["docs/*.md"]\n',
    });
    expect(drift(root).map((f) => `${f.where} ${f.reference}`)).toEqual(['CLAUDE.md:3 src/missing.ts', 'docs/guide.md:1 src/gone.ts']);
  });
});

describe('ctxkeep check (CLI)', () => {
  it('passes on a fresh, accurate repo and fails, with JSON an agent can act on, once docs drift', () => {
    const root = repoWith({ 'package.json': PKG, 'src/a.ts': 'export const a = 1;\n', 'README.md': '# App\n\nRun `npm test`.\n' });
    expect(runCli(['analyze', root]).status).toBe(0);
    const clean = runCli(['check', root]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('Generated sections: up to date');
    expect(clean.stdout).toContain('every command, path, link and code name they mention exists');

    fs.writeFileSync(path.join(root, 'README.md'), '# App\n\nRun `npm run tst`.\n');
    const json = runCli(['check', '--json', root]);
    expect(json.status).toBe(1);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.stale).toEqual([]);
    expect(parsed.drift).toEqual([
      {
        file: 'README.md',
        line: 3,
        kind: 'command',
        reference: 'npm run tst',
        message: '`tst` is not a script in package.json',
        suggestion: 'test',
      },
    ]);

    const sync = runCli(['sync', root]);
    expect(sync.status).toBe(0); // drift is a reminder in sync, a failure only in check
    expect(sync.stdout).toContain('Hand-written docs: 1 statement(s) no longer match the code');
  }, 90_000);

  it('tells agents how to keep docs true, using the right invocation for the repo', () => {
    const global = repoWith({ 'src/a.ts': 'export const a = 1;\n' });
    runPipeline({ rootDir: global, mode: 'analyze' });
    expect(read(global, 'AGENTS.md')).toContain('- After changing code, run `ctxkeep sync`');

    const local = repoWith({ 'package.json': JSON.stringify({ devDependencies: { ctxkeep: '^0.2.1' } }), 'src/a.ts': 'export const a = 1;\n', '.claude/settings.json': '{}' });
    runPipeline({ rootDir: local, mode: 'analyze' });
    expect(read(local, 'AGENTS.md')).toContain('run `npx ctxkeep sync`');
    expect(read(local, '.claude/commands/update-docs.md')).toContain('Run `npx ctxkeep check --json`');
    // Claude Code reads a command's description from frontmatter at the very top of the file.
    expect(read(local, '.claude/commands/update-docs.md').startsWith('---\ndescription: Fix docs that no longer match the code')).toBe(true);
  });
});
