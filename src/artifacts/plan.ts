import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { moduleMatches, moduleSlug, ROOT_MODULE } from '../analysis/modules';
import type { ContextModel, ModuleInfo } from '../analysis/model';
import { listRepoFiles } from '../analysis/walker';
import { ConfigError } from '../config/io';
import type { ArtifactConfig, Config } from '../config/schema';
import type { ConventionRow } from '../graph/conventions';
import { parseRegions } from '../compiler/markers';
import { applyRegions, isOnlyBoilerplate, type DesiredRegion, type RegionOutcome } from '../compiler/apply';
import { detectPointerTools, toolById } from './agents';
import { parseRegionId, regionId, SECTIONS, type RenderContext } from './sections';

/**
 * The default artifact set: deliberately small (architecture plan §2: don't
 * emit every artifact type on day one) and tool-agnostic.
 *
 * - AGENTS.md is the single source of truth for always-loaded agent context.
 * - Pointer files (CLAUDE.md, GEMINI.md) are added only for tools that don't
 *   read AGENTS.md natively; see `resolveArtifactConfigs` and agents.ts.
 * - ARCHITECTURE.md and .ai/manifest.md are on-demand references: richer,
 *   count-bearing detail that would bloat an always-loaded file.
 */
export const DEFAULT_ARTIFACTS: ArtifactConfig[] = [
  { path: 'AGENTS.md', sections: ['overview', 'commands', 'layout', 'conventions', 'agent-workflow'], enabled: true },
  { path: 'ARCHITECTURE.md', title: 'Architecture', sections: ['architecture', 'key-files'], enabled: true },
  { path: '.ai/manifest.md', title: 'Module index', sections: ['module'], enabled: true },
];

/** `{module}` is a file-safe slug (`src-api`); `{module_dir}` is the module's own folder (`src/api`), for nested AGENTS.md. */
const MODULE_TOKEN = '{module}';
const MODULE_DIR_TOKEN = '{module_dir}';

/** Region ids written by v0.1 that no longer correspond to a section; removed on upgrade (when unedited). */
const RETIRED_REGION_IDS = new Set(['modules']);

function isTemplate(p: string): boolean {
  return p.includes(MODULE_TOKEN) || p.includes(MODULE_DIR_TOKEN);
}

function concretePath(template: string, moduleId: string): string {
  return template.split(MODULE_DIR_TOKEN).join(moduleId).split(MODULE_TOKEN).join(moduleSlug(moduleId));
}

/** Matches every concrete path a template can produce. */
function templateRegex(template: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = template
    .split(MODULE_DIR_TOKEN)
    .map((part) => part.split(MODULE_TOKEN).map(escape).join('([^/]+)'))
    .join('(.+)');
  return new RegExp(`^${pattern}$`);
}

/** Which pointer tools this repo gets: explicit `agents:`, else v0.1's `adapters.claude`, else detected usage. */
export function resolveAgentTools(config: Config, rootDir: string): string[] {
  if (config.agents) return [...new Set(config.agents)];
  const detected = new Set(detectPointerTools(rootDir));
  if (config.adapters?.claude.enabled === true) detected.add('claude'); // v0.1 configs always emitted CLAUDE.md
  if (config.adapters?.claude.enabled === false) detected.delete('claude');
  return [...detected].sort();
}

/** Validates and returns the artifacts this config maintains. Throws ConfigError with an actionable message. */
export function resolveArtifactConfigs(config: Config, rootDir: string): ArtifactConfig[] {
  let artifacts = [...(config.artifacts ?? DEFAULT_ARTIFACTS)];

  // One pointer file per tool that can't read AGENTS.md itself, plus the tool's doc-fixing command where it has
  // a command format — unless the config lists that file already.
  for (const id of resolveAgentTools(config, rootDir)) {
    const tool = toolById(id)!;
    if (!artifacts.some((a) => a.path === tool.file)) {
      const after = artifacts.findIndex((a) => a.path === 'AGENTS.md');
      artifacts.splice(after + 1, 0, { path: tool.file, sections: ['agents-import'], enabled: true });
    }
    if (tool.commandFile && !artifacts.some((a) => a.path === tool.commandFile)) {
      artifacts.push({ path: tool.commandFile, sections: ['update-docs-command'], enabled: true });
    }
  }
  artifacts = artifacts.filter((a) => a.enabled !== false);

  const seen = new Set<string>();
  for (const a of artifacts) {
    const normalized = path.posix.normalize(a.path.replace(/\\/g, '/'));
    if (normalized.startsWith('../') || path.isAbsolute(a.path)) {
      throw new ConfigError(`artifacts: "${a.path}" must be a path inside the repository.`);
    }
    if (normalized.startsWith('.ctxkeep/')) throw new ConfigError(`artifacts: "${a.path}" is inside .ctxkeep/, which CtxKeep owns.`);
    if (seen.has(normalized)) throw new ConfigError(`artifacts: "${a.path}" is listed twice.`);
    seen.add(normalized);
    if (a.path.includes(MODULE_DIR_TOKEN) && !a.path.startsWith(`${MODULE_DIR_TOKEN}/`)) {
      throw new ConfigError(`artifacts: "${a.path}": ${MODULE_DIR_TOKEN} must start the path, e.g. ${MODULE_DIR_TOKEN}/AGENTS.md.`);
    }
    for (const name of a.sections ?? []) {
      if (!SECTIONS.has(name)) {
        throw new ConfigError(
          `artifacts: "${a.path}" lists unknown section "${name}". Available sections: ${[...SECTIONS.keys()].join(', ')}.`,
        );
      }
    }
  }
  return artifacts;
}

export interface ArtifactPlan {
  /** Concrete repo-relative path. */
  path: string;
  header: string | null;
  /** Regions this artifact must contain, in order. */
  desired: DesiredRegion[];
  /** Renders a region found on disk that isn't in `desired`: content, 'orphan' (remove), or null (unknown, leave alone). */
  resolve(id: string): string | 'orphan' | null;
  /** The module this per-module file was for no longer exists: delete the file if nothing human-written remains. */
  deleteWhenEmpty: boolean;
}

const GENERATED_NOTE = '<!-- Maintained by CtxKeep: text between ctxkeep:start/end markers is regenerated by `ctxkeep sync`; write anywhere else. -->';

function headerFor(artifact: ArtifactConfig): string {
  return artifact.title ? `# ${artifact.title}\n\n${GENERATED_NOTE}` : GENERATED_NOTE;
}

function modulesFor(model: ContextModel, artifact: ArtifactConfig): ModuleInfo[] {
  let mods = artifact.modules?.length
    ? model.modules.filter((m) => artifact.modules!.some((g) => moduleMatches(m.id, g)))
    : model.modules.filter((m) => !m.isTest);
  // A nested file for the root module would BE the root file (./AGENTS.md); never generate that from a template.
  if (artifact.path.includes(MODULE_DIR_TOKEN)) mods = mods.filter((m) => m.id !== ROOT_MODULE);
  return mods;
}

export interface PlanInput {
  rootDir: string;
  model: ContextModel;
  conventions: ConventionRow[];
  artifacts: ArtifactConfig[];
}

export function planArtifacts({ rootDir, model, conventions, artifacts }: PlanInput): ArtifactPlan[] {
  const refs = artifacts.map((a) => ({ path: a.path, sections: a.sections ?? [] }));
  const moduleById = new Map(model.modules.map((m) => [m.id, m]));
  const plans: ArtifactPlan[] = [];
  const fixedPaths = new Set(artifacts.filter((a) => !isTemplate(a.path)).map((a) => a.path));
  let markdownFiles: string[] | null = null; // listed lazily, only if a template needs orphan scanning

  for (const artifact of artifacts) {
    const ctx: RenderContext = { model, conventions, artifactPath: artifact.path, artifacts: refs };
    const allowed = modulesFor(model, artifact);
    const allowedIds = new Set(allowed.map((m) => m.id));

    // With a `sections` list, the list is authoritative: a known section that isn't listed is removed.
    // Without one, the artifact is in "fill mode": CtxKeep fills whatever markers the author placed.
    const fillMode = artifact.sections === undefined;

    const render = (id: string, ownModule: ModuleInfo | null, fileCtx: RenderContext): string | 'orphan' | null => {
      if (RETIRED_REGION_IDS.has(id)) return 'orphan';
      const { section: name, moduleId } = parseRegionId(id);
      const section = SECTIONS.get(name);
      if (!section) return null;
      if (!fillMode && !(artifact.sections ?? []).includes(name)) return 'orphan';
      if (section.scope === 'project') return moduleId === null ? section.render(fileCtx) : null;
      const target = moduleId ?? ownModule?.id ?? null;
      if (target === null) return null;
      const mod = moduleById.get(target);
      // A module section for a module that's gone (or now excluded) describes nothing real.
      if (!mod || (!ownModule && !allowedIds.has(target))) return 'orphan';
      return section.render(fileCtx, mod);
    };

    const build = (concrete: string, ownModule: ModuleInfo | null): ArtifactPlan => {
      const fileCtx: RenderContext = { ...ctx, artifactPath: concrete };
      const desired: DesiredRegion[] = [];
      for (const name of artifact.sections ?? []) {
        const section = SECTIONS.get(name)!;
        if (section.scope === 'project') desired.push({ id: name, content: section.render(fileCtx) });
        else if (ownModule) desired.push({ id: regionId(section, ownModule.id), content: section.render(fileCtx, ownModule) });
        else for (const mod of allowed) desired.push({ id: regionId(section, mod.id), content: section.render(fileCtx, mod) });
      }
      return {
        path: concrete,
        header: headerFor(artifact),
        desired,
        resolve: (id) => render(id, ownModule, fileCtx),
        deleteWhenEmpty: false,
      };
    };

    if (!isTemplate(artifact.path)) {
      plans.push(build(artifact.path, null));
      continue;
    }

    // One file per module, plus clean-up plans for files whose module is gone.
    const live = new Set<string>();
    for (const mod of allowed) {
      const concrete = concretePath(artifact.path, mod.id);
      if (fixedPaths.has(concrete)) continue; // an explicitly configured file always wins over a template
      live.add(concrete);
      plans.push(build(concrete, mod));
    }

    const pattern = templateRegex(artifact.path);
    markdownFiles ??= listRepoFiles(rootDir, { include: (p) => p.endsWith('.md') });
    for (const concrete of markdownFiles) {
      if (!pattern.test(concrete) || live.has(concrete) || fixedPaths.has(concrete)) continue;
      const text = fs.readFileSync(path.join(rootDir, concrete), 'utf8');
      if (!text.includes('ctxkeep:start:')) continue; // a human file that happens to match the pattern
      plans.push({
        path: concrete,
        header: headerFor(artifact),
        desired: [],
        // The module this file documented is gone: every generated region in it is orphaned.
        resolve: (id) => (SECTIONS.has(parseRegionId(id).section) || RETIRED_REGION_IDS.has(id) ? 'orphan' : null),
        deleteWhenEmpty: true,
      });
    }
  }

  return plans;
}

// ---------------------------------------------------------------------------
// Rendering plans against disk
// ---------------------------------------------------------------------------

export type ArtifactAction = 'create' | 'update' | 'delete' | 'unchanged' | 'error';

export interface ArtifactResult {
  path: string;
  action: ArtifactAction;
  before: string | null;
  /** Text to write; null for delete/unchanged/error. */
  after: string | null;
  outcomes: RegionOutcome[];
  error?: string;
  /** Regions on disk with ids CtxKeep doesn't recognise (left untouched). */
  unknownRegions: string[];
}

/** Computes every artifact's new text. Pure with respect to disk: reads, never writes. */
export function renderArtifacts(rootDir: string, plans: ArtifactPlan[], options: { force?: boolean } = {}): ArtifactResult[] {
  return plans.map((plan): ArtifactResult => {
    const absPath = path.join(rootDir, plan.path);
    const before = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null;
    const base = { path: plan.path, before, after: null, outcomes: [] as RegionOutcome[], unknownRegions: [] as string[] };

    try {
      const desired = [...plan.desired];
      const orphans = new Set<string>();
      if (before !== null) {
        const wanted = new Set(desired.map((d) => d.id));
        for (const region of parseRegions(before.replace(/\r\n/g, '\n'), plan.path)) {
          if (wanted.has(region.id)) continue;
          const resolved = plan.resolve(region.id);
          if (resolved === 'orphan') orphans.add(region.id);
          else if (resolved === null) base.unknownRegions.push(region.id);
          else desired.push({ id: region.id, content: resolved }); // a marker the user placed: fill it in place
        }
      }

      const out = applyRegions({
        fileLabel: plan.path,
        existing: before,
        desired,
        isOrphan: (id) => orphans.has(id),
        header: plan.header,
        force: options.force,
      });

      if (plan.deleteWhenEmpty && before !== null && out.text !== null && isOnlyBoilerplate(out.text, plan.header)) {
        return { ...base, action: 'delete', outcomes: out.outcomes };
      }
      if (!out.changed || out.text === null) return { ...base, action: 'unchanged', outcomes: out.outcomes };
      return { ...base, action: before === null ? 'create' : 'update', after: out.text, outcomes: out.outcomes };
    } catch (err) {
      return { ...base, action: 'error', error: (err as Error).message };
    }
  });
}

/**
 * Writes results atomically per file (temp file + rename), so an
 * interrupted run never leaves a half-written artifact behind.
 */
export function writeArtifacts(rootDir: string, results: ArtifactResult[]): void {
  for (const r of results) {
    const absPath = path.join(rootDir, r.path);
    if (r.action === 'delete') {
      fs.rmSync(absPath, { force: true });
      continue;
    }
    if ((r.action !== 'create' && r.action !== 'update') || r.after === null) continue;
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const tmp = `${absPath}.ctxkeep-${process.pid}.tmp`;
    fs.writeFileSync(tmp, r.after, 'utf8');
    fs.renameSync(tmp, absPath);
  }
}

/**
 * Every concrete artifact path for a config: fixed paths, plus templated
 * files that exist on disk or at HEAD (so `rollback` can restore a deleted one).
 */
export function listArtifactPaths(rootDir: string, artifacts: ArtifactConfig[]): string[] {
  const paths = new Set<string>(artifacts.filter((a) => !isTemplate(a.path)).map((a) => a.path));
  const templates = artifacts.filter((a) => isTemplate(a.path)).map((a) => templateRegex(a.path));
  if (templates.length === 0) return [...paths];

  const candidates = new Set(listRepoFiles(rootDir, { include: (p) => p.endsWith('.md') }));
  try {
    // Paths are relative to rootDir (git's default for ls-tree run in a subdirectory).
    const atHead = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '.'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
    for (const p of atHead.split('\0')) if (p.endsWith('.md')) candidates.add(p);
  } catch {
    // not a git repo, or no commits
  }
  for (const p of [...candidates].sort()) {
    if (templates.some((re) => re.test(p))) paths.add(p);
  }
  return [...paths];
}
