import fs from 'node:fs';
import path from 'node:path';
import type { Language } from './languages';
import type { ParsedImport } from './types';

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export interface PathAlias {
  /** e.g. `@/` for a tsconfig `"@/*": ["./src/*"]` entry. */
  prefix: string;
  /** Repo-relative replacement prefix, e.g. `src/`. */
  target: string;
}

/** Strips // and /* *\/ comments and trailing commas outside of strings — enough for real-world tsconfig.json. */
function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Reads single-wildcard `compilerOptions.paths` from the root tsconfig.json
 * (or jsconfig.json), so `@/components/Button` resolves the way the
 * project's own compiler resolves it. Anything unparseable means "no aliases".
 */
export function readPathAliases(rootDir: string): PathAlias[] {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(rootDir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const config = parseJsonc(fs.readFileSync(file, 'utf8')) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const baseUrl = config.compilerOptions?.baseUrl ?? '.';
      const aliases: PathAlias[] = [];
      for (const [key, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
        if (!key.endsWith('*') || !Array.isArray(targets) || !targets[0]?.endsWith('*')) continue;
        const target = path.posix.normalize(path.posix.join(baseUrl, targets[0].slice(0, -1)));
        aliases.push({ prefix: key.slice(0, -1), target: target === '.' ? '' : `${target.replace(/\/$/, '')}/` });
      }
      return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
    } catch {
      return [];
    }
  }
  return [];
}

function resolveJsBase(base: string, files: ReadonlySet<string>): string | null {
  const candidates = [base];
  const ext = path.posix.extname(base);
  // TypeScript ESM style: `import './util.js'` refers to `util.ts`.
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const stem = base.slice(0, -ext.length);
    candidates.push(...JS_EXTENSIONS.map((e) => stem + e));
  }
  candidates.push(...JS_EXTENSIONS.map((e) => base + e));
  candidates.push(...JS_EXTENSIONS.map((e) => `${base}/index${e}`));
  return candidates.find((c) => files.has(c)) ?? null;
}

function resolveJs(fromPath: string, specifier: string, files: ReadonlySet<string>, aliases: PathAlias[]): string | null {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
    return resolveJsBase(base, files);
  }
  for (const alias of aliases) {
    if (specifier.startsWith(alias.prefix)) {
      return resolveJsBase(path.posix.normalize(alias.target + specifier.slice(alias.prefix.length)), files);
    }
  }
  return null; // a package import — external, not a repo relationship
}

function resolvePythonModule(modulePath: string, files: ReadonlySet<string>): string | null {
  const clean = modulePath.replace(/^\/+|\/+$/g, '');
  if (!clean) return null;
  for (const candidate of [`${clean}.py`, `${clean}/__init__.py`]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function resolvePython(fromPath: string, imp: ParsedImport, files: ReadonlySet<string>): string[] {
  const dots = imp.specifier.match(/^\.*/)![0].length;
  const rest = imp.specifier.slice(dots).split('.').filter(Boolean).join('/');

  const roots: string[] = [];
  if (dots > 0) {
    let base = path.posix.dirname(fromPath);
    for (let i = 1; i < dots; i += 1) base = path.posix.dirname(base);
    roots.push(base === '.' ? '' : base);
  } else {
    // Absolute import: repo root, plus the common `src/` layout.
    roots.push('', 'src');
  }

  for (const root of roots) {
    const join = (...parts: string[]) => parts.filter(Boolean).join('/');
    const results = new Set<string>();
    const target = rest ? resolvePythonModule(join(root, rest), files) : null;
    if (target) results.add(target);
    // `from pkg import submodule` imports a file, not just a name.
    for (const name of imp.names) {
      const sub = resolvePythonModule(join(root, rest, name), files);
      if (sub) results.add(sub);
    }
    if (!rest && results.size === 0) {
      const init = resolvePythonModule(join(root), files);
      if (init) results.add(init);
    }
    if (results.size > 0) return [...results];
  }
  return [];
}

/** `import 'widgets/x.dart'` (relative) or `package:<this app>/x.dart` (→ `lib/x.dart`). `dart:` and other packages are external. */
function resolveDart(fromPath: string, specifier: string, files: ReadonlySet<string>, dartPackage: string | null): string | null {
  if (specifier.startsWith('dart:')) return null;
  if (specifier.startsWith('package:')) {
    const [pkg, ...rest] = specifier.slice('package:'.length).split('/');
    if (!dartPackage || pkg !== dartPackage) return null;
    const target = `lib/${rest.join('/')}`;
    return files.has(target) ? target : null;
  }
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  return files.has(target) ? target : null;
}

export interface ResolveContext {
  aliases: PathAlias[];
  /** pubspec.yaml `name`, for `package:<name>/...` self-imports. */
  dartPackage: string | null;
}

/** Resolves one import to the repo files it refers to (empty for external packages). */
export function resolveImport(
  fromPath: string,
  language: Language,
  imp: ParsedImport,
  files: ReadonlySet<string>,
  ctx: ResolveContext,
): string[] {
  let targets: string[];
  if (language === 'python') targets = resolvePython(fromPath, imp, files);
  else if (language === 'dart') targets = [resolveDart(fromPath, imp.specifier, files, ctx.dartPackage)].filter((t): t is string => t !== null);
  else targets = [resolveJs(fromPath, imp.specifier, files, ctx.aliases)].filter((t): t is string => t !== null);
  return targets.filter((t) => t !== fromPath);
}

/** pubspec.yaml's package name, used to resolve Dart `package:` self-imports. */
export function readDartPackage(rootDir: string): string | null {
  const file = path.join(rootDir, 'pubspec.yaml');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').match(/^name:\s*([\w-]+)/m)?.[1] ?? null;
}
