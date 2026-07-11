import fs from 'node:fs';
import path from 'node:path';
import { walkRepo } from './walker';
import { parseFile } from './parser';
import { inferModules } from './modules';
import type { ModuleSummary } from './modules';
import type { Language, ParsedFile } from './types';

export const LANGUAGE_ORDER: Language[] = ['typescript', 'javascript', 'python'];

export interface AnalysisResult {
  targetDir: string;
  parsedFiles: ParsedFile[];
  modules: ModuleSummary[];
  languagesPresent: Language[];
  projectName: string;
  warnings: string[];
}

export function detectProjectName(targetDir: string): string {
  const pkgPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name;
    } catch {
      // malformed package.json — fall through to directory name
    }
  }
  return path.basename(path.resolve(targetDir));
}

/**
 * Shared walk + parse + module-inference pipeline used by `try`, `init`, and
 * `analyze` — they all need the exact same facts, only what they do with the
 * result differs (print vs. propose config vs. persist to the graph).
 */
export function analyzeRepo(targetDir: string): AnalysisResult {
  const relFiles = walkRepo(targetDir);
  const parsedFiles: ParsedFile[] = [];
  const warnings: string[] = [];

  for (const relPath of relFiles) {
    const absPath = path.join(targetDir, relPath);
    try {
      const source = fs.readFileSync(absPath, 'utf8');
      const parsed = parseFile(absPath, relPath, source);
      if (parsed) parsedFiles.push(parsed);
    } catch (err) {
      warnings.push(`could not parse ${relPath}: ${(err as Error).message}`);
    }
  }

  const languagesPresent = LANGUAGE_ORDER.filter((lang) => parsedFiles.some((f) => f.language === lang));
  const modules = inferModules(parsedFiles);
  const projectName = detectProjectName(targetDir);

  return { targetDir, parsedFiles, modules, languagesPresent, projectName, warnings };
}
