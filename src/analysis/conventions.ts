import path from 'node:path';
import type { ParsedFile } from './types';

/**
 * Simple frequency-based convention inference (build spec §4 Milestone 5) — three
 * concrete pattern classes only, not a general-purpose detector. Confidence
 * is a plain ratio (matching files / total files or functions), sorted
 * descending; the confidence×blast-radius ranking from the architecture plan
 * is explicitly a later refinement, not MVP scope.
 */
export type ConventionPatternType = 'export-style' | 'error-handling' | 'file-naming';

export interface DetectedConvention {
  patternType: ConventionPatternType;
  moduleId: string;
  statement: string;
  confidence: number;
  evidenceFilePaths: string[];
}

/** Below this, "consistency" within a module is vacuous (1/1 = 100% tells you nothing). */
const MIN_SAMPLE_SIZE = 2;

type ExportStyle = 'default' | 'named' | 'mixed';

function detectExportStyle(moduleId: string, files: ParsedFile[]): DetectedConvention | null {
  const classified: { file: string; style: ExportStyle }[] = [];

  for (const file of files) {
    const exportedSymbols = file.symbols.filter((s) => s.exported);
    if (exportedSymbols.length === 0) continue;

    const hasDefault = exportedSymbols.some((s) => s.name === 'default');
    const hasNamed = exportedSymbols.some((s) => s.name !== 'default');
    const style: ExportStyle = hasDefault && hasNamed ? 'mixed' : hasDefault ? 'default' : 'named';
    classified.push({ file: file.relPath, style });
  }

  if (classified.length < MIN_SAMPLE_SIZE) return null;

  const counts: Record<ExportStyle, number> = { default: 0, named: 0, mixed: 0 };
  for (const c of classified) counts[c.style] += 1;

  const [dominantStyle, dominantCount] = (Object.entries(counts) as [ExportStyle, number][]).sort(
    (a, b) => b[1] - a[1],
  )[0];
  if (dominantCount === 0) return null;

  const label =
    dominantStyle === 'default' ? 'default exports' : dominantStyle === 'named' ? 'named exports' : 'a mix of default and named exports';

  return {
    patternType: 'export-style',
    moduleId,
    statement: `${dominantCount}/${classified.length} files with exports in \`${moduleId}/\` use ${label}.`,
    confidence: dominantCount / classified.length,
    evidenceFilePaths: classified.filter((c) => c.style === dominantStyle).map((c) => c.file),
  };
}

function detectErrorHandling(moduleId: string, files: ParsedFile[]): DetectedConvention | null {
  const functions = files.flatMap((file) =>
    file.symbols
      .filter((s) => s.kind === 'function')
      .map((s) => ({ file: file.relPath, usesTryCatch: s.usesTryCatch })),
  );

  if (functions.length < MIN_SAMPLE_SIZE) return null;

  const usingTryCatch = functions.filter((f) => f.usesTryCatch);
  const notUsing = functions.filter((f) => !f.usesTryCatch);
  const dominant = usingTryCatch.length >= notUsing.length ? usingTryCatch : notUsing;
  const label =
    usingTryCatch.length >= notUsing.length
      ? 'use try/catch error handling'
      : 'have no detected try/catch error handling';

  return {
    patternType: 'error-handling',
    moduleId,
    statement: `${dominant.length}/${functions.length} top-level functions in \`${moduleId}/\` ${label}.`,
    confidence: dominant.length / functions.length,
    evidenceFilePaths: [...new Set(dominant.map((f) => f.file))],
  };
}

type FileNameStyle = 'kebab-case' | 'camelCase' | 'PascalCase' | 'snake_case' | 'ambiguous' | 'other';

function classifyFileNameStyle(basename: string): FileNameStyle {
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(basename)) return 'kebab-case';
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(basename)) return 'snake_case';
  if (/^[A-Z][a-zA-Z0-9]*$/.test(basename) && /[a-z]/.test(basename)) return 'PascalCase';
  if (/^[a-z][a-zA-Z0-9]*$/.test(basename) && /[A-Z]/.test(basename)) return 'camelCase';
  if (/^[a-z0-9]+$/.test(basename)) return 'ambiguous'; // single lowercase word — compatible with any style
  return 'other';
}

function detectFileNaming(moduleId: string, files: ParsedFile[]): DetectedConvention | null {
  if (files.length < MIN_SAMPLE_SIZE) return null;

  const classified = files.map((f) => ({
    file: f.relPath,
    style: classifyFileNameStyle(path.basename(f.relPath, path.extname(f.relPath))),
  }));

  const decidable = classified.filter((c) => c.style !== 'ambiguous' && c.style !== 'other');
  if (decidable.length === 0) return null;

  const counts = new Map<FileNameStyle, number>();
  for (const c of decidable) counts.set(c.style, (counts.get(c.style) ?? 0) + 1);
  const [dominantStyle, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    patternType: 'file-naming',
    moduleId,
    // Ratio over ALL files, per build spec's "simple ratio (files-matching /
    // files-total)" — not just the decidable subset, so an ambiguous file
    // (e.g. "index.ts") correctly dilutes confidence rather than being
    // silently excluded from the denominator.
    statement: `${dominantCount}/${files.length} files in \`${moduleId}/\` use ${dominantStyle} naming.`,
    confidence: dominantCount / files.length,
    evidenceFilePaths: classified.filter((c) => c.style === dominantStyle).map((c) => c.file),
  };
}

export function detectConventionsForModule(moduleId: string, files: ParsedFile[]): DetectedConvention[] {
  const candidates = [detectExportStyle(moduleId, files), detectErrorHandling(moduleId, files), detectFileNaming(moduleId, files)];
  return candidates.filter((c): c is DetectedConvention => c !== null);
}

export function detectConventions(filesByModule: Map<string, ParsedFile[]>): DetectedConvention[] {
  const all: DetectedConvention[] = [];
  for (const [moduleId, files] of filesByModule) {
    all.push(...detectConventionsForModule(moduleId, files));
  }
  return all.sort((a, b) => b.confidence - a.confidence);
}
