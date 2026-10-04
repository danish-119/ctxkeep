import path from 'node:path';
import type { ContextModel, FileInfo, ModuleInfo } from './model';
import { ROOT_MODULE } from './modules';

/**
 * Frequency-based convention inference. A candidate is only proposed when a
 * pattern is both well-sampled and near-unanimous — a "convention" that
 * holds 2 times out of 3 is noise, and noise in an agent's context file is
 * worse than silence. Only positive patterns are proposed: "N functions
 * have no try/catch" (v0.1) described an absence, not a rule anyone follows.
 *
 * Each candidate's id includes its value (`src/api:export-style:named`), so
 * if the code flips to a different style, the human's confirmation of the
 * OLD claim can never silently transfer to the new one.
 */

export type ConventionPatternType = 'export-style' | 'file-naming' | 'test-location' | 'test-naming';

export interface DetectedConvention {
  moduleId: string;
  patternType: ConventionPatternType;
  value: string;
  /** Rendered into artifacts. Deliberately count-free so adding a file doesn't rewrite it. */
  statement: string;
  matched: number;
  sampleSize: number;
  evidenceFilePaths: string[];
}

export const MIN_SAMPLE_SIZE = 3;
export const MIN_AGREEMENT = 0.8;

function dominant<T extends string>(items: { value: T; file: string }[]): { value: T; matched: number; files: string[] } | null {
  if (items.length < MIN_SAMPLE_SIZE) return null;
  const counts = new Map<T, string[]>();
  for (const item of items) counts.set(item.value, [...(counts.get(item.value) ?? []), item.file]);
  const [value, files] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  if (files.length / items.length < MIN_AGREEMENT) return null;
  return { value, matched: files.length, files };
}

function code(moduleId: string): string {
  return moduleId === ROOT_MODULE ? 'the repository root' : `\`${moduleId}/\``;
}

function detectExportStyle(mod: ModuleInfo): DetectedConvention | null {
  const items = mod.files
    .filter((f) => !f.isTest && (f.language === 'typescript' || f.language === 'javascript'))
    .map((f) => {
      const exported = f.symbols.filter((s) => s.exported);
      if (exported.length === 0) return null;
      const hasDefault = exported.some((s) => s.isDefault);
      const hasNamed = exported.some((s) => !s.isDefault);
      return { value: hasDefault && hasNamed ? 'mixed' : hasDefault ? 'default' : 'named', file: f.path };
    })
    .filter((x): x is { value: string; file: string } => x !== null);

  const result = dominant(items);
  if (!result || result.value === 'mixed') return null;
  const label = result.value === 'named' ? 'named exports only (no default exports)' : 'a single default export';
  return {
    moduleId: mod.id,
    patternType: 'export-style',
    value: result.value,
    statement: `Files in ${code(mod.id)} use ${label}.`,
    matched: result.matched,
    sampleSize: items.length,
    evidenceFilePaths: result.files,
  };
}

type NameStyle = 'kebab-case' | 'snake_case' | 'camelCase' | 'PascalCase';

export function classifyFileName(basename: string): NameStyle | null {
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(basename)) return 'kebab-case';
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(basename)) return 'snake_case';
  if (/^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)+$/.test(basename)) return 'PascalCase';
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(basename)) return 'camelCase';
  return null; // single word (`index`, `utils`, `User`) fits every style — not evidence either way
}

function detectFileNaming(mod: ModuleInfo): DetectedConvention | null {
  const items = mod.files
    .filter((f) => !f.isTest)
    .map((f) => ({ value: classifyFileName(path.posix.basename(f.path).split('.')[0]), file: f.path }))
    .filter((x): x is { value: NameStyle; file: string } => x.value !== null);

  const result = dominant(items);
  if (!result) return null;
  return {
    moduleId: mod.id,
    patternType: 'file-naming',
    value: result.value,
    statement: `Multi-word file names in ${code(mod.id)} are ${result.value}.`,
    matched: result.matched,
    sampleSize: items.length,
    evidenceFilePaths: result.files,
  };
}

const TEST_NAME_STYLES: [RegExp, string, string][] = [
  [/\.test\.[cm]?[jt]sx?$/, 'dot-test', '`*.test.*`'],
  [/\.spec\.[cm]?[jt]sx?$/, 'dot-spec', '`*.spec.*`'],
  [/(^|\/)test_[^/]+\.py$/, 'test-prefix', '`test_*.py`'],
  [/_test\.py$/, 'test-suffix', '`*_test.py`'],
];

function realTests(model: ContextModel): FileInfo[] {
  // Fixture trees live under test directories but aren't tests themselves.
  return model.files.filter((f) => f.isTest && !f.path.split('/').some((p) => p === 'fixtures' || p === '__fixtures__'));
}

function detectTestNaming(model: ContextModel): DetectedConvention | null {
  const items = realTests(model)
    .map((f) => ({ value: TEST_NAME_STYLES.find(([re]) => re.test(f.path))?.[1] ?? null, file: f.path }))
    .filter((x): x is { value: string; file: string } => x.value !== null);
  const result = dominant(items);
  if (!result) return null;
  const label = TEST_NAME_STYLES.find(([, v]) => v === result.value)![2];
  return {
    moduleId: ROOT_MODULE,
    patternType: 'test-naming',
    value: result.value,
    statement: `Test files are named ${label}.`,
    matched: result.matched,
    sampleSize: items.length,
    evidenceFilePaths: result.files,
  };
}

function detectTestLocation(model: ContextModel): DetectedConvention | null {
  const tests = realTests(model);
  const items = tests.map((f) => {
    const mod = model.modules.find((m) => m.id === f.moduleId);
    // In a test-only module (e.g. `test/`, `tests/`) → separate tree; next to source → colocated.
    return { value: mod?.isTest ? `dir:${f.moduleId}` : 'colocated', file: f.path };
  });
  const result = dominant(items);
  if (!result) return null;
  const statement =
    result.value === 'colocated'
      ? 'Tests are colocated with the source files they cover.'
      : `Tests live in a separate \`${result.value.slice(4)}/\` tree, not next to source files.`;
  return {
    moduleId: ROOT_MODULE,
    patternType: 'test-location',
    value: result.value,
    statement,
    matched: result.matched,
    sampleSize: items.length,
    evidenceFilePaths: result.files,
  };
}

export function detectConventions(model: ContextModel): DetectedConvention[] {
  const found: DetectedConvention[] = [];
  for (const mod of model.modules) {
    if (mod.isTest) continue;
    for (const c of [detectExportStyle(mod), detectFileNaming(mod)]) if (c) found.push(c);
  }
  for (const c of [detectTestLocation(model), detectTestNaming(model)]) if (c) found.push(c);
  return found;
}

export function conventionId(c: Pick<DetectedConvention, 'moduleId' | 'patternType' | 'value'>): string {
  return `${c.moduleId}:${c.patternType}:${c.value}`;
}
