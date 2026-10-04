/**
 * Folder-based module inference. A module's id IS its repo-relative folder
 * path (`src/api`, `packages/web`, `test`, `.` for the root), so every id
 * printed into an artifact is a real path an agent can open — v0.1 used bare
 * folder names and mislabelled `test/` as `src/test/**`.
 */

export const ROOT_MODULE = '.';

/**
 * Directories that group modules rather than being one: `src/api` and
 * `src/cli` are two modules, not one `src` module. Covers JS/TS monorepos
 * (packages, apps, libs), Flutter (`lib`), Go (`cmd`, `internal`, `pkg`), and
 * service-oriented layouts.
 */
const CONTAINER_DIRS = new Set(['src', 'lib', 'packages', 'apps', 'libs', 'services', 'modules', 'cmd', 'internal', 'pkg']);

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'testing', 'integration_test', 'androidTest']);

const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go|dart)$/,
  /Tests?\.(swift|kt|java|cs)$/,
];

/** True for test files and anything under a test directory (fixtures included). */
export function isTestPath(relPath: string): boolean {
  const parts = relPath.split('/');
  if (parts.slice(0, -1).some((p) => TEST_DIRS.has(p) || p === '__fixtures__' || p === 'fixtures')) return true;
  return TEST_FILE_PATTERNS.some((re) => re.test(relPath));
}

export interface ModuleOverride {
  /** Glob over folders, e.g. `src/features/*` (one module per child) or `src/legacy/**` (one module). */
  path: string;
  name?: string;
}

function matchOverride(dirParts: string[], override: ModuleOverride): string | null {
  const patternParts = override.path.replace(/\/+$/, '').split('/');
  if (patternParts[patternParts.length - 1] === '**') patternParts.pop();
  if (patternParts.length === 0 || patternParts.length > dirParts.length) return null;

  for (let i = 0; i < patternParts.length; i += 1) {
    const pattern = patternParts[i];
    if (pattern === '*' || pattern === '**') continue;
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
    if (!re.test(dirParts[i])) return null;
  }
  return dirParts.slice(0, patternParts.length).join('/');
}

/**
 * The single source of truth for "which module does this file belong to".
 * Config overrides win (first match); otherwise the first folder, or the
 * first two when the first is a container directory.
 */
export function moduleIdForPath(relPath: string, overrides: ModuleOverride[] = []): string {
  const parts = relPath.split('/');
  const dirParts = parts.slice(0, -1);

  for (const override of overrides) {
    const id = matchOverride(dirParts, override);
    if (id) return id;
  }

  if (dirParts.length === 0) return ROOT_MODULE;
  if (CONTAINER_DIRS.has(dirParts[0]) && dirParts.length >= 2) return `${dirParts[0]}/${dirParts[1]}`;
  return dirParts[0];
}

/** Display label for a module id: `src/api/`, or `(root)`. */
export function moduleLabel(moduleId: string): string {
  return moduleId === ROOT_MODULE ? '(root)' : `${moduleId}/`;
}

/** Filesystem-safe slug used for per-module artifact paths (`docs/modules/{module}.md`). */
export function moduleSlug(moduleId: string): string {
  return moduleId === ROOT_MODULE ? 'root' : moduleId.replace(/[\\/]+/g, '-');
}

/** Minimal glob for artifact `modules:` filters — same segment syntax as overrides, whole-id match. */
export function moduleMatches(moduleId: string, pattern: string): boolean {
  const idParts = moduleId === ROOT_MODULE ? ['.'] : moduleId.split('/');
  const patternParts = pattern.replace(/\/+$/, '').split('/');
  if (patternParts[patternParts.length - 1] === '**') {
    // `src/**` = `src` itself or anything below it.
    if (patternParts.length === 1) return true;
    return matchOverride(idParts, { path: patternParts.slice(0, -1).join('/') }) !== null;
  }
  if (patternParts.length !== idParts.length) return false;
  return matchOverride(idParts, { path: pattern }) !== null;
}
