import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { isParsedLanguage, LANGUAGE_LABELS, type Language } from './languages';
import { createModuleResolver, isTestPath, moduleLabel, ROOT_MODULE, type ModuleOverride } from './modules';
import { readDartPackage, readPathAliases, resolveImport } from './imports';
import type { ProjectFacts } from './stack';
import { detectAllFacts } from './projects';
import { getFileRecords, listImports, listSymbols, type ParseStatus, type StoredSymbol } from '../graph/store';
import type { SymbolKind } from './types';

/**
 * Everything an artifact section is allowed to say, assembled from the graph
 * and manifest files. Sections are pure functions of this model: if a fact
 * isn't here, no artifact can claim it.
 */

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  filePath: string;
  exported: boolean;
  isDefault: boolean;
  /** Distinct non-test files that import this symbol by name. */
  refCount: number;
  ordinal: number;
}

export interface FileInfo {
  path: string;
  language: Language;
  moduleId: string;
  isTest: boolean;
  parseStatus: ParseStatus;
  docSummary: string | null;
  symbols: SymbolInfo[];
  /** Distinct non-test files importing this file. */
  importedBy: number;
}

export interface ModuleEdge {
  moduleId: string;
  /** Number of distinct (importing file, imported file) pairs behind the edge. */
  weight: number;
}

export interface ModuleInfo {
  id: string;
  label: string;
  files: FileInfo[];
  /** Language → file count, most common first. */
  languages: [Language, number][];
  /** Every file is a test/fixture file. */
  isTest: boolean;
  /** Human-written description: a README.md in the folder, or the entry file's doc comment. */
  description: string | null;
  dependsOn: ModuleEdge[];
  usedBy: ModuleEdge[];
  /** Exported symbols of non-test files, most-referenced first. */
  publicSymbols: SymbolInfo[];
  /** Languages present here that CtxKeep tracks at file level only. */
  unparsedLanguages: Language[];
}

export interface ContextModel {
  rootDir: string;
  facts: ProjectFacts;
  files: FileInfo[];
  modules: ModuleInfo[];
  /** Language → file count across non-test files (tests counted separately). */
  languages: [Language, number][];
  testFileCount: number;
  /** Count of resolved local import edges between files, non-test sources only. */
  resolvedImportCount: number;
  /** Module id for any path (including deleted ones), using exactly this run's rules. */
  moduleOf: (relPath: string) => string;
  /** How to invoke CtxKeep here: `npx ctxkeep` when it's a project dependency, else `ctxkeep`. */
  ctxkeepCommand: string;
}

function ctxkeepCommand(rootDir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    // CtxKeep's own repo: run the code being worked on, from source.
    if (pkg?.name === 'ctxkeep' && pkg?.scripts?.dev) return 'npm run dev --';
    return pkg?.dependencies?.ctxkeep || pkg?.devDependencies?.ctxkeep ? 'npx ctxkeep' : 'ctxkeep';
  } catch {
    return 'ctxkeep';
  }
}

function countBy<T>(items: T[], key: (t: T) => Language): [Language, number][] {
  const counts = new Map<Language, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || LANGUAGE_LABELS[a[0]].localeCompare(LANGUAGE_LABELS[b[0]]));
}

const ENTRY_BASENAMES = ['index', '__init__', 'main', 'mod', 'lib', 'app'];

function readmeSummary(rootDir: string, moduleId: string): string | null {
  if (moduleId === ROOT_MODULE) return null;
  for (const name of ['README.md', 'readme.md', 'README']) {
    const file = path.join(rootDir, moduleId, name);
    if (!fs.existsSync(file)) continue;
    const paragraph = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#') && !p.startsWith('![') && !p.startsWith('<') && !p.startsWith('[!['));
    if (!paragraph) return null;
    // Links are relative to the README's folder, so they'd break once copied into another file: keep only their text.
    const text = paragraph
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .replace(/[*_`]/g, '')
      .trim();
    if (!text) return null;
    const sentence = text.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? text;
    return sentence.length > 160 ? `${sentence.slice(0, 159).trimEnd()}…` : sentence;
  }
  return null;
}

function moduleDescription(rootDir: string, moduleId: string, files: FileInfo[]): string | null {
  const fromReadme = readmeSummary(rootDir, moduleId);
  if (fromReadme) return fromReadme;
  const dirDepth = moduleId === ROOT_MODULE ? 0 : moduleId.split('/').length;
  const entry = files
    .filter((f) => f.docSummary && f.path.split('/').length === dirDepth + 1)
    .sort((a, b) => {
      const rank = (f: FileInfo) => {
        const base = path.posix.basename(f.path).replace(/\.[^.]+$/, '');
        const i = ENTRY_BASENAMES.indexOf(base);
        return i === -1 ? ENTRY_BASENAMES.length : i;
      };
      return rank(a) - rank(b) || a.path.localeCompare(b.path);
    })[0];
  // Only an entry-style file speaks for the whole module; a random file's doc comment doesn't.
  if (!entry) return null;
  const base = path.posix.basename(entry.path).replace(/\.[^.]+$/, '');
  return ENTRY_BASENAMES.includes(base) ? entry.docSummary : null;
}

export function buildModel(
  db: Database.Database,
  rootDir: string,
  overrides: ModuleOverride[] = [],
  projectRoots: readonly string[] = [],
): ContextModel {
  const facts = detectAllFacts(rootDir, projectRoots);
  // Generated/minified files are tracked for change detection only; nothing in an artifact describes them.
  const records = [...getFileRecords(db).values()]
    .filter((r) => r.parseStatus !== 'generated')
    .sort((a, b) => a.path.localeCompare(b.path));

  const moduleOf = createModuleResolver(records.map((r) => r.path), overrides, projectRoots);
  const files: FileInfo[] = records.map((r) => ({
    path: r.path,
    language: r.language,
    moduleId: moduleOf(r.path),
    isTest: isTestPath(r.path),
    parseStatus: r.parseStatus,
    docSummary: r.docSummary,
    symbols: [],
    importedBy: 0,
  }));
  const byPath = new Map(files.map((f) => [f.path, f]));

  const symbolIndex = new Map<string, SymbolInfo[]>(); // `${file}\0${name}` → symbols
  for (const s of listSymbols(db) as StoredSymbol[]) {
    const file = byPath.get(s.filePath);
    if (!file) continue;
    const info: SymbolInfo = { ...s, refCount: 0 };
    file.symbols.push(info);
    const key = `${s.filePath}\0${s.name}`;
    symbolIndex.set(key, [...(symbolIndex.get(key) ?? []), info]);
  }

  // Resolve imports against the CURRENT file set, every run.
  const fileSet = new Set(files.map((f) => f.path));
  const resolveCtx = { aliases: readPathAliases(rootDir), dartPackage: readDartPackage(rootDir) };
  const fileEdges = new Map<string, Set<string>>(); // importer → imported
  const namedRefs = new Map<string, Set<string>>(); // symbol key → importers
  for (const imp of listImports(db)) {
    const from = byPath.get(imp.filePath);
    if (!from || from.isTest) continue;
    for (const target of resolveImport(imp.filePath, from.language, imp, fileSet, resolveCtx)) {
      if (!fileEdges.has(imp.filePath)) fileEdges.set(imp.filePath, new Set());
      fileEdges.get(imp.filePath)!.add(target);
      for (const name of imp.names) {
        const key =
          name === 'default'
            ? (byPath.get(target)?.symbols.find((s) => s.isDefault) ?? null)
            : null;
        const symbolKey = key ? `${target}\0${key.name}` : `${target}\0${name}`;
        if (!namedRefs.has(symbolKey)) namedRefs.set(symbolKey, new Set());
        namedRefs.get(symbolKey)!.add(imp.filePath);
      }
    }
  }

  let resolvedImportCount = 0;
  const importerCounts = new Map<string, number>();
  for (const targets of fileEdges.values()) {
    for (const t of targets) {
      importerCounts.set(t, (importerCounts.get(t) ?? 0) + 1);
      resolvedImportCount += 1;
    }
  }
  for (const f of files) f.importedBy = importerCounts.get(f.path) ?? 0;
  for (const [key, importers] of namedRefs) {
    for (const s of symbolIndex.get(key) ?? []) s.refCount = importers.size;
  }

  // Module aggregation.
  const grouped = new Map<string, FileInfo[]>();
  for (const f of files) grouped.set(f.moduleId, [...(grouped.get(f.moduleId) ?? []), f]);

  const edgeWeights = new Map<string, Map<string, number>>(); // from module → to module → weight
  for (const [from, targets] of fileEdges) {
    const fromModule = byPath.get(from)!.moduleId;
    for (const t of targets) {
      const toFile = byPath.get(t)!;
      if (toFile.isTest || toFile.moduleId === fromModule) continue;
      if (!edgeWeights.has(fromModule)) edgeWeights.set(fromModule, new Map());
      const m = edgeWeights.get(fromModule)!;
      m.set(toFile.moduleId, (m.get(toFile.moduleId) ?? 0) + 1);
    }
  }
  const sortEdges = (edges: ModuleEdge[]) => edges.sort((a, b) => b.weight - a.weight || a.moduleId.localeCompare(b.moduleId));

  const modules: ModuleInfo[] = [...grouped.entries()]
    .map(([id, moduleFiles]): ModuleInfo => {
      const sourceFiles = moduleFiles.filter((f) => !f.isTest);
      const dependsOn = sortEdges([...(edgeWeights.get(id) ?? new Map()).entries()].map(([moduleId, weight]) => ({ moduleId, weight })));
      const usedBy = sortEdges(
        [...edgeWeights.entries()]
          .filter(([, targets]) => targets.has(id))
          .map(([moduleId, targets]) => ({ moduleId, weight: targets.get(id)! })),
      );
      const publicSymbols = sourceFiles
        .flatMap((f) => f.symbols.filter((s) => s.exported))
        .sort((a, b) => b.refCount - a.refCount || a.filePath.localeCompare(b.filePath) || a.ordinal - b.ordinal);
      const languages = countBy(moduleFiles, (f) => f.language);
      return {
        id,
        label: moduleLabel(id),
        files: moduleFiles,
        languages,
        isTest: moduleFiles.every((f) => f.isTest),
        description: moduleDescription(rootDir, id, sourceFiles),
        dependsOn,
        usedBy,
        publicSymbols,
        unparsedLanguages: languages.map(([l]) => l).filter((l) => !isParsedLanguage(l)),
      };
    })
    // Stable, path-ordered: adding a file never reorders the layout.
    .sort((a, b) => (a.id === ROOT_MODULE ? -1 : b.id === ROOT_MODULE ? 1 : a.id.localeCompare(b.id)));

  const sourceFiles = files.filter((f) => !f.isTest);
  return {
    rootDir,
    facts,
    files,
    modules,
    languages: countBy(sourceFiles, (f) => f.language),
    testFileCount: files.length - sourceFiles.length,
    resolvedImportCount,
    moduleOf,
    ctxkeepCommand: ctxkeepCommand(rootDir),
  };
}
