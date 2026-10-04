import path from 'node:path';
import { LANGUAGE_LABELS, PARSED_LANGUAGES, type Language } from '../analysis/languages';
import { moduleLabel, ROOT_MODULE } from '../analysis/modules';
import type { ContextModel, ModuleInfo, SymbolInfo } from '../analysis/model';
import type { ConventionRow } from '../graph/conventions';
import { toolForArtifact } from './agents';

/**
 * The section registry: every block of generated text CtxKeep can write,
 * keyed by name. An artifact is just a path plus an ordered list of these,
 * so a new kind of documentation is a new entry here (or a config change),
 * never a new CLI code path.
 *
 * Rules every section follows:
 * - Pure function of the ContextModel: no clocks, no randomness, stable
 *   ordering — the same code always renders byte-identical text.
 * - Only states what analysis can back up; says so when coverage is partial
 *   (e.g. symbols aren't indexed for Swift) instead of implying completeness.
 * - Always-loaded sections (AGENTS.md) avoid counts that change with every
 *   added file, so the file — and the agent's prompt cache — only changes on
 *   real structural change. Counts live in on-demand docs.
 */

export interface RenderContext {
  model: ContextModel;
  conventions: ConventionRow[];
  /** The artifact being rendered. */
  artifactPath: string;
  /** Every configured artifact (for cross-references between docs). */
  artifacts: { path: string; sections: string[] }[];
}

export interface SectionDef {
  name: string;
  /** `project`: one region per artifact. `module`: one region per module (`<name>:<module id>`). */
  scope: 'project' | 'module';
  summary: string;
  render(ctx: RenderContext, module?: ModuleInfo): string;
}

const MAX_LAYOUT_ROWS = 40;
const MAX_COMMANDS = 15;
const MAX_MODULE_SYMBOLS = 40;
const MAX_KEY_FILES = 10;
const MAX_ABSTRACTIONS = 20;
const MAX_DIAGRAM_EDGES = 60;

function langList(langs: Language[]): string {
  return langs.map((l) => LANGUAGE_LABELS[l]).join(', ');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function inlineCode(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sourceModules(model: ContextModel): ModuleInfo[] {
  return model.modules.filter((m) => !m.isTest);
}

function unparsedNote(model: ContextModel): string | null {
  const langs = model.languages.map(([l]) => l).filter((l) => !PARSED_LANGUAGES.has(l));
  if (langs.length === 0) return null;
  return `_${langList(langs)} files are tracked at file level only: their symbols and imports are not indexed._`;
}

/** Other configured artifacts that hold a given section — for "see X" pointers that are always true. */
function artifactsWith(ctx: RenderContext, sections: string[]): string[] {
  return ctx.artifacts
    .filter((a) => a.path !== ctx.artifactPath && !a.path.includes('{module}') && a.sections.some((s) => sections.includes(s)))
    .map((a) => a.path);
}

// ---------------------------------------------------------------------------
// Project sections
// ---------------------------------------------------------------------------

const overview: SectionDef = {
  name: 'overview',
  scope: 'project',
  summary: 'Project name, description, languages, and detected stack (with the manifest each fact came from).',
  render(ctx) {
    const { model } = ctx;
    const lines = [`# ${model.facts.name}`, ''];
    if (model.facts.description) lines.push(model.facts.description, '');

    const languages = model.languages.map(([l]) => LANGUAGE_LABELS[l]);
    lines.push(`- **Languages:** ${languages.length ? languages.join(', ') : '_no source files found_'}`);
    if (model.facts.stack.length > 0) {
      const bySource = new Map<string, string[]>();
      for (const item of model.facts.stack) bySource.set(item.source, [...(bySource.get(item.source) ?? []), item.label]);
      const stack = [...bySource.entries()].map(([source, labels]) => `${labels.join(', ')} (${inlineCode(source)})`);
      lines.push(`- **Stack:** ${stack.join('; ')}`);
    }

    const pointers: string[] = [];
    const arch = artifactsWith(ctx, ['architecture', 'key-files']);
    if (arch.length) pointers.push(`module dependencies and key files: ${arch.map((p) => inlineCode(p)).join(', ')}`);
    const index = artifactsWith(ctx, ['module', 'module-api']);
    if (index.length) pointers.push(`each module's public API: ${index.map((p) => inlineCode(p)).join(', ')}`);
    if (pointers.length) lines.push(`- **More context (read on demand):** ${pointers.join('; ')}`);

    lines.push(
      '',
      '_Sections between `ctxkeep` markers are generated from the code by CtxKeep and refreshed by `ctxkeep sync` — edit outside them._',
    );
    return lines.join('\n');
  },
};

/** The commands an agent reaches for first, in this order; everything else keeps its manifest order after them. */
const CORE_COMMANDS = ['install', 'dev', 'start', 'build', 'test', 'lint', 'typecheck', 'type-check', 'check', 'format'];

function rankCommands(cmds: ContextModel['facts']['commands']): ContextModel['facts']['commands'] {
  const rank = (command: string) => {
    // The task name is the last word: `npm run build`, `cd web && pnpm test`, `make lint`, `flutter test`.
    const name = command.split(/\s+/).pop() ?? '';
    const i = CORE_COMMANDS.indexOf(name);
    return i === -1 ? CORE_COMMANDS.length : i;
  };
  return cmds.map((cmd, i) => ({ cmd, i })).sort((a, b) => rank(a.cmd.command) - rank(b.cmd.command) || a.i - b.i).map((x) => x.cmd);
}

const commands: SectionDef = {
  name: 'commands',
  scope: 'project',
  summary: 'Runnable commands defined by the project (package.json scripts, Makefile targets).',
  render({ model }) {
    const lines = ['## Commands', ''];
    const cmds = rankCommands(model.facts.commands);
    if (cmds.length === 0) {
      lines.push('_No commands found: no package.json scripts, Makefile targets, or recognised toolchain manifest._');
      return lines.join('\n');
    }
    for (const cmd of cmds.slice(0, MAX_COMMANDS)) {
      if (cmd.runs) lines.push(`- ${inlineCode(cmd.command)} — runs ${inlineCode(truncate(cmd.runs, 90))}`);
      else if (cmd.note) lines.push(`- ${inlineCode(cmd.command)} — ${cmd.note} (${inlineCode(cmd.source)})`);
      else lines.push(`- ${inlineCode(cmd.command)}`);
    }
    if (cmds.length > MAX_COMMANDS) lines.push(`- …and ${cmds.length - MAX_COMMANDS} more (see ${[...new Set(cmds.map((c) => c.source))].join(', ')})`);
    return lines.join('\n');
  },
};

const layout: SectionDef = {
  name: 'layout',
  scope: 'project',
  summary: 'Where things live: one row per module with its languages and (human-written) description.',
  render(ctx) {
    const { model } = ctx;
    const lines = ['## Layout', ''];
    if (model.modules.length === 0) {
      lines.push('_No source files found._');
      return lines.join('\n');
    }
    // The description column only appears once some module has a human-written description to show.
    const withDescriptions = model.modules.some((m) => !m.isTest && m.description);
    lines.push(
      withDescriptions ? '| Path | Kind | Languages | Description |' : '| Path | Kind | Languages |',
      withDescriptions ? '|---|---|---|---|' : '|---|---|---|',
    );
    for (const mod of model.modules.slice(0, MAX_LAYOUT_ROWS)) {
      const cells = [inlineCode(mod.label), mod.isTest ? 'tests' : 'source', langList(mod.languages.map(([l]) => l))];
      if (withDescriptions) cells.push(escapeCell(mod.description ?? ''));
      lines.push(`| ${cells.join(' | ')} |`);
    }
    if (model.modules.length > MAX_LAYOUT_ROWS) {
      lines.push('', `_…and ${model.modules.length - MAX_LAYOUT_ROWS} more modules._`);
    }
    return lines.join('\n');
  },
};

const conventions: SectionDef = {
  name: 'conventions',
  scope: 'project',
  summary: 'Conventions a human confirmed via `ctxkeep review conventions` that still hold in the code.',
  render({ conventions: rows }) {
    const lines = ['## Conventions', ''];
    if (rows.length === 0) {
      lines.push('_None confirmed yet. Run `ctxkeep review conventions` to confirm detected patterns._');
      return lines.join('\n');
    }
    // The same rule confirmed for several modules is stated once, listing the modules,
    // rather than once per module in an always-loaded file.
    const groups = new Map<string, ConventionRow[]>();
    for (const c of rows) {
      const key = `${c.patternType}\0${c.value}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const token = (moduleId: string) => (moduleId === ROOT_MODULE ? 'the repository root' : `\`${moduleId}/\``);
      if (group.length > 1 && group.every((c) => c.statement === first.statement.replace(token(first.moduleId), token(c.moduleId)))) {
        const names = group.map((c) => token(c.moduleId));
        const list = names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
        lines.push(`- ${first.statement.replace(token(first.moduleId), list)}`);
      } else {
        for (const c of group) lines.push(`- ${c.statement}`);
      }
    }
    return lines.join('\n');
  },
};

const agentsImport: SectionDef = {
  name: 'agents-import',
  scope: 'project',
  summary: "Pointer for tools that don't read AGENTS.md natively: imports it using the tool's own syntax (CLAUDE.md, GEMINI.md).",
  render(ctx) {
    const canonical = ctx.artifacts.find((a) => a.path !== ctx.artifactPath && a.sections.includes('overview'))?.path ?? 'AGENTS.md';
    const target = path.posix.relative(path.posix.dirname(ctx.artifactPath), canonical);
    const tool = toolForArtifact(ctx.artifactPath);
    const importLine = tool ? tool.importLine(target) : `@${target}`;
    return [importLine, '', `_Project context lives in ${inlineCode(canonical)}, shared by every coding agent; edit that file, not this one._`].join('\n');
  },
};

const agentWorkflow: SectionDef = {
  name: 'agent-workflow',
  scope: 'project',
  summary: 'Tells every coding agent how to keep the docs true: run `ctxkeep sync`, then `ctxkeep check`, and fix what it reports.',
  render({ model }) {
    const ck = model.ctxkeepCommand;
    return [
      '## Keeping these docs true',
      '',
      `- After changing code, run \`${ck} sync\` (refreshes the generated sections), then \`${ck} check\`.`,
      `- \`${ck} check\` lists hand-written statements that no longer match the code — commands, paths, links, or code names that don't exist. Fix that text to match the code. \`${ck} check --json\` gives the same list as file/line/suggestion.`,
      '- Never edit between `ctxkeep:start` / `ctxkeep:end` markers; those sections are regenerated.',
      `- All commands: \`${ck} --help\`.`,
    ].join('\n');
  },
};

const updateDocsCommand: SectionDef = {
  name: 'update-docs-command',
  scope: 'project',
  summary: 'Body of an agent slash command (e.g. Claude Code `/update-docs`) that fixes doc drift.',
  render({ model }) {
    const ck = model.ctxkeepCommand;
    return [
      "Bring this project's documentation back in line with the code.",
      '',
      `1. Run \`${ck} sync\` to refresh the generated sections.`,
      `2. Run \`${ck} check --json\` and read the \`drift\` list. Each entry has a file, a line, what is wrong, and sometimes a suggestion.`,
      '3. For each entry, fix the hand-written text at that location so it matches the code. Use the suggestion when it is right; read the code when unsure. If a reference is intentionally hypothetical, add `<!-- ctxkeep-ignore -->` to that line instead.',
      '4. Never edit between `ctxkeep:start` / `ctxkeep:end` markers.',
      `5. Run \`${ck} check\` again until it reports nothing, then summarize what you changed.`,
    ].join('\n');
  },
};

function edgeList(edges: { moduleId: string; weight: number }[]): string {
  return edges.length ? edges.map((e) => `${inlineCode(moduleLabel(e.moduleId))} (${e.weight})`).join(', ') : '—';
}

function mermaidId(moduleId: string): string {
  return `m_${moduleId.replace(/[^A-Za-z0-9]/g, '_')}`;
}

const architecture: SectionDef = {
  name: 'architecture',
  scope: 'project',
  summary: 'Module dependency graph derived from resolved local imports (Mermaid diagram + table with counts).',
  render({ model }) {
    const lines = ['## Module dependencies', ''];
    const mods = sourceModules(model);
    const edges = mods.flatMap((m) => m.dependsOn.map((e) => ({ from: m.id, to: e.moduleId, weight: e.weight })));

    lines.push(
      `Derived from ${plural(model.resolvedImportCount, 'resolved local import')} between source files ` +
        '(test files excluded). A count is the number of distinct file-to-file imports behind the edge.',
      '',
    );

    if (edges.length > 0 && edges.length <= MAX_DIAGRAM_EDGES) {
      lines.push('```mermaid', 'graph LR');
      const used = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
      for (const id of used) lines.push(`  ${mermaidId(id)}["${moduleLabel(id)}"]`);
      for (const e of edges) lines.push(`  ${mermaidId(e.from)} --> ${mermaidId(e.to)}`);
      lines.push('```', '');
    } else if (edges.length === 0) {
      lines.push('_No imports between modules were found._', '');
    }

    lines.push('| Module | Files | Depends on | Used by |', '|---|---|---|---|');
    for (const m of mods) {
      lines.push(`| ${inlineCode(m.label)} | ${m.files.filter((f) => !f.isTest).length} | ${edgeList(m.dependsOn)} | ${edgeList(m.usedBy)} |`);
    }
    if (model.testFileCount > 0) lines.push('', `_Plus ${plural(model.testFileCount, 'test/fixture file')}, not shown._`);
    const note = unparsedNote(model);
    if (note) lines.push('', note);
    return lines.join('\n');
  },
};

const keyFiles: SectionDef = {
  name: 'key-files',
  scope: 'project',
  summary: 'Declared entry points (package.json bin/main, pyproject scripts) and the most-imported source files.',
  render({ model }) {
    const lines = ['## Key files', ''];
    if (model.facts.entryPoints.length > 0) {
      lines.push('Entry points declared in manifests:', '');
      for (const e of model.facts.entryPoints) lines.push(`- ${inlineCode(e.name)} → ${inlineCode(e.target)} (${e.source})`);
      lines.push('');
    }
    const central = model.files
      .filter((f) => !f.isTest && f.importedBy >= 2)
      .sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path))
      .slice(0, MAX_KEY_FILES);
    if (central.length > 0) {
      lines.push('Most-imported source files (change these with care):', '', '| File | Imported by |', '|---|---|');
      for (const f of central) lines.push(`| ${inlineCode(f.path)} | ${plural(f.importedBy, 'file')} |`);
    } else if (model.facts.entryPoints.length === 0) {
      lines.push('_No declared entry points, and no file is imported by more than one other file._');
    }
    return lines.join('\n').trimEnd();
  },
};

const ABSTRACTION_KINDS = new Set(['class', 'interface', 'type', 'enum']);

const keyAbstractions: SectionDef = {
  name: 'key-abstractions',
  scope: 'project',
  summary: 'The most-referenced exported classes, interfaces, types, and enums — the core domain model.',
  render({ model }) {
    const lines = ['## Key abstractions', ''];
    const symbols = model.files
      .filter((f) => !f.isTest)
      .flatMap((f) => f.symbols.filter((s) => s.exported && ABSTRACTION_KINDS.has(s.kind)))
      .sort((a, b) => b.refCount - a.refCount || a.filePath.localeCompare(b.filePath) || a.ordinal - b.ordinal)
      .slice(0, MAX_ABSTRACTIONS);
    if (symbols.length === 0) {
      lines.push('_No exported classes, interfaces, types, or enums found in indexed languages._');
      return lines.join('\n');
    }
    lines.push('| Name | Kind | Defined in | Imported by |', '|---|---|---|---|');
    for (const s of symbols) {
      lines.push(`| ${inlineCode(s.name)} | ${s.kind} | ${inlineCode(s.filePath)} | ${s.refCount ? plural(s.refCount, 'file') : '—'} |`);
    }
    return lines.join('\n');
  },
};

// ---------------------------------------------------------------------------
// Module sections
// ---------------------------------------------------------------------------

function moduleHeader(mod: ModuleInfo, level: string): string[] {
  const lines = [`${level} ${inlineCode(mod.label)}`, ''];
  if (mod.description) lines.push(mod.description, '');
  const sourceCount = mod.files.filter((f) => !f.isTest).length;
  const testCount = mod.files.length - sourceCount;
  const counts = mod.isTest ? plural(testCount, 'test/fixture file') : `${plural(sourceCount, 'file')}${testCount ? ` + ${testCount} test` : ''}`;
  lines.push(`${langList(mod.languages.map(([l]) => l))} · ${counts}`);
  return lines;
}

function moduleDeps(mod: ModuleInfo): string[] {
  if (mod.isTest) return [];
  return [`- Depends on: ${edgeList(mod.dependsOn)}`, `- Used by: ${edgeList(mod.usedBy)}`];
}

function symbolLine(s: SymbolInfo): string {
  const refs = s.refCount ? ` · imported by ${plural(s.refCount, 'file')}` : '';
  const name = s.isDefault && s.name !== 'default' ? `${s.name} (default)` : s.name;
  return `- ${inlineCode(name)} ${s.kind} — ${inlineCode(s.filePath)}${refs}`;
}

function moduleApi(mod: ModuleInfo): string[] {
  if (mod.isTest) return ['_Test code: symbols are not indexed._'];
  const lines: string[] = [];
  const symbols = mod.publicSymbols;
  if (symbols.length > 0) {
    lines.push(...symbols.slice(0, MAX_MODULE_SYMBOLS).map(symbolLine));
    if (symbols.length > MAX_MODULE_SYMBOLS) lines.push(`- …and ${symbols.length - MAX_MODULE_SYMBOLS} more exported symbols`);
  } else if (mod.languages.some(([l]) => l === 'dart')) {
    lines.push('_No public top-level types (for Dart, only classes, mixins, enums, and typedefs are indexed)._');
  } else if (mod.languages.some(([l]) => PARSED_LANGUAGES.has(l))) {
    lines.push('_No exported symbols._');
  }
  if (mod.unparsedLanguages.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`_${langList(mod.unparsedLanguages)} files here are tracked at file level only (symbols not indexed)._`);
  }
  return lines;
}

const moduleCard: SectionDef = {
  name: 'module',
  scope: 'module',
  summary: 'Per-module card: description, size, dependencies, and exported symbols.',
  render(_ctx, mod) {
    return [...moduleHeader(mod!, '##'), '', ...moduleDeps(mod!), ...(mod!.isTest ? [] : ['']), ...moduleApi(mod!)].join('\n').trimEnd();
  },
};

const moduleSummary: SectionDef = {
  name: 'module-summary',
  scope: 'module',
  summary: 'Per-module heading, description, size, and dependencies (no symbol list).',
  render(_ctx, mod) {
    return [...moduleHeader(mod!, '#'), ...(mod!.isTest ? [] : ['', ...moduleDeps(mod!)])].join('\n');
  },
};

const moduleApiSection: SectionDef = {
  name: 'module-api',
  scope: 'module',
  summary: "Per-module list of exported symbols, most-imported first.",
  render(_ctx, mod) {
    return ['## Public API', '', ...moduleApi(mod!)].join('\n');
  },
};

const moduleFiles: SectionDef = {
  name: 'module-files',
  scope: 'module',
  summary: 'Per-module file list with each file\'s own doc-comment summary, when it has one.',
  render(_ctx, mod) {
    const lines = ['## Files', ''];
    for (const f of mod!.files) {
      lines.push(`- ${inlineCode(f.path)}${f.isTest ? ' (test)' : ''}${f.docSummary ? ` — ${f.docSummary}` : ''}`);
    }
    return lines.join('\n');
  },
};

export const SECTIONS: ReadonlyMap<string, SectionDef> = new Map(
  [overview, commands, layout, conventions, agentWorkflow, agentsImport, updateDocsCommand, architecture, keyFiles, keyAbstractions, moduleCard, moduleSummary, moduleApiSection, moduleFiles].map(
    (s) => [s.name, s],
  ),
);

/** Region ids are `<section>` for project sections and `<section>:<module id>` for module sections. */
export function parseRegionId(id: string): { section: string; moduleId: string | null } {
  const colon = id.indexOf(':');
  return colon === -1 ? { section: id, moduleId: null } : { section: id.slice(0, colon), moduleId: id.slice(colon + 1) };
}

export function regionId(section: SectionDef, moduleId?: string): string {
  return section.scope === 'module' ? `${section.name}:${moduleId ?? ROOT_MODULE}` : section.name;
}
