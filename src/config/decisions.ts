import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ConfigError, ctxkeepDir } from './io';

/**
 * Convention review decisions live in `.ctxkeep/conventions.yaml`, which is
 * committed. They are human input, and generated docs depend on them, so
 * they can't live only in the gitignored graph cache: otherwise a fresh
 * clone or CI would regenerate AGENTS.md without the confirmed conventions
 * and `ctxkeep check` would fail.
 *
 * The file is the source of truth; the graph mirrors it on every run.
 */

export const DECISIONS_FILENAME = 'conventions.yaml';

export interface ConventionDecisions {
  confirmed: string[];
  rejected: string[];
}

export function decisionsPath(rootDir: string): string {
  return path.join(ctxkeepDir(rootDir), DECISIONS_FILENAME);
}

/** Null when the file doesn't exist yet. */
export function readDecisions(rootDir: string): ConventionDecisions | null {
  const file = decisionsPath(rootDir);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (err) {
    throw new ConfigError(`.ctxkeep/${DECISIONS_FILENAME} is not valid YAML: ${(err as Error).message}`);
  }
  const doc = raw as Partial<Record<keyof ConventionDecisions, unknown>>;
  const list = (v: unknown, key: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new ConfigError(`.ctxkeep/${DECISIONS_FILENAME}: \`${key}\` must be a list of convention ids.`);
    }
    return v as string[];
  };
  return { confirmed: list(doc.confirmed, 'confirmed'), rejected: list(doc.rejected, 'rejected') };
}

export function writeDecisions(rootDir: string, decisions: ConventionDecisions): void {
  const sorted = { confirmed: [...new Set(decisions.confirmed)].sort(), rejected: [...new Set(decisions.rejected)].sort() };
  const body = yaml.dump(sorted, { lineWidth: 120 });
  const text =
    '# Convention review decisions, written by `ctxkeep review conventions`. Commit this file:\n' +
    '# confirmed conventions are written into AGENTS.md, rejected ones are never proposed again.\n' +
    body;
  fs.mkdirSync(ctxkeepDir(rootDir), { recursive: true });
  const file = decisionsPath(rootDir);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.writeFileSync(file, text, 'utf8');
}
