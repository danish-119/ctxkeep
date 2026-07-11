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

/** Reads and validates .ctxkeep/config.yaml. Throws ConfigError if missing or invalid. */
export function loadConfig(rootDir: string): Config {
  const filePath = configPath(rootDir);
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`no ${CTXKEEP_DIR}/${CONFIG_FILENAME} found — run \`ctxkeep init\` first`);
  }

  const raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`${CTXKEEP_DIR}/${CONFIG_FILENAME} is invalid:\n${issues}`);
  }

  return result.data;
}

/** Writes config.yaml, creating .ctxkeep/ if needed. Overwrites unconditionally — callers decide idempotency policy. */
export function writeConfig(rootDir: string, config: Config): void {
  fs.mkdirSync(ctxkeepDir(rootDir), { recursive: true });
  const contents = yaml.dump(config, { lineWidth: 100 });
  fs.writeFileSync(configPath(rootDir), contents, 'utf8');
}
