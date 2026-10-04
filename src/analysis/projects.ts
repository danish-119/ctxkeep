import path from 'node:path';
import { isTestPath } from './modules';
import { detectProjectFacts, type ProjectFacts } from './stack';
import { listRepoFiles } from './walker';

/**
 * Nested projects: a folder (other than the repo root) holding its own
 * manifest — e.g. `web/package.json` + `mobile/pubspec.yaml` in one repo.
 * Without this, a whole app collapses into a single module and its stack and
 * commands are invisible, because manifests are otherwise read only at the
 * root. Gradle files are deliberately not manifests here: an `android/`
 * folder inside a Flutter or React Native app is part of that app.
 */
const PROJECT_MANIFESTS = new Set([
  'package.json',
  'pubspec.yaml',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'composer.json',
  'Gemfile',
]);

/** Repo-relative folders that are nested projects, shallowest first. Fixtures and test trees never count. */
export function findProjectRoots(rootDir: string, extraIgnores: string[] = []): string[] {
  const manifests = listRepoFiles(rootDir, {
    extraIgnores,
    include: (p) => PROJECT_MANIFESTS.has(path.posix.basename(p)),
  });
  const roots = new Set<string>();
  for (const manifest of manifests) {
    const dir = path.posix.dirname(manifest);
    if (dir === '.' || isTestPath(`${dir}/x`)) continue;
    roots.add(dir);
  }
  return [...roots].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/**
 * Root facts plus every nested project's, each fact attributed to the
 * manifest it came from (`web/package.json`), and each nested command
 * prefixed with the `cd` it needs.
 */
export function detectAllFacts(rootDir: string, projectRoots: readonly string[]): ProjectFacts {
  const facts = detectProjectFacts(rootDir);
  const nested = projectRoots.map((dir) => ({ dir, facts: detectProjectFacts(path.join(rootDir, dir)) }));

  for (const { dir, facts: sub } of nested) {
    for (const item of sub.stack) {
      if (!facts.stack.some((s) => s.label === item.label)) facts.stack.push({ label: item.label, source: `${dir}/${item.source}` });
    }
    for (const cmd of sub.commands) {
      facts.commands.push({ ...cmd, command: `cd ${dir.includes(' ') ? `"${dir}"` : dir} && ${cmd.command}`, source: `${dir}/${cmd.source}` });
    }
    for (const entry of sub.entryPoints) {
      const target = entry.target.includes(':') ? entry.target : `${dir}/${entry.target.replace(/^\.\//, '')}`;
      facts.entryPoints.push({ ...entry, target, source: `${dir}/${entry.source}` });
    }
  }
  return facts;
}
