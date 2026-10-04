import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import ignoreFactory from 'ignore';
import { DEFAULT_IGNORES } from '../analysis/walker';
import { isTestPath } from '../analysis/modules';
import type { DocRef, RefKind } from './extract';

export interface DriftFinding {
  file: string;
  line: number;
  kind: RefKind;
  /** The reference exactly as written in the doc. */
  reference: string;
  message: string;
  /** A likely replacement, when one exists in the code. */
  suggestion?: string;
}

export interface VerifyContext {
  rootDir: string;
  /** Every non-ignored repo file (any type), repo-relative. */
  repoFiles: readonly string[];
  /** Source files whose text is searched for code names. */
  sourceFiles: readonly string[];
  /** Names of every indexed symbol (fast path for code-name checks). */
  symbolNames: ReadonlySet<string>;
  /** References configured never to be reported (`drift.ignore`). */
  ignore: ReadonlySet<string>;
  /** Files CtxKeep itself generates: mentioning them is correct even before the first sync. */
  generatedPaths?: ReadonlySet<string>;
}

/** Globals and runtime APIs a doc may legitimately mention that won't appear in the repo's own code. */
const KNOWN_GLOBALS = new Set([
  'JSON', 'Math', 'Object', 'Array', 'Promise', 'console', 'process', 'window', 'document', 'globalThis', 'Date', 'Number',
  'String', 'Map', 'Set', 'Error', 'fetch', 'require', 'module', 'exports', 'Buffer', 'setTimeout', 'setInterval', 'localStorage',
  'sessionStorage', 'navigator', 'URL', 'Intl', 'Symbol', 'Reflect', 'Proxy', 'WeakMap', 'self', 'os', 'sys', 'print', 'len',
  'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useContext', 'useReducer',
]);

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function closest(target: string, options: Iterable<string>, maxDistance: number): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const option of options) {
    const d = option.startsWith(target) || target.startsWith(option) ? 1 : levenshtein(target, option);
    if (d < bestDistance || (d === bestDistance && best !== undefined && option < best)) {
      best = option;
      bestDistance = d;
    }
  }
  return bestDistance <= maxDistance ? best : undefined;
}

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function makeTargets(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?![:=])/gm)].map((m) => m[1]);
}

/** Paths git (or, outside git, the root .gitignore + built-in ignores) would ignore — a doc may mention them without them existing. */
function ignoredPaths(rootDir: string, allCandidates: string[]): Set<string> {
  // Paths outside the repo (`../x`) can't be gitignored by it.
  const candidates = allCandidates.filter((c) => !c.startsWith('..') && c !== '.' && c !== '');
  if (candidates.length === 0) return new Set();
  try {
    const out = execFileSync('git', ['check-ignore', '-z', '--no-index', '--stdin'], {
      cwd: rootDir,
      input: candidates.join('\0'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const ignored = new Set(out.split('\0').filter(Boolean));
    const ig = ignoreFactory().add(DEFAULT_IGNORES);
    for (const c of candidates) if (ig.ignores(c.replace(/\/$/, '')) || ig.ignores(c.endsWith('/') ? c : `${c}/`)) ignored.add(c);
    return ignored;
  } catch (err) {
    // Exit code 1 means "nothing ignored"; anything else (no git) falls back to .gitignore parsing.
    const status = (err as { status?: number }).status;
    const ig = ignoreFactory().add(DEFAULT_IGNORES);
    if (status !== 1) {
      const gitignore = path.join(rootDir, '.gitignore');
      if (fs.existsSync(gitignore)) ig.add(fs.readFileSync(gitignore, 'utf8'));
    }
    return new Set(candidates.filter((c) => ig.ignores(c.replace(/\/$/, '')) || ig.ignores(`${c.replace(/\/$/, '')}/`)));
  }
}

export function verifyRefs(refs: DocRef[], ctx: VerifyContext): DriftFinding[] {
  const { rootDir } = ctx;
  const fileSet = new Set(ctx.repoFiles);
  const dirSet = new Set<string>();
  const byBasename = new Map<string, string[]>();
  for (const f of ctx.repoFiles) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i += 1) dirSet.add(parts.slice(0, i).join('/'));
    const base = parts[parts.length - 1];
    byBasename.set(base, [...(byBasename.get(base) ?? []), f]);
  }
  const exists = (rel: string): boolean => {
    const clean = path.posix.normalize(rel).replace(/\/$/, '');
    if (clean === '.' || clean === '') return true;
    if (ctx.generatedPaths?.has(clean)) return true;
    if (clean.startsWith('..')) return fs.existsSync(path.join(rootDir, clean));
    return fileSet.has(clean) || dirSet.has(clean) || fs.existsSync(path.join(rootDir, clean));
  };

  const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.dart'];
  const dirNames = new Set([...dirSet].map((d) => path.posix.basename(d)));
  const allPaths = [...fileSet, ...dirSet];
  /**
   * Docs routinely write paths loosely: relative to an app folder in a monorepo
   * (`src/lib/stores` for `web/src/lib/stores`), or as an import specifier
   * without extension (`lib/services/wallet`). A path is satisfied if it, an
   * extension/index variant of it, or a path ENDING in it exists. A renamed
   * or deleted file matches none of these.
   */
  const satisfied = (rel: string): boolean => {
    const clean = path.posix.normalize(rel).replace(/\/$/, '');
    const variants = [clean, ...MODULE_EXTENSIONS.map((e) => clean + e), ...MODULE_EXTENSIONS.map((e) => `${clean}/index${e}`)];
    if (variants.some(exists)) return true;
    if (clean.startsWith('..')) return false;
    return variants.some((v) => allPaths.some((p) => p.endsWith(`/${v}`)));
  };

  // Names that look like paths but are packages: dependencies of any package.json, and Node builtins.
  const packageNames = new Set<string>(builtinModules);
  for (const f of ctx.repoFiles) {
    if (path.posix.basename(f) !== 'package.json') continue;
    const pkg = readJson(path.join(rootDir, f));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) for (const name of Object.keys(pkg?.[field] ?? {})) packageNames.add(name);
  }
  const isPackageSpecifier = (p: string) => {
    const parts = p.split('/');
    return packageNames.has(parts[0]) || (parts[0].startsWith('@') && packageNames.has(`${parts[0]}/${parts[1]}`));
  };

  const findings: DriftFinding[] = [];
  const pendingPaths: { ref: DocRef; resolved: string; finding: DriftFinding }[] = [];
  const scriptsCache = new Map<string, Record<string, string> | null>();

  const nearest = (startDir: string, fileName: string): string | null => {
    let dir = startDir;
    for (;;) {
      if (fs.existsSync(path.join(rootDir, dir, fileName))) return dir;
      if (dir === '.' || dir === '') return null;
      const parent = path.posix.dirname(dir);
      dir = parent === dir ? '.' : parent;
    }
  };

  // Code-name lookups read source text lazily, at most once per file.
  let sourceTexts: string[] | null = null;
  const inCode = (name: string): boolean => {
    if (ctx.symbolNames.has(name)) return true;
    sourceTexts ??= ctx.sourceFiles.map((f) => {
      try {
        return fs.readFileSync(path.join(rootDir, f), 'utf8');
      } catch {
        return '';
      }
    });
    const re = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}([^\\w$]|$)`);
    return sourceTexts.some((t) => t.includes(name) && re.test(t));
  };

  for (const ref of refs) {
    if (ctx.ignore.has(ref.text)) continue;
    const docDir = path.posix.dirname(ref.file);

    if (ref.kind === 'command') {
      const base = ref.cwd ? path.posix.normalize(path.posix.join(docDir, ref.cwd)) : docDir;
      if (ref.cwd && !exists(base)) continue; // e.g. `git clone ... && cd project && npm install`: runs outside this repo
      if (ref.tool === 'make') {
        const dir = ref.cwd ? (fs.existsSync(path.join(rootDir, base, 'Makefile')) ? base : null) : nearest(base, 'Makefile');
        if (!dir) {
          findings.push({ file: ref.file, line: ref.line, kind: 'command', reference: ref.text, message: `no Makefile in \`${ref.cwd ?? docDir}\`` });
          continue;
        }
        const targets = makeTargets(path.join(rootDir, dir, 'Makefile'));
        if (!targets.includes(ref.script!)) {
          findings.push({
            file: ref.file,
            line: ref.line,
            kind: 'command',
            reference: ref.text,
            message: `Makefile has no \`${ref.script}\` target`,
            suggestion: closest(ref.script!, targets, 3),
          });
        }
        continue;
      }

      const dir = ref.cwd ? (fs.existsSync(path.join(rootDir, base, 'package.json')) ? base : null) : nearest(base, 'package.json');
      if (!dir) {
        findings.push({
          file: ref.file,
          line: ref.line,
          kind: 'command',
          reference: ref.text,
          message: `there is no package.json${ref.cwd ? ` in \`${base}\`` : ''} for this command`,
        });
        continue;
      }
      if (!scriptsCache.has(dir)) scriptsCache.set(dir, readJson(path.join(rootDir, dir, 'package.json'))?.scripts ?? {});
      const scripts = scriptsCache.get(dir)!;
      const script = ref.script!;
      // `npm start` falls back to `node server.js` without a script.
      if (scripts && !(script in scripts) && !(script === 'start' && fs.existsSync(path.join(rootDir, dir, 'server.js')))) {
        const where = dir === '.' ? 'package.json' : `${dir}/package.json`;
        findings.push({
          file: ref.file,
          line: ref.line,
          kind: 'command',
          reference: ref.text,
          message: `\`${script}\` is not a script in ${where}`,
          suggestion: closest(script, Object.keys(scripts), 3),
        });
      }
      continue;
    }

    if (ref.kind === 'path' || ref.kind === 'link') {
      const p = ref.text.replace(/^\.\//, '');
      if (ref.kind === 'path') {
        if (isPackageSpecifier(p)) continue;
        if (/^[\w-]+\.(com|org|io|dev|net|app|ai|co|so|sh)(\/|$)/.test(p)) continue; // a domain, not a path
        if (/(^|\/)(path\/to|your[-_]|my[-_]|example)/i.test(p) || /(^|\/)(My|Your|Example|Foo|Bar)[A-Z]/.test(p)) continue; // placeholder (`MyPanel.ts`)
      }
      const fromDoc = path.posix.normalize(path.posix.join(docDir, p));
      // `../src/` written from a subfolder's point of view leads outside the repo when read from the doc: unverifiable.
      if (fromDoc.startsWith('..')) continue;
      const relative = ref.kind === 'link' || ref.text.startsWith('./') || ref.text.startsWith('../');
      if (relative ? exists(fromDoc) : satisfied(p) || exists(fromDoc)) continue;
      if (ref.kind === 'path' && !p.includes('/') && byBasename.has(p)) continue; // a bare file name that exists somewhere
      // `a/b/c` with no extension and no trailing slash is only a path claim if it starts with a real folder name;
      // otherwise it's prose like `open/click/type` or `read/write`.
      if (ref.kind === 'path' && p.includes('/') && !p.endsWith('/') && !path.posix.extname(p) && !dirNames.has(p.split('/')[0])) continue;

      const base = path.posix.basename(p.replace(/\/$/, ''));
      const moved = (byBasename.get(base) ?? [...dirSet].filter((d) => path.posix.basename(d) === base)).filter(
        (m) => !isTestPath(m.endsWith('/') ? `${m}x` : `${m}/x`),
      );
      const finding: DriftFinding = {
        file: ref.file,
        line: ref.line,
        kind: ref.kind,
        reference: ref.text,
        message: ref.kind === 'link' ? 'link target does not exist' : 'path does not exist',
        suggestion: moved.length === 1 ? moved[0] + (p.endsWith('/') ? '/' : '') : undefined,
      };
      pendingPaths.push({ ref, resolved: relative ? fromDoc : p, finding });
      continue;
    }

    if (ref.kind === 'symbol') {
      const segments = ref.text.split('.');
      if (KNOWN_GLOBALS.has(segments[0])) continue;
      const missing = segments.filter((s) => !inCode(s));
      if (missing.length === 0) continue;
      findings.push({
        file: ref.file,
        line: ref.line,
        kind: 'symbol',
        reference: ref.text,
        message: `\`${missing.join('`, `')}\` does not appear anywhere in the code`,
        suggestion: missing.length === 1 ? closest(missing[0], ctx.symbolNames, 2) : undefined,
      });
    }
  }

  // Paths a doc may mention without them existing (build output, .env, ...) are not drift.
  const ignored = ignoredPaths(rootDir, pendingPaths.map((p) => p.resolved));
  for (const p of pendingPaths) if (!ignored.has(p.resolved)) findings.push(p.finding);

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.reference.localeCompare(b.reference));
}
