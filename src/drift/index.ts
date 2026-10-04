import fs from 'node:fs';
import path from 'node:path';
import ignoreFactory from 'ignore';
import type { ContextModel } from '../analysis/model';
import { listRepoFiles } from '../analysis/walker';
import { listArtifactPaths } from '../artifacts/plan';
import type { ArtifactConfig, Config } from '../config/schema';
import { extractRefs } from './extract';
import { verifyRefs, type DriftFinding } from './verify';

export type { DriftFinding } from './verify';

/** Always checked when present: the docs people and agents read first. */
const STANDARD_DOCS = ['README.md', 'CONTRIBUTING.md'];

/** Hand-written markdown that `ctxkeep check` verifies: artifacts, standard docs, and `drift.files`. */
export function docsToCheck(rootDir: string, config: Config, artifacts: ArtifactConfig[], repoFiles: readonly string[]): string[] {
  const docs = new Set<string>();
  for (const p of [...listArtifactPaths(rootDir, artifacts), ...STANDARD_DOCS]) {
    if (fs.existsSync(path.join(rootDir, p))) docs.add(p);
  }
  if (config.drift.files.length > 0) {
    const matcher = ignoreFactory().add(config.drift.files); // gitignore-style globs as a matcher
    for (const f of repoFiles) if (f.endsWith('.md') && matcher.ignores(f)) docs.add(f);
  }
  return [...docs].sort();
}

/**
 * Finds statements in hand-written docs that no longer match the code:
 * commands for scripts that don't exist, paths and links to missing files,
 * and code names that appear nowhere in the code. Deterministic and
 * read-only. Generated regions are never checked (they're correct by
 * construction); human text is reported, never changed.
 */
export function findDrift(rootDir: string, config: Config, artifacts: ArtifactConfig[], model: ContextModel): DriftFinding[] {
  const repoFiles = listRepoFiles(rootDir, { extraIgnores: config.ignore });
  const docs = docsToCheck(rootDir, config, artifacts, repoFiles);
  const refs = docs.flatMap((doc) => extractRefs(doc, fs.readFileSync(path.join(rootDir, doc), 'utf8')));
  if (refs.length === 0) return [];

  const symbolNames = new Set<string>();
  for (const f of model.files) for (const s of f.symbols) symbolNames.add(s.name);

  return verifyRefs(refs, {
    rootDir,
    repoFiles,
    sourceFiles: model.files.map((f) => f.path),
    symbolNames,
    ignore: new Set(config.drift.ignore),
    generatedPaths: new Set(listArtifactPaths(rootDir, artifacts)),
  });
}

export function formatFinding(f: DriftFinding): string {
  const hint = f.suggestion ? ` (did you mean \`${f.suggestion}\`?)` : '';
  return `${f.file}:${f.line}  \`${f.reference}\`: ${f.message}${hint}`;
}
