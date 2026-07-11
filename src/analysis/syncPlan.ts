import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { walkRepo } from './walker';
import { parseFile } from './parser';
import { languageForExtension } from './languages';
import { hasSrcRoot, moduleGlob, moduleNameForRelPath } from './modules';
import { detectProjectName, LANGUAGE_ORDER } from './analyzeRepo';
import { changedFilesSince, currentHeadSha } from './gitChanges';
import { getCheckpoint, recordCheckpoint } from '../graph/checkpoints';
import { persistModuleSymbols } from '../graph/write';
import type { RegionFileInput, RegionInput, RegionModuleInput, RegionSymbolInput } from '../adapters/claude/regions';
import type { Language, ParsedFile } from './types';

export interface ModuleSyncOutcome {
  moduleName: string;
  stale: boolean;
  symbolCount: number;
}

export interface SyncPlanResult {
  headSha: string;
  snapshot: RegionInput;
  outcomes: ModuleSyncOutcome[];
  warnings: string[];
}

/**
 * The Milestone 4 counterpart to analyzeRepo(): instead of parsing every file, it
 * asks git which files changed since each module's last checkpoint (build
 * spec §4), re-parses ONLY stale modules, and reconstructs a full RegionInput
 * snapshot by mixing that fresh data with symbols already sitting in the
 * graph for untouched modules. Module-level staleness only — "any file in a
 * module changed marks the whole module stale," not real symbol-level AST
 * diffing (that's the Impact Analysis Engine, explicitly out of MVP scope).
 */
export async function planSync(targetDir: string, db: Database.Database): Promise<SyncPlanResult> {
  const headSha = await currentHeadSha(targetDir);
  const warnings: string[] = [];

  const relFiles = walkRepo(targetDir);
  const srcRooted = hasSrcRoot(relFiles.map((relPath) => ({ relPath })));

  const filesByModule = new Map<string, string[]>();
  for (const relPath of relFiles) {
    const moduleName = moduleNameForRelPath(relPath, srcRooted);
    const bucket = filesByModule.get(moduleName);
    if (bucket) bucket.push(relPath);
    else filesByModule.set(moduleName, [relPath]);
  }

  // Cache changed-file lists by base SHA: modules that share a checkpoint (or
  // share "no checkpoint yet") only trigger one `git diff` each, not one per module.
  const changedFilesCache = new Map<string, string[]>();
  async function changedFilesForBase(baseSha: string | null): Promise<string[]> {
    const cacheKey = baseSha ?? '__no-checkpoint__';
    const cached = changedFilesCache.get(cacheKey);
    if (cached) return cached;
    const files = await changedFilesSince(targetDir, baseSha);
    changedFilesCache.set(cacheKey, files);
    return files;
  }

  const outcomes: ModuleSyncOutcome[] = [];
  const regionModules: RegionModuleInput[] = [];
  const regionFiles: RegionFileInput[] = [];
  const languagesPresent = new Set<Language>();

  const moduleNames = [...filesByModule.keys()].sort();

  for (const moduleName of moduleNames) {
    const files = filesByModule.get(moduleName)!.sort();

    const moduleLanguages = new Set<Language>();
    for (const relPath of files) {
      const lang = languageForExtension(path.extname(relPath).toLowerCase());
      if (lang) {
        moduleLanguages.add(lang);
        languagesPresent.add(lang);
      }
    }
    regionModules.push({ name: moduleName, fileCount: files.length, languages: [...moduleLanguages] });

    const checkpoint = getCheckpoint(db, moduleName);
    const changedFiles = await changedFilesForBase(checkpoint?.sha ?? null);
    const changedSet = new Set(changedFiles);
    const isStale = files.some((f) => changedSet.has(f));

    if (isStale) {
      const parsedFiles: ParsedFile[] = [];
      for (const relPath of files) {
        const absPath = path.join(targetDir, relPath);
        try {
          const source = fs.readFileSync(absPath, 'utf8');
          const parsed = parseFile(absPath, relPath, source);
          if (parsed) parsedFiles.push(parsed);
        } catch (err) {
          warnings.push(`could not parse ${relPath}: ${(err as Error).message}`);
        }
      }

      const stats = persistModuleSymbols(db, moduleName, moduleGlob(moduleName, srcRooted), moduleName, parsedFiles);
      recordCheckpoint(db, moduleName, headSha, new Date().toISOString());

      for (const file of parsedFiles) {
        regionFiles.push({
          relPath: file.relPath,
          symbols: file.symbols.map((s): RegionSymbolInput => ({ kind: s.kind, name: s.name })),
        });
      }

      outcomes.push({ moduleName, stale: true, symbolCount: stats.symbolCount });
    } else {
      const rows = db
        .prepare('SELECT file_path as filePath, kind, name FROM symbols WHERE module_id = ? ORDER BY file_path ASC, span_start ASC')
        .all(moduleName) as { filePath: string; kind: string; name: string }[];

      const symbolsByFile = new Map<string, RegionSymbolInput[]>();
      for (const relPath of files) symbolsByFile.set(relPath, []);
      for (const row of rows) {
        const bucket = symbolsByFile.get(row.filePath);
        if (bucket) bucket.push({ kind: row.kind, name: row.name });
      }

      for (const relPath of files) {
        regionFiles.push({ relPath, symbols: symbolsByFile.get(relPath) ?? [] });
      }

      outcomes.push({ moduleName, stale: false, symbolCount: rows.length });
    }
  }

  const snapshot: RegionInput = {
    projectName: detectProjectName(targetDir),
    languagesPresent: LANGUAGE_ORDER.filter((lang) => languagesPresent.has(lang)),
    modules: regionModules.sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name)),
    parsedFiles: regionFiles,
  };

  return { headSha, snapshot, outcomes, warnings };
}
