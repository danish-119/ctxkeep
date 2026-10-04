import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ConfigSchema, type Config } from './schema';

export const CTXKEEP_DIR = '.ctxkeep';
export const CONFIG_FILENAME = 'config.yaml';

export function ctxkeepDir(rootDir: string): string {
  return path.join(rootDir, CTXKEEP_DIR);
}

export function configPath(rootDir: string): string {
  return path.join(ctxkeepDir(rootDir), CONFIG_FILENAME);
}

export function configExists(rootDir: string): boolean {
  return fs.existsSync(configPath(rootDir));
}

export class ConfigError extends Error {}

export interface LoadedConfig {
  config: Config;
  /** False when no config.yaml exists and defaults are in use. */
  found: boolean;
}

/** Reads and validates .ctxkeep/config.yaml; a missing file means "all defaults", not an error. */
export function loadConfig(rootDir: string): LoadedConfig {
  const filePath = configPath(rootDir);
  if (!fs.existsSync(filePath)) return { config: ConfigSchema.parse({}), found: false };

  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(filePath, 'utf8')) ?? {};
  } catch (err) {
    throw new ConfigError(`${CTXKEEP_DIR}/${CONFIG_FILENAME} is not valid YAML: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`${CTXKEEP_DIR}/${CONFIG_FILENAME} is invalid:\n${issues}`);
  }
  return { config: result.data, found: true };
}

/** Writes raw config text (init writes a commented template), creating .ctxkeep/ if needed. */
export function writeConfigText(rootDir: string, text: string): void {
  fs.mkdirSync(ctxkeepDir(rootDir), { recursive: true });
  fs.writeFileSync(configPath(rootDir), text, 'utf8');
}

/**
 * `.ctxkeep/.gitignore` keeps the regenerable graph out of git without
 * touching the project's own .gitignore. config.yaml stays committed.
 */
export function ensureCtxkeepGitignore(rootDir: string): boolean {
  const file = path.join(ctxkeepDir(rootDir), '.gitignore');
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(ctxkeepDir(rootDir), { recursive: true });
  fs.writeFileSync(file, '# Regenerable cache — rebuilt by `ctxkeep analyze`.\ngraph.sqlite*\n', 'utf8');
  return true;
}
