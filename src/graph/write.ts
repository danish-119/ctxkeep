import type Database from 'better-sqlite3';
import { hasSrcRoot, moduleGlob, moduleNameForRelPath } from '../analysis/modules';
import type { AnalysisResult } from '../analysis/analyzeRepo';
import type { ParsedFile, ParsedSymbol } from '../analysis/types';

export interface PersistStats {
  moduleCount: number;
  symbolCount: number;
}

function symbolParams(moduleId: string, file: ParsedFile, sym: ParsedSymbol) {
  return {
    // name included defensively, not just span — two distinct symbols could
    // in principle share a startIndex (e.g. a grammar quirk); (file, name)
    // alone can collide too (redeclare/overload), so both together.
    id: `${file.relPath}:${sym.startIndex}:${sym.name}`,
    moduleId,
    kind: sym.kind,
    name: sym.name,
    filePath: file.relPath,
    spanStart: sym.startIndex,
    spanEnd: sym.endIndex,
    signatureHash: sym.signatureHash,
  };
}

/**
 * Full baseline re-populate of `modules` and `symbols` (build spec §4 Milestone 2
 * — `ctxkeep analyze` is a from-scratch scan, not an incremental sync;
 * that's Milestone 4). `symbols` is fully cleared and reinserted (nothing
 * references it via FK). `modules` is upserted, NOT deleted-and-reinserted —
 * `checkpoints` and `conventions` (Milestones 4-5) reference modules.id, and this
 * better-sqlite3 build enforces foreign keys by default, so deleting a
 * module row with existing checkpoint/convention history throws a FK
 * constraint error. A module whose folder disappears entirely leaves a
 * stale row behind (not cleaned up) — an accepted corner cut, consistent
 * with Milestone 2's "module = folder, no boundary detection" scope; the same
 * trade-off persistModuleSymbols already made for `ctxkeep sync`.
 */
export function persistAnalysis(db: Database.Database, result: AnalysisResult): PersistStats {
  const srcRooted = hasSrcRoot(result.parsedFiles);

  const clearSymbols = db.prepare('DELETE FROM symbols');
  const upsertModule = db.prepare(
    `INSERT INTO modules (id, path_glob, name) VALUES (@id, @pathGlob, @name)
     ON CONFLICT(id) DO UPDATE SET path_glob = excluded.path_glob, name = excluded.name`,
  );
  const insertSymbol = db.prepare(`
    INSERT INTO symbols (id, module_id, kind, name, file_path, span_start, span_end, signature_hash)
    VALUES (@id, @moduleId, @kind, @name, @filePath, @spanStart, @spanEnd, @signatureHash)
  `);

  let symbolCount = 0;

  const run = db.transaction(() => {
    clearSymbols.run();

    for (const mod of result.modules) {
      upsertModule.run({ id: mod.name, pathGlob: moduleGlob(mod.name, srcRooted), name: mod.name });
    }

    for (const file of result.parsedFiles) {
      const moduleId = moduleNameForRelPath(file.relPath, srcRooted);
      for (const sym of file.symbols) {
        insertSymbol.run(symbolParams(moduleId, file, sym));
        symbolCount += 1;
      }
    }
  });

  run();

  return { moduleCount: result.modules.length, symbolCount };
}

export interface ModuleSyncStats {
  symbolCount: number;
}

/**
 * Targeted update for ONE module's rows — the `ctxkeep sync` counterpart to
 * `persistAnalysis` (build spec §4 Milestone 4). Only this module's symbol rows
 * are cleared and reinserted; every other module's rows are untouched,
 * because sync only ever re-parses files belonging to modules git marked
 * stale.
 */
export function persistModuleSymbols(
  db: Database.Database,
  moduleId: string,
  pathGlob: string,
  moduleName: string,
  files: ParsedFile[],
): ModuleSyncStats {
  const upsertModule = db.prepare(
    `INSERT INTO modules (id, path_glob, name) VALUES (@id, @pathGlob, @name)
     ON CONFLICT(id) DO UPDATE SET path_glob = excluded.path_glob, name = excluded.name`,
  );
  const clearModuleSymbols = db.prepare('DELETE FROM symbols WHERE module_id = ?');
  const insertSymbol = db.prepare(`
    INSERT INTO symbols (id, module_id, kind, name, file_path, span_start, span_end, signature_hash)
    VALUES (@id, @moduleId, @kind, @name, @filePath, @spanStart, @spanEnd, @signatureHash)
  `);

  let symbolCount = 0;

  const run = db.transaction(() => {
    upsertModule.run({ id: moduleId, pathGlob, name: moduleName });
    clearModuleSymbols.run(moduleId);

    for (const file of files) {
      for (const sym of file.symbols) {
        insertSymbol.run(symbolParams(moduleId, file, sym));
        symbolCount += 1;
      }
    }
  });

  run();

  return { symbolCount };
}
