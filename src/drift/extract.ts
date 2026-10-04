import path from 'node:path';
import { parseRegions } from '../compiler/markers';

/**
 * Pulls checkable references out of the HUMAN-written parts of a markdown
 * file: commands, paths, links, and code names. Generated `ctxkeep` regions
 * are skipped (they're correct by construction), as are lines marked
 * `<!-- ctxkeep-ignore -->` and blocks between `<!-- ctxkeep-ignore-start -->`
 * and `<!-- ctxkeep-ignore-end -->`.
 *
 * Extraction is conservative on purpose: only text written as code
 * (`backticks`, shell code blocks) or as a link is considered, so ordinary
 * prose never produces a finding.
 */

export type RefKind = 'command' | 'path' | 'link' | 'symbol';

export interface DocRef {
  /** Repo-relative markdown file. */
  file: string;
  line: number;
  kind: RefKind;
  /** The reference exactly as written. */
  text: string;
  /** Commands only. */
  tool?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'make';
  script?: string;
  /** Commands only: repo-relative directory the command runs in (from a preceding `cd`), if any. */
  cwd?: string;
}

const SHELL_FENCES = new Set(['', 'sh', 'bash', 'shell', 'zsh', 'console', 'terminal', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat']);

const PNPM_YARN_BUILTINS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'up', 'update', 'upgrade', 'why', 'outdated', 'link', 'unlink', 'init', 'create',
  'dlx', 'exec', 'publish', 'pack', 'store', 'list', 'ls', 'audit', 'config', 'global', 'import', 'rebuild', 'prune', 'set',
  'cache', 'login', 'logout', 'info', 'version', 'workspace', 'workspaces', 'patch', 'node', 'env', 'help', 'self-update',
]);

/** Finds package-manager and make invocations in a shell snippet, tracking `cd dir &&`. */
export function parseCommands(
  snippet: string,
  /** Carries the working directory across calls, e.g. the lines of one shell code block. */
  state: { cwd?: string } = {},
): { tool: DocRef['tool']; script: string; cwd?: string; text: string }[] {
  const found: { tool: DocRef['tool']; script: string; cwd?: string; text: string }[] = [];
  let cwd = state.cwd;
  for (const raw of snippet.split(/&&|\|\||;|\n/)) {
    const segment = raw.trim().replace(/^\$\s+/, '').replace(/^>\s+/, '');
    const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*$/.exec(segment);
    if (cd) {
      const dir = cd[1].replace(/^["']|["']$/g, '');
      cwd = path.posix.normalize(cwd ? path.posix.join(cwd, dir) : dir).replace(/\/$/, '');
      state.cwd = cwd;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^npm\s+(?:run(?:-script)?\s+([\w:.@/-]+)|(test|start|stop|restart)\b)/.exec(segment))) {
      found.push({ tool: 'npm', script: m[1] ?? m[2], cwd, text: segment });
    } else if ((m = /^(pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/.exec(segment)) && !PNPM_YARN_BUILTINS.has(m[2]) && !m[2].startsWith('-')) {
      found.push({ tool: m[1] as 'pnpm' | 'yarn', script: m[2], cwd, text: segment });
    } else if ((m = /^bun\s+run\s+([\w:.-]+)/.exec(segment))) {
      found.push({ tool: 'bun', script: m[1], cwd, text: segment });
    } else if ((m = /^make\s+(?:-\S+\s+)*([A-Za-z0-9][\w.-]*)/.exec(segment)) && !m[1].includes('=')) {
      found.push({ tool: 'make', script: m[1], cwd, text: segment });
    }
  }
  return found;
}

const PATH_WITH_SLASH = /^\.{0,2}\/?[\w@.~-]+(\/[\w@.+-]+)*\/?$/;
const FILE_WITH_EXT = /^[\w.-]+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|dart|go|rs|java|kt|kts|swift|rb|php|cs|c|h|cpp|hpp|vue|svelte|md|mdx|json|ya?ml|toml|sql|sh|ps1|css|scss|html|ipynb|gradle|xml|env|lock)$/;
const CALL_OR_MEMBER = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(\(\))?$/;
const PASCAL_MULTI = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/;
const CAMEL = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;

/** What a backticked span refers to, if it's something checkable. */
export function classifySpan(span: string): Omit<DocRef, 'file' | 'line'> | null {
  const text = span.trim();
  if (!text) return null;
  const commands = parseCommands(text);
  if (commands.length) return { kind: 'command', ...commands[0] };
  if (/\s/.test(text)) return null; // other multi-word spans are prose in code formatting

  if (/[*?{}<>$|"'`=,;!]|^https?:|:\/\/|^[/~@]|^#/.test(text)) return null; // globs, placeholders, URLs, absolute paths, routes
  const cleaned = text.replace(/:\d+(:\d+)?$/, ''); // `file.ts:42`
  if (cleaned.includes('/') && PATH_WITH_SLASH.test(cleaned)) return { kind: 'path', text: cleaned };
  if (FILE_WITH_EXT.test(cleaned)) return { kind: 'path', text: cleaned };

  if (CALL_OR_MEMBER.test(text) && (text.endsWith('()') || text.includes('.') || PASCAL_MULTI.test(text) || CAMEL.test(text))) {
    // Skip things like `v1.2.3`, `e.g.`, `a.b` that look member-ish but aren't code.
    const segments = text.replace(/\(\)$/, '').split('.');
    if (segments.some((s) => s.length < 2)) return null;
    return { kind: 'symbol', text: text.replace(/\(\)$/, '') };
  }
  return null;
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)/;
// Each marker may carry a reason: `<!-- ctxkeep-ignore: example path -->`.
const IGNORE_LINE = /<!--\s*ctxkeep-ignore(?![-\w])[^>]*-->/;
const IGNORE_START = /<!--\s*ctxkeep-ignore-start(?![-\w])[^>]*-->/;
const IGNORE_END = /<!--\s*ctxkeep-ignore-end(?![-\w])[^>]*-->/;
const LINK = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
const SPAN = /(?<!`)`([^`\n]+)`(?!`)/g;

export function extractRefs(file: string, text: string): DocRef[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  const skip = new Set<number>();
  try {
    for (const r of parseRegions(normalized, file)) for (let i = r.startLine; i <= r.endLine; i += 1) skip.add(i);
  } catch {
    // Broken markers are reported by sync; check the whole file here rather than failing.
  }

  const refs: DocRef[] = [];
  let fence: { marker: string; shell: boolean; state: { cwd?: string } } | null = null;
  let ignoring = false;

  lines.forEach((line, i) => {
    if (IGNORE_START.test(line)) ignoring = true;
    if (IGNORE_END.test(line)) {
      ignoring = false;
      return;
    }
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = { marker: fenceMatch[1], shell: SHELL_FENCES.has(fenceMatch[2].toLowerCase()), state: {} };
      else if (fenceMatch[1] === fence.marker && fenceMatch[2] === '') fence = null;
      return;
    }
    if (ignoring || skip.has(i)) return;
    if (IGNORE_LINE.test(line) || IGNORE_LINE.test(lines[i - 1] ?? '')) return;

    const lineNo = i + 1;
    if (fence) {
      // A `cd` on one line of a shell block applies to the lines after it.
      if (fence.shell) for (const c of parseCommands(line, fence.state)) refs.push({ file, line: lineNo, kind: 'command', ...c });
      return;
    }

    for (const m of line.matchAll(LINK)) {
      const target = m[1];
      if (/^(https?:|mailto:|tel:|#|\/|data:)/.test(target) || target.includes('://')) continue;
      refs.push({ file, line: lineNo, kind: 'link', text: decodeURI(target.split('#')[0].split('?')[0]) });
    }
    const withoutLinks = line.replace(LINK, '');
    for (const m of withoutLinks.matchAll(SPAN)) {
      const ref = classifySpan(m[1]);
      if (ref) refs.push({ file, line: lineNo, ...ref });
    }
  });

  return refs.filter((r) => r.kind !== 'link' || r.text.length > 0);
}
