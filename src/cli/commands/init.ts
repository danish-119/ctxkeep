import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { listSourceFiles } from '../../analysis/walker';
import { createModuleResolver, isTestPath } from '../../analysis/modules';
import { languageForPath, LANGUAGE_LABELS, type Language } from '../../analysis/languages';
import { detectAllFacts, findProjectRoots } from '../../analysis/projects';
import { configExists, configPath, ensureCtxkeepGitignore, writeConfigText } from '../../config/io';
import { SECTIONS } from '../../artifacts/sections';
import { detectPointerTools, NATIVE_AGENTS_MD_TOOLS, OTHER_RULE_FILES, toolById } from '../../artifacts/agents';

/** Hand-written human docs that, if present, are added in fill mode (CtxKeep only touches markers you add). */
const FILL_MODE_CANDIDATES = ['DESIGN.md', 'docs/DESIGN.md', 'docs/design.md', 'docs/architecture.md'];

export function buildConfigTemplate(fillModeDocs: string[], agents: string[]): string {
  const sectionNames = [...SECTIONS.keys()];
  const sectionLines: string[] = [];
  let line = '#  ';
  for (const name of sectionNames) {
    if (line.length + name.length > 90) {
      sectionLines.push(line.trimEnd());
      line = '#  ';
    }
    line += ` ${name},`;
  }
  sectionLines.push(line.replace(/,$/, ''));

  const fillDocs = fillModeDocs.length
    ? fillModeDocs.map((p) => `  - path: ${p}            # hand-written: CtxKeep only fills markers you add\n`).join('')
    : '';

  const agentList = agents.length ? `[${agents.join(', ')}]` : '[]';
  return `# CtxKeep configuration. Commit this file; .ctxkeep/graph.sqlite is a regenerable cache.
version: 2

# AGENTS.md is the single source of truth for every coding agent. It is read natively by
# ${NATIVE_AGENTS_MD_TOOLS.join(', ')}, and others.
# Tools that don't read it get a one-line pointer file that imports it:
#   claude -> CLAUDE.md (@AGENTS.md)     gemini -> GEMINI.md (@./AGENTS.md)
# Detected from this repo: ${agentList}. Remove this line to re-detect on every run.
agents: ${agentList}

# Documentation CtxKeep keeps in sync with the code. Each artifact is a path plus an
# ordered list of sections; only the regions between ctxkeep markers are ever rewritten.
# Available sections:
${sectionLines.join('\n')}
# Leave out \`sections\` to have CtxKeep fill ONLY the markers you place yourself, e.g.
#   <!-- ctxkeep:start:key-abstractions -->
#   <!-- ctxkeep:end:key-abstractions -->
artifacts:
  - path: AGENTS.md          # canonical, always-loaded agent context
    sections: [overview, commands, layout, conventions, agent-workflow]
  - path: ARCHITECTURE.md    # module dependency graph + key files
    title: Architecture
    sections: [architecture, key-files]
  - path: .ai/manifest.md    # on-demand index of every module's public API
    title: Module index
    sections: [module]
${fillDocs}  # One design doc per module:
  # - path: docs/modules/{module}.md
  #   modules: ["src/*"]
  #   sections: [module-summary, module-api, module-files]
  # Nested AGENTS.md per module (scoped context for Codex, Cursor, Copilot, Cline, ...):
  # - path: "{module_dir}/AGENTS.md"
  #   modules: ["src/*"]
  #   sections: [module-summary, module-api]

# Module boundaries are inferred from folders (src/<name>, packages/<name>, lib/<name>, ...).
# Override them where that's wrong; the first matching entry wins.
modules: []
#  - path: src/features/*     # one module per feature folder
#  - path: src/legacy/**      # everything under src/legacy is one module

# Extra paths to exclude, gitignore syntax (.gitignore is already honoured).
ignore: []
`;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffolds .ctxkeep/config.yaml (artifacts, module overrides, ignores) for this repo.')
    .argument('[path]', 'path to the repo', '.')
    .option('--force', 'overwrite an existing config.yaml (discards manual edits)', false)
    .action((targetPathArg: string, options: { force: boolean }) => {
      const targetDir = path.resolve(targetPathArg);
      if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        console.error(`error: ${targetDir} is not a directory`);
        process.exitCode = 1;
        return;
      }

      const relConfigPath = path.relative(targetDir, configPath(targetDir)).split(path.sep).join('/');
      if (configExists(targetDir) && !options.force) {
        console.error(`${relConfigPath} already exists — refusing to overwrite.`);
        console.error('Re-run with --force to regenerate it (this discards any manual edits).');
        process.exitCode = 1;
        return;
      }

      const files = listSourceFiles(targetDir);
      const projectRoots = findProjectRoots(targetDir);
      const facts = detectAllFacts(targetDir, projectRoots);
      const fillDocs = FILL_MODE_CANDIDATES.filter((p) => fs.existsSync(path.join(targetDir, p)));

      const agents = detectPointerTools(targetDir);
      writeConfigText(targetDir, buildConfigTemplate(fillDocs, agents));
      const wroteIgnore = ensureCtxkeepGitignore(targetDir);

      const languages = new Map<Language, number>();
      for (const f of files.filter((p) => !isTestPath(p))) {
        const lang = languageForPath(f)!;
        languages.set(lang, (languages.get(lang) ?? 0) + 1);
      }
      const moduleOf = createModuleResolver(files, [], projectRoots);
      const modules = new Set(files.map(moduleOf));
      const langSummary = [...languages.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([l]) => LANGUAGE_LABELS[l])
        .join(', ');

      console.log(`Wrote ${relConfigPath}${wroteIgnore ? ' and .ctxkeep/.gitignore' : ''}`);
      console.log(`Detected ${files.length} source file(s) in ${modules.size} module(s): ${langSummary || 'no recognised source files'}.`);
      if (facts.stack.length) console.log(`Stack: ${facts.stack.map((s) => s.label).join(', ')}.`);
      console.log(
        `Agent files: AGENTS.md (read natively by ${NATIVE_AGENTS_MD_TOOLS.slice(0, 5).join(', ')}, ...)` +
          (agents.length
            ? ` + ${agents.map((a) => toolById(a)!.file).join(', ')} pointing to it (detected ${agents.map((a) => toolById(a)!.label).join(', ')}).`
            : '. Using Claude Code or Gemini CLI? Add `agents: [claude]` or `[gemini]` to the config.'),
      );
      const otherRules = OTHER_RULE_FILES.filter((p) => fs.existsSync(path.join(targetDir, p)));
      if (otherRules.length) {
        console.log(`Found tool-specific rules (${otherRules.join(', ')}): left untouched; those tools read them alongside AGENTS.md.`);
      }
      for (const doc of fillDocs) console.log(`Found ${doc} — added in fill mode (CtxKeep only fills markers you place in it).`);
      if (fs.existsSync(path.join(targetDir, 'ARCHITECTURE.md'))) {
        console.log('Found ARCHITECTURE.md — generated sections will be appended below your text (edit config to change).');
      }
      console.log('Next: `ctxkeep analyze --dry-run` to review the output, then `ctxkeep analyze` to write it.');
    });
}
