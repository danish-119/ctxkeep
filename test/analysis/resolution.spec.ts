import { describe, expect, it } from 'vitest';
import { readPathAliases, resolveImport, type ResolveContext } from '../../src/analysis/imports';
import { createModuleResolver, findDominantFolders, isTestPath, moduleIdForPath, moduleMatches, moduleSlug } from '../../src/analysis/modules';
import { tempDir, writeFiles } from '../helpers';

const NO_CTX: ResolveContext = { aliases: [], dartPackage: null };

describe('resolveImport — TS/JS', () => {
  const files = new Set(['src/a.ts', 'src/util/index.ts', 'src/b.tsx', 'src/c.js', 'src/lib/x.ts']);

  it('resolves relative paths with implied extensions and index files', () => {
    expect(resolveImport('src/a.ts', 'typescript', { specifier: './b', names: [] }, files, NO_CTX)).toEqual(['src/b.tsx']);
    expect(resolveImport('src/a.ts', 'typescript', { specifier: './util', names: [] }, files, NO_CTX)).toEqual(['src/util/index.ts']);
    expect(resolveImport('src/util/index.ts', 'typescript', { specifier: '../c.js', names: [] }, files, NO_CTX)).toEqual(['src/c.js']);
  });

  it('maps TypeScript ESM `.js` specifiers to the `.ts` source', () => {
    expect(resolveImport('src/b.tsx', 'typescript', { specifier: './a.js', names: [] }, files, NO_CTX)).toEqual(['src/a.ts']);
  });

  it('treats bare package imports as external', () => {
    expect(resolveImport('src/a.ts', 'typescript', { specifier: 'react', names: [] }, files, NO_CTX)).toEqual([]);
  });

  it('resolves tsconfig path aliases (with comments and trailing commas in tsconfig.json)', () => {
    const root = tempDir();
    writeFiles(root, {
      'tsconfig.json': '{\n  // comment\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, },\n}\n',
    });
    const ctx = { aliases: readPathAliases(root), dartPackage: null };
    expect(ctx.aliases).toEqual([{ prefix: '@/', target: 'src/' }]);
    expect(resolveImport('src/a.ts', 'typescript', { specifier: '@/lib/x', names: [] }, files, ctx)).toEqual(['src/lib/x.ts']);
  });
});

describe('resolveImport — Python', () => {
  const files = new Set(['app/__init__.py', 'app/models.py', 'app/api/views.py', 'src/pkg/core.py', 'src/pkg/sub/__init__.py']);

  it('resolves relative imports, including parent-package dots', () => {
    expect(resolveImport('app/api/views.py', 'python', { specifier: '..models', names: ['User'] }, files, NO_CTX)).toEqual(['app/models.py']);
  });

  it('resolves `from . import module` to the submodule file', () => {
    expect(resolveImport('app/api/views.py', 'python', { specifier: '..', names: ['models'] }, files, NO_CTX)).toEqual(['app/models.py']);
  });

  it('resolves absolute imports from the repo root and from a src/ layout', () => {
    expect(resolveImport('x.py', 'python', { specifier: 'app.models', names: [] }, files, NO_CTX)).toEqual(['app/models.py']);
    expect(resolveImport('x.py', 'python', { specifier: 'pkg.core', names: [] }, files, NO_CTX)).toEqual(['src/pkg/core.py']);
    expect(resolveImport('x.py', 'python', { specifier: 'pkg', names: ['sub'] }, files, NO_CTX)).toEqual(['src/pkg/sub/__init__.py']);
  });

  it('treats stdlib / third-party imports as external', () => {
    expect(resolveImport('x.py', 'python', { specifier: 'os.path', names: [] }, files, NO_CTX)).toEqual([]);
  });
});

describe('resolveImport — Dart', () => {
  const files = new Set(['lib/main.dart', 'lib/screens/home.dart', 'lib/widgets/button.dart']);
  const ctx = { aliases: [], dartPackage: 'shop' };

  it('resolves relative and own-package imports; ignores dart: and other packages', () => {
    expect(resolveImport('lib/main.dart', 'dart', { specifier: 'screens/home.dart', names: [] }, files, ctx)).toEqual(['lib/screens/home.dart']);
    expect(resolveImport('lib/screens/home.dart', 'dart', { specifier: 'package:shop/widgets/button.dart', names: [] }, files, ctx)).toEqual([
      'lib/widgets/button.dart',
    ]);
    expect(resolveImport('lib/main.dart', 'dart', { specifier: 'package:flutter/material.dart', names: [] }, files, ctx)).toEqual([]);
    expect(resolveImport('lib/main.dart', 'dart', { specifier: 'dart:async', names: [] }, files, ctx)).toEqual([]);
  });
});

describe('module inference', () => {
  it('uses path ids, splitting container directories one level deeper', () => {
    expect(moduleIdForPath('index.ts')).toBe('.');
    expect(moduleIdForPath('src/index.ts')).toBe('src');
    expect(moduleIdForPath('src/api/routes/user.ts')).toBe('src/api');
    expect(moduleIdForPath('packages/web/src/App.tsx')).toBe('packages/web');
    expect(moduleIdForPath('lib/screens/home.dart')).toBe('lib/screens');
    expect(moduleIdForPath('app/models.py')).toBe('app');
    expect(moduleIdForPath('test/fixtures/x/src/a.ts')).toBe('test');
  });

  it('descends through container folders at any depth (feature-first layouts)', () => {
    expect(moduleIdForPath('src/features/cart/ui/Cart.tsx')).toBe('src/features/cart');
    expect(moduleIdForPath('lib/features/auth/screens/login.dart')).toBe('lib/features/auth');
    expect(moduleIdForPath('src/features/index.ts')).toBe('src/features');
  });

  it('restarts inference inside nested projects (folders with their own manifest)', () => {
    const roots = ['web', 'mobile', 'web/packages/ui'];
    expect(moduleIdForPath('web/src/app/page.tsx', [], roots)).toBe('web/src/app');
    expect(moduleIdForPath('web/next.config.ts', [], roots)).toBe('web');
    expect(moduleIdForPath('mobile/lib/features/auth/x.dart', [], roots)).toBe('mobile/lib/features/auth');
    expect(moduleIdForPath('web/packages/ui/src/Button.tsx', [], roots)).toBe('web/packages/ui/src');
    expect(moduleIdForPath('docs/x.ts', [], roots)).toBe('docs');
  });

  it('splits a folder holding most of the source (a single Python package) one level deeper', () => {
    const files = [
      'app/__init__.py', 'app/agent.py', 'app/cli.py', 'app/config.py',
      'app/memory/store.py', 'app/memory/recall.py',
      'app/tools/shell.py', 'app/tools/browser.py', 'app/tools/files.py',
      'tests/test_agent.py',
    ];
    const resolve = createModuleResolver(files);
    expect(resolve('app/agent.py')).toBe('app');
    expect(resolve('app/memory/store.py')).toBe('app/memory');
    expect(resolve('app/tools/shell.py')).toBe('app/tools');
    expect(resolve('tests/test_agent.py')).toBe('tests');
    // Not split: too small, or no subfolders to split into, or the user drew the boundary.
    expect(findDominantFolders(['app/a.py', 'app/b/c.py', 'app/d/e.py'])).toEqual(new Set());
    expect(findDominantFolders(files.filter((f) => !f.includes('/memory/') && !f.includes('/tools/')).concat(['app/x.py', 'app/y.py', 'app/z.py', 'app/w.py']))).toEqual(new Set());
    expect(findDominantFolders(files, [{ path: 'app/**' }])).toEqual(new Set());
  });

  it('passes through single-child folder chains (JVM package paths) to where the tree branches', () => {
    const base = 'src/main/java/com/showroom';
    const files = [`${base}/Main.java`, `${base}/model/Car.java`, `${base}/model/Customer.java`, `${base}/dao/CarDao.java`, `${base}/ui/MainFrame.java`];
    // Too small to restructure: stays where folder inference puts it.
    expect(createModuleResolver(files)(`${base}/model/Car.java`)).toBe('src/main');
    // With enough files, the branching package itself splits into its subpackages.
    const more = [...files, ...[1, 2, 3, 4].map((n) => `${base}/model/M${n}.java`), ...[1, 2].map((n) => `${base}/dao/D${n}.java`)];
    const resolveMore = createModuleResolver(more);
    expect(resolveMore(`${base}/model/Car.java`)).toBe(`${base}/model`);
    expect(resolveMore(`${base}/dao/CarDao.java`)).toBe(`${base}/dao`);
    expect(resolveMore(`${base}/Main.java`)).toBe(base);
  });

  it('lets config overrides define boundaries (first match wins)', () => {
    const overrides = [{ path: 'src/features/*' }, { path: 'src/legacy/**' }];
    expect(moduleIdForPath('src/features/cart/ui/Cart.tsx', overrides)).toBe('src/features/cart');
    expect(moduleIdForPath('src/legacy/a/b/c.ts', overrides)).toBe('src/legacy');
    expect(moduleIdForPath('src/api/x.ts', overrides)).toBe('src/api');
  });

  it('recognises test files and fixtures across ecosystems', () => {
    for (const p of ['test/a.ts', 'src/a.test.ts', 'src/a.spec.jsx', 'tests/test_x.py', 'pkg/x_test.go', 'test/fixtures/repo/src/a.ts', 'Tests/AppTests.swift']) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ['src/a.ts', 'src/testing-utils.ts', 'app/models.py', 'lib/contest.dart']) {
      expect(isTestPath(p), p).toBe(false);
    }
  });

  it('matches artifact module filters and builds file-safe slugs', () => {
    expect(moduleMatches('src/api', 'src/*')).toBe(true);
    expect(moduleMatches('src', 'src/*')).toBe(false);
    expect(moduleMatches('src/api', 'src/**')).toBe(true);
    expect(moduleMatches('lib', '**')).toBe(true);
    expect(moduleMatches('packages/web', 'packages/w*')).toBe(true);
    expect(moduleSlug('src/api')).toBe('src-api');
    expect(moduleSlug('.')).toBe('root');
  });
});
