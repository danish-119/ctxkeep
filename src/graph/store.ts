import type Database from 'better-sqlite3';
import type { Language } from '../analysis/languages';
import type { ParsedFile, ParsedImport, SymbolKind } from '../analysis/types';

export type ParseStatus = 'parsed' | 'file-only' | 'too-large' | 'error' | 'generated';

export interface FileRecord {
  path: string;
  language: Language;
  size: number;
  mtimeMs: number;
  contentHash: string;
  parseStatus: ParseStatus;
  docSummary: string | null;
}

export interface StoredSymbol {
  filePath: string;
  ordinal: number;
  kind: SymbolKind;
  name: string;
  exported: boolean;
  isDefault: boolean;
}

export interface StoredImport extends ParsedImport {
  filePath: string;
}

export function getFileRecords(db: Database.Database): Map<string, FileRecord> {
  const rows = db
    .prepare(
      `SELECT path, language, size, mtime_ms as mtimeMs, content_hash as contentHash,
              parse_status as parseStatus, doc_summary as docSummary
       FROM files`,
    )
    .all() as FileRecord[];
  return new Map(rows.map((r) => [r.path, r]));
}

/** Inserts or replaces a file and (re)writes its parse output; old symbols/imports are dropped first. */
export function writeFile(db: Database.Database, record: FileRecord, parsed: ParsedFile | null): void {
  db.prepare('DELETE FROM symbols WHERE file_path = ?').run(record.path);
  db.prepare('DELETE FROM imports WHERE file_path = ?').run(record.path);
  db.prepare(
    `INSERT INTO files (path, language, size, mtime_ms, content_hash, parse_status, doc_summary)
     VALUES (@path, @language, @size, @mtimeMs, @contentHash, @parseStatus, @docSummary)
     ON CONFLICT(path) DO UPDATE SET
       language = excluded.language, size = excluded.size, mtime_ms = excluded.mtime_ms,
       content_hash = excluded.content_hash, parse_status = excluded.parse_status, doc_summary = excluded.doc_summary`,
  ).run(record);

  if (!parsed) return;

  const insertSymbol = db.prepare(`
    INSERT INTO symbols (file_path, ordinal, kind, name, exported, is_default, line, span_start, span_end, signature_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  parsed.symbols.forEach((s, i) =>
    insertSymbol.run(record.path, i, s.kind, s.name, s.exported ? 1 : 0, s.isDefault ? 1 : 0, s.line, s.startIndex, s.endIndex, s.signatureHash),
  );

  const insertImport = db.prepare('INSERT INTO imports (file_path, ordinal, specifier, names) VALUES (?, ?, ?, ?)');
  parsed.imports.forEach((imp, i) => insertImport.run(record.path, i, imp.specifier, JSON.stringify(imp.names)));
}

/** Metadata-only update: content hash matched, only mtime moved (e.g. `touch`, a checkout of identical bytes). */
export function touchFile(db: Database.Database, path: string, mtimeMs: number): void {
  db.prepare('UPDATE files SET mtime_ms = ? WHERE path = ?').run(mtimeMs, path);
}

export function deleteFile(db: Database.Database, path: string): void {
  db.prepare('DELETE FROM files WHERE path = ?').run(path); // symbols/imports cascade
}

export function listSymbols(db: Database.Database): StoredSymbol[] {
  return (
    db
      .prepare(
        `SELECT file_path as filePath, ordinal, kind, name, exported, is_default as isDefault
         FROM symbols ORDER BY file_path, ordinal`,
      )
      .all() as (Omit<StoredSymbol, 'exported' | 'isDefault'> & { exported: number; isDefault: number })[]
  ).map((r) => ({ ...r, exported: r.exported === 1, isDefault: r.isDefault === 1 }));
}

export function listImports(db: Database.Database): StoredImport[] {
  return (
    db.prepare('SELECT file_path as filePath, specifier, names FROM imports ORDER BY file_path, ordinal').all() as {
      filePath: string;
      specifier: string;
      names: string;
    }[]
  ).map((r) => ({ filePath: r.filePath, specifier: r.specifier, names: JSON.parse(r.names) }));
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
