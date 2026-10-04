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
const CONTAINER_DIRS = new Set(['src', 'lib', 'packages', 'apps', 'libs', 'services', 'modules', 'features', 'cmd', 'internal', 'pkg']);

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
 *
 * 1. Config overrides win (first match).
 * 2. Inside a nested project (a folder with its own manifest, e.g. `web/`
 *    with a package.json in a repo that also has `mobile/`), inference
 *    restarts relative to that project, so `web/src/api/x.ts` → `web/src/api`.
 * 3. Otherwise the first folder, descending through container directories
 *    (`src`, `lib`, `packages`, `features`, …): `src/features/cart/x.ts` →
 *    `src/features/cart`.
 *
 * `projectRoots` are repo-relative folders, as found by findProjectRoots.
 */
export function moduleIdForPath(
  relPath: string,
  overrides: ModuleOverride[] = [],
  projectRoots: readonly string[] = [],
  /** Extra folders (full repo-relative paths) to descend through, from findDominantFolders. */
  extraContainers: ReadonlySet<string> = new Set(),
): string {
  const parts = relPath.split('/');
  const dirParts = parts.slice(0, -1);

  for (const override of overrides) {
    const id = matchOverride(dirParts, override);
    if (id) return id;
  }

  // The deepest project root containing this file.
  let base: string[] = [];
  for (const root of projectRoots) {
    const rootParts = root.split('/');
    if (rootParts.length > base.length && rootParts.length <= dirParts.length && rootParts.every((p, i) => dirParts[i] === p)) {
      base = rootParts;
    }
  }

  const inner = dirParts.slice(base.length);
  if (inner.length === 0) return base.length ? base.join('/') : ROOT_MODULE;
  const id = [inner[0]];
  const isContainer = () => CONTAINER_DIRS.has(id[id.length - 1]) || extraContainers.has([...base, ...id].join('/'));
  for (let i = 1; i < inner.length && isContainer(); i += 1) id.push(inner[i]);
  return [...base, ...id].join('/');
}

/** A module holding at least this share of its project's source files is treated as a container. */
const DOMINANT_SHARE = 0.5;
const DOMINANT_MIN_FILES = 8;

function projectOf(p: string, projectRoots: readonly string[]): string {
  let best = '';
  for (const r of projectRoots) if (p.startsWith(`${r}/`) && r.length > best.length) best = r;
  return best;
}

/**
 * Folders that inference should descend through, derived from the actual
 * file layout rather than folder names:
 *
 * - **Pass-through folders**: no files of their own and a single subfolder
 *   (`src/main/java/com/acme/…` in JVM projects, `internal/x/…`). The module
 *   is wherever the tree actually branches.
 * - **Dominant folders**: one folder holding most of a project's source, with
 *   at least two source-bearing subfolders — typically a Python project's
 *   single top-level package (`app/`, `mypackage/`). Split one level deeper
 *   instead of collapsing the whole project into one module. A module created
 *   by such a split is never split again for dominance, so this can't cascade.
 *
 * Only modules with at least DOMINANT_MIN_FILES source files are restructured,
 * and test-only trees never are. Folders the user defined in `modules:`
 * overrides are never descended into.
 */
export function findDominantFolders(
  sourcePaths: readonly string[],
  overrides: ModuleOverride[] = [],
  projectRoots: readonly string[] = [],
): Set<string> {
  const containers = new Set<string>();
  const createdBySplit = new Set<string>();
  const perProject = new Map<string, number>();
  for (const p of sourcePaths) {
    if (isTestPath(p)) continue;
    const project = projectOf(p, projectRoots);
    perProject.set(project, (perProject.get(project) ?? 0) + 1);
  }

  for (let round = 0; round < 12; round += 1) {
    const byModule = new Map<string, string[]>();
    for (const p of sourcePaths) {
      const id = moduleIdForPath(p, overrides, projectRoots, containers);
      const bucket = byModule.get(id);
      if (bucket) bucket.push(p);
      else byModule.set(id, [p]);
    }

    let changed = false;
    for (const [id, files] of byModule) {
      if (id === ROOT_MODULE || projectRoots.includes(id) || containers.has(id)) continue;
      if (overrides.some((o) => matchOverride(id.split('/'), o) === id)) continue; // the user defined this boundary
      // Small modules and test trees are fine as they are; restructuring them only produces longer labels.
      const sourceCount = files.filter((f) => !isTestPath(f)).length;
      if (sourceCount < DOMINANT_MIN_FILES) continue;

      const depth = id.split('/').length;
      const ownFiles = files.filter((f) => f.split('/').length === depth + 1).length;
      const subfolders = new Set(files.map((f) => f.split('/')).filter((parts) => parts.length > depth + 1).map((parts) => parts[depth]));

      // Pass through when one subfolder holds (nearly) everything — a stray `module-info.java` or
      // `__init__.py` at the top of the chain shouldn't stop inference from finding the real packages.
      if (subfolders.size === 1 && ownFiles <= Math.max(1, files.length * 0.1)) {
        containers.add(id);
        changed = true;
        continue;
      }

      const share = sourceCount / (perProject.get(projectOf(id + '/x', projectRoots)) || sourceCount || 1);
      const parent = id.split('/').slice(0, -1).join('/');
      if (share >= DOMINANT_SHARE && subfolders.size >= 2 && !createdBySplit.has(id) && !createdBySplit.has(parent)) {
        containers.add(id);
        for (const sub of subfolders) createdBySplit.add(`${id}/${sub}`);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return containers;
}

/** One resolver per run, shared by every caller so module ids always agree. */
export function createModuleResolver(
  sourcePaths: readonly string[],
  overrides: ModuleOverride[] = [],
  projectRoots: readonly string[] = [],
): (relPath: string) => string {
  const dominant = findDominantFolders(sourcePaths, overrides, projectRoots);
  return (relPath) => moduleIdForPath(relPath, overrides, projectRoots, dominant);
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
