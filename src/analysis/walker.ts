import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ignoreFactory, { type Ignore } from 'ignore';
import { languageForPath } from './languages';

/**
 * Always excluded, even in a repo with no .gitignore: dependency trees, build
 * outputs, caches, and tool state across the JS, Python, mobile, JVM, and
 * Rust ecosystems. Indexing any of these would describe generated code as if
 * it were the project.
 */
export const DEFAULT_IGNORES = [
  '.git/',
  '.ctxkeep/',
  'node_modules/',
  'bower_components/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  '.parcel-cache/',
  '.vite/',
  '.angular/',
  '.astro/',
  '.output/',
  '.vercel/',
  '.netlify/',
  '.wrangler/',
  '.docusaurus/',
  '.serverless/',
  '.terraform/',
  '.yarn/',
  '.pnpm-store/',
  'storybook-static/',
  '.expo/',
  'vendor/',
  'venv/',
  '.venv/',
  '__pycache__/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.ruff_cache/',
  '.tox/',
  '.ipynb_checkpoints/',
  'Pods/',
  'DerivedData/',
  '.gradle/',
  '.dart_tool/',
  'target/',
  '*.min.js',
  '*.bundle.js',
];

export interface ListFilesOptions {
  /** Extra gitignore-syntax patterns from config.yaml's `ignore:`. */
  extraIgnores?: string[];
  /** Cheap path predicate applied before any filesystem check. */
  include?: (relPath: string) => boolean;
}

/** Repos git refused to list ("dubious ownership"), so callers can tell the user instead of degrading silently. */
const gitRefusals = new Set<string>();

/**
 * A user-facing warning if git refused to read this repository. The
 * filesystem fallback still works, but only the root .gitignore is honoured.
 */
export function gitFallbackWarning(rootDir: string): string | null {
  if (!gitRefusals.has(path.resolve(rootDir))) return null;
  return (
    'git refused to read this repository ("dubious ownership": the folder belongs to another Windows/OS user), so CtxKeep ' +
    'walked the filesystem instead and honoured only the root .gitignore. To fix: ' +
    `git config --global --add safe.directory "${path.resolve(rootDir).split(path.sep).join('/')}"`
  );
}

function buildIgnore(extra: string[]): Ignore {
  return ignoreFactory().add(DEFAULT_IGNORES).add(extra);
}

/**
 * `git ls-files` is the most faithful answer to "what is part of this
 * project": it honours nested .gitignore files, .git/info/exclude, and the
 * user's global excludes — none of which a hand-rolled walker gets right.
 * `--others --exclude-standard` includes new, not-yet-committed files so a
 * sync reflects the working tree, not just the last commit. `-z` keeps
 * paths with spaces or non-ASCII characters unquoted.
 */
function listViaGit(rootDir: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean);
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    if (/dubious ownership/.test(stderr)) gitRefusals.add(path.resolve(rootDir));
    return null; // not a git repo, or git not installed, or git refused to read it
  }
}

function listViaFs(rootDir: string, ig: Ignore): string[] {
  const gitignorePath = path.join(rootDir, '.gitignore');
  const rootIg = ignoreFactory();
  if (fs.existsSync(gitignorePath)) rootIg.add(fs.readFileSync(gitignorePath, 'utf8'));

  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, absPath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        // Directory patterns like `dist/` only match a path with a trailing slash.
        if (ig.ignores(`${relPath}/`) || rootIg.ignores(`${relPath}/`)) continue;
        walk(absPath);
      } else if (entry.isFile()) {
        if (!rootIg.ignores(relPath)) results.push(relPath);
      }
    }
  };
  walk(rootDir);
  return results;
}

/**
 * Repo-relative, posix-style, sorted paths of every non-ignored file (any
 * type), honouring git ignores, DEFAULT_IGNORES, and config `ignore:`.
 */
export function listRepoFiles(rootDir: string, options: ListFilesOptions = {}): string[] {
  const ig = buildIgnore(options.extraIgnores ?? []);
  const candidates = listViaGit(rootDir) ?? listViaFs(rootDir, ig);
  const results = candidates.filter((relPath) => {
    if (options.include && !options.include(relPath)) return false;
    if (ig.ignores(relPath)) return false;
    // `git ls-files --cached` still lists files deleted from the working tree
    // but not yet staged; the working tree is the truth.
    return fs.existsSync(path.join(rootDir, relPath));
  });
  return [...new Set(results)].sort();
}

/** Every tracked SOURCE file: listRepoFiles narrowed to the languages in languages.ts. */
export function listSourceFiles(rootDir: string, options: ListFilesOptions = {}): string[] {
  return listRepoFiles(rootDir, { ...options, include: (relPath) => languageForPath(relPath) !== null });
}
