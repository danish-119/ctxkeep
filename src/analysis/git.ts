import { execFileSync } from 'node:child_process';

/** True if `rootDir` is inside a git work tree with at least one commit. */
export function hasGitHead(rootDir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: rootDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A file's content as of HEAD, or null if it isn't in HEAD. `./` makes the
 * path relative to `rootDir` even when that's a subdirectory of the repo.
 */
export function readFileAtHead(rootDir: string, relPath: string): string | null {
  try {
    return execFileSync('git', ['show', `HEAD:./${relPath}`], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}
