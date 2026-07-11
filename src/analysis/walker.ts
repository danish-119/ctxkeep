import fs from 'node:fs';
import path from 'node:path';
import ignoreFactory from 'ignore';

const DEFAULT_IGNORES = ['.git', 'node_modules'];
const ALLOWED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.py']);

/**
 * Walks a repo tree, honoring the root .gitignore (plus .git/node_modules as a
 * hardcoded floor even if a project has no .gitignore), and returns relative
 * (posix-style) paths of files matching the Tier-1 extension set.
 */
export function walkRepo(rootDir: string): string[] {
  const ig = ignoreFactory();
  ig.add(DEFAULT_IGNORES);

  const gitignorePath = path.join(rootDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf8'));
  }

  const results: string[] = [];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, absPath).split(path.sep).join('/');

      if (ig.ignores(relPath)) continue;

      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ALLOWED_EXTENSIONS.has(ext)) {
          results.push(relPath);
        }
      }
    }
  }

  walk(rootDir);
  return results.sort();
}
