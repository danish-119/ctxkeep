import type { Language, ParsedFile } from './types';

export interface ModuleSymbolSample {
  name: string;
  kind: string;
  file: string;
}

export interface ModuleSummary {
  name: string;
  fileCount: number;
  languages: Language[];
  sampleSymbols: ModuleSymbolSample[];
}

const SAMPLE_SYMBOLS_PER_MODULE = 5;

/**
 * Groups parsed files into top-level "modules" by folder structure only
 * (module = folder, no real boundary detection — see build spec §6, "corner
 * cut" table). If the repo has a root src/ directory, grouping happens
 * relative to it so `src/foo/x.ts` and `src/bar/y.ts` become modules `foo`
 * and `bar` instead of everything collapsing under `src`.
 */
export function hasSrcRoot(files: { relPath: string }[]): boolean {
  return files.some((f) => f.relPath === 'src' || f.relPath.startsWith('src/'));
}

/** The glob a module's inferred folder maps to, used for config/graph path_glob fields. */
export function moduleGlob(name: string, srcRooted: boolean): string {
  if (name === '(root)') return srcRooted ? 'src/*' : '*';
  return srcRooted ? `src/${name}/**` : `${name}/**`;
}

/** Which inferred module a given relPath belongs to — the single source of truth for the folder→module heuristic. */
export function moduleNameForRelPath(relPath: string, srcRooted: boolean): string {
  let rel = relPath;
  if (srcRooted && rel.startsWith('src/')) {
    rel = rel.slice('src/'.length);
  }
  const parts = rel.split('/');
  return parts.length > 1 ? parts[0] : '(root)';
}

export function inferModules(files: ParsedFile[]): ModuleSummary[] {
  const srcRooted = hasSrcRoot(files);
  const modules = new Map<string, ModuleSummary>();

  for (const file of files) {
    const moduleName = moduleNameForRelPath(file.relPath, srcRooted);

    let summary = modules.get(moduleName);
    if (!summary) {
      summary = { name: moduleName, fileCount: 0, languages: [], sampleSymbols: [] };
      modules.set(moduleName, summary);
    }

    summary.fileCount += 1;
    if (!summary.languages.includes(file.language)) {
      summary.languages.push(file.language);
    }

    for (const sym of file.symbols) {
      if (summary.sampleSymbols.length >= SAMPLE_SYMBOLS_PER_MODULE) break;
      summary.sampleSymbols.push({ name: sym.name, kind: sym.kind, file: file.relPath });
    }
  }

  return [...modules.values()].sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
}

/** Groups already-parsed files by module — used by convention inference (Milestone 5), which needs full ParsedFile data per module. */
export function groupFilesByModule(files: ParsedFile[]): Map<string, ParsedFile[]> {
  const srcRooted = hasSrcRoot(files);
  const byModule = new Map<string, ParsedFile[]>();

  for (const file of files) {
    const moduleName = moduleNameForRelPath(file.relPath, srcRooted);
    const bucket = byModule.get(moduleName);
    if (bucket) bucket.push(file);
    else byModule.set(moduleName, [file]);
  }

  return byModule;
}
