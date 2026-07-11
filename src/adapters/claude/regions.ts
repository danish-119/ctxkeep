import { hasSrcRoot, moduleNameForRelPath } from '../../analysis/modules';
import type { Language } from '../../analysis/types';
import type { ConventionRow } from '../../graph/conventions';

export interface CompiledRegion {
  /** Repo-relative path of the artifact this region belongs to, e.g. "CLAUDE.md" or ".ai/manifest.md". */
  artifactRelPath: string;
  regionId: string;
  content: string;
}

/**
 * Deliberately narrower than `AnalysisResult` — only the fields these region
 * builders actually read. `ctxkeep analyze`'s full AnalysisResult satisfies
 * this structurally with no changes needed, and `ctxkeep sync` (build spec
 * §4 Milestone 4) can build one of these by mixing freshly-parsed data for stale
 * modules with data read back from the graph for untouched ones, without
 * needing a full ParsedSymbol (span/hash) for content it isn't re-parsing.
 */
export interface RegionSymbolInput {
  kind: string;
  name: string;
}

export interface RegionFileInput {
  relPath: string;
  symbols: RegionSymbolInput[];
}

export interface RegionModuleInput {
  name: string;
  fileCount: number;
  languages: Language[];
}

export interface RegionInput {
  projectName: string;
  languagesPresent: Language[];
  modules: RegionModuleInput[];
  parsedFiles: RegionFileInput[];
}

const LANGUAGE_LABELS: Record<Language, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
};

function languageLabel(languages: Language[]): string {
  return languages.length ? languages.map((l) => LANGUAGE_LABELS[l]).join(', ') : 'no Tier-1 languages detected';
}

function filesForModule(files: RegionFileInput[], moduleName: string, srcRooted: boolean): RegionFileInput[] {
  return files.filter((f) => moduleNameForRelPath(f.relPath, srcRooted) === moduleName);
}

function overviewContent(result: RegionInput): string {
  return [
    `# ${result.projectName}`,
    '',
    `${result.projectName} is a ${languageLabel(result.languagesPresent)} project with ${result.parsedFiles.length} ` +
      `source file(s) across ${result.modules.length} top-level module(s).`,
  ].join('\n');
}

function modulesListContent(result: RegionInput): string {
  const lines = ['## Modules', ''];
  if (result.modules.length === 0) {
    lines.push('_No Tier-1 source files (.ts/.tsx/.js/.py) were found._');
  } else {
    for (const mod of result.modules) {
      lines.push(`- **${mod.name}/** — ${mod.fileCount} file(s) (${languageLabel(mod.languages)})`);
    }
  }
  return lines.join('\n');
}

function moduleDetailContent(moduleName: string, moduleFiles: RegionFileInput[]): string {
  const lines = [`### ${moduleName}/`, ''];
  const symbolLines: string[] = [];

  for (const file of moduleFiles) {
    for (const sym of file.symbols) {
      symbolLines.push(`- \`${sym.name}\` (${sym.kind}) — ${file.relPath}`);
    }
  }

  if (symbolLines.length === 0) {
    lines.push('_No top-level functions, classes, or exports detected in this module._');
  } else {
    lines.push(...symbolLines);
  }

  return lines.join('\n');
}

/**
 * CLAUDE.md gets the full treatment (overview + module list + one region per
 * module with its full symbol list) — Claude is the reference-implementation
 * adapter (architecture plan §19). No token-budget truncation yet: that's
 * scored/ranked pruning from a later phase, not Milestone 3 scope; large modules
 * will currently produce long, untruncated lists.
 */
export function buildClaudeRegions(result: RegionInput): CompiledRegion[] {
  const srcRooted = hasSrcRoot(result.parsedFiles);
  const regions: CompiledRegion[] = [
    { artifactRelPath: 'CLAUDE.md', regionId: 'overview', content: overviewContent(result) },
    { artifactRelPath: 'CLAUDE.md', regionId: 'modules', content: modulesListContent(result) },
  ];

  for (const mod of result.modules) {
    const moduleFiles = filesForModule(result.parsedFiles, mod.name, srcRooted);
    regions.push({
      artifactRelPath: 'CLAUDE.md',
      regionId: `module:${mod.name}`,
      content: moduleDetailContent(mod.name, moduleFiles),
    });
  }

  return regions;
}

/** AGENTS.md stays compact (cross-tool lowest-common-denominator, size discipline) — overview + module list only, no per-module detail regions. */
export function buildAgentsRegions(result: RegionInput): CompiledRegion[] {
  return [
    { artifactRelPath: 'AGENTS.md', regionId: 'overview', content: overviewContent(result) },
    { artifactRelPath: 'AGENTS.md', regionId: 'modules', content: modulesListContent(result) },
  ];
}

/**
 * .ai/manifest.md — deliberately does NOT claim git-verified checkpoints yet.
 * `checkpoints` stays empty until Milestone 4 wires up git-diff-based change
 * detection; showing a fabricated SHA here would be dishonest about what's
 * actually verified (architecture plan §34's per-feature honesty principle).
 *
 * Also deliberately has NO wall-clock "last analyzed" timestamp: a per-run
 * timestamp would change on every `ctxkeep analyze` regardless of whether
 * any fact actually changed, which directly breaks the NO_OP/minimal-diff
 * guarantee patchRegion exists to provide (build spec §5's "run twice, zero
 * diff" property). Real verification timestamps arrive in Milestone 4 tied to a
 * git SHA, which only changes when the repo actually changes.
 */
export function buildManifestRegions(result: RegionInput): CompiledRegion[] {
  const srcRooted = hasSrcRoot(result.parsedFiles);
  const lines = ['# Verification Manifest', '', '| Module | Files | Symbols |', '|---|---|---|'];

  for (const mod of result.modules) {
    const symbolCount = filesForModule(result.parsedFiles, mod.name, srcRooted).reduce(
      (sum, f) => sum + f.symbols.length,
      0,
    );
    lines.push(`| ${mod.name} | ${mod.fileCount} | ${symbolCount} |`);
  }

  lines.push('');
  lines.push(
    '_Git-based checkpointing (module → verified commit SHA, verified-at date) is not wired up yet — ' +
      'arrives with change detection in Milestone 4. This manifest currently reflects module/symbol facts from ' +
      'the last `ctxkeep analyze` run only, with no timestamp (a wall-clock time here would defeat the ' +
      'no-op/minimal-diff guarantee — see compiler/patchRegion.ts)._',
  );

  return [{ artifactRelPath: '.ai/manifest.md', regionId: 'modules', content: lines.join('\n') }];
}

/**
 * CLAUDE.md's `conventions` region — populated only with status='confirmed'
 * rows (build spec §4 Milestone 5). Always emitted (with a placeholder when
 * empty) rather than omitted, consistent with how every other "nothing
 * detected yet" case in this file is already handled. This is intentionally
 * separate from RegionInput/buildClaudeRegions: it's the one region whose
 * content depends on human review decisions in the graph, not on the
 * analysis snapshot alone.
 */
export function buildConventionsRegion(confirmed: ConventionRow[]): CompiledRegion {
  const lines = ['## Conventions', ''];

  if (confirmed.length === 0) {
    lines.push('_No confirmed conventions yet — run `ctxkeep review conventions` to review detected patterns._');
  } else {
    for (const c of [...confirmed].sort((a, b) => b.confidence - a.confidence)) {
      lines.push(`- ${c.statement} (confidence: ${Math.round(c.confidence * 100)}%)`);
    }
  }

  return { artifactRelPath: 'CLAUDE.md', regionId: 'conventions', content: lines.join('\n') };
}
