import path from 'node:path';
import simpleGit from 'simple-git';

/** git's well-known empty-tree object — diffing against it lists every tracked file as "added". */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function currentHeadSha(repoRoot: string): Promise<string> {
  const git = simpleGit(repoRoot);
  const sha = await git.revparse(['HEAD']);
  return sha.trim();
}

/**
 * Repo-relative (posix-style) paths of files that differ between `baseSha`
 * and HEAD. `baseSha: null` means "no prior checkpoint" — diffing against
 * the empty tree makes every tracked file show up as changed, which is
 * exactly "no checkpoint = everything stale" without a separate code path
 * (build spec §4 Milestone 4).
 */
export async function changedFilesSince(repoRoot: string, baseSha: string | null): Promise<string[]> {
  const git = simpleGit(repoRoot);
  const base = baseSha ?? EMPTY_TREE_SHA;
  const raw = await git.diff([`${base}..HEAD`, '--name-only']);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((p) => p.split(path.sep).join('/'));
}

/**
 * Reads a file's content as of HEAD (the last commit), regardless of what's
 * currently on disk. Returns null if the file doesn't exist at HEAD (never
 * committed yet) or there is no HEAD (no commits at all) — both are "nothing
 * to roll back to" for `ctxkeep rollback`, not errors.
 */
export async function readFileAtHead(repoRoot: string, relPath: string): Promise<string | null> {
  const git = simpleGit(repoRoot);
  try {
    return await git.show([`HEAD:${relPath}`]);
  } catch {
    return null;
  }
}
