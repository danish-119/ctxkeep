import fs from 'node:fs';
import path from 'node:path';

/**
 * Tool-agnostic agent context. AGENTS.md is the one canonical file: it's
 * read natively by Codex, Cursor, GitHub Copilot, Windsurf, Zed, Cline,
 * Jules, Aider (via config), and many more. Only tools that DON'T read it
 * natively get a pointer file — a single import line, never a copy, so no
 * tool can see a different version of the truth.
 *
 * Adding a tool is one entry here; nothing else in CtxKeep is tool-specific.
 */

export interface AgentTool {
  id: string;
  label: string;
  /** The instruction file the tool reads by default. */
  file: string;
  /** The tool's own import syntax for pulling in another markdown file. */
  importLine(target: string): string;
  /** Repo paths whose presence shows the project already uses this tool. */
  evidence: string[];
}

export const POINTER_TOOLS: AgentTool[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    file: 'CLAUDE.md',
    importLine: (target) => `@${target}`, // Claude Code memory imports: `@path`
    evidence: ['CLAUDE.md', '.claude'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    file: 'GEMINI.md',
    importLine: (target) => `@./${target}`, // Gemini CLI memory import processor: `@./path`
    evidence: ['GEMINI.md', '.gemini'],
  },
];

/** Tools documented to read AGENTS.md directly — listed in `init` output, no file needed. */
export const NATIVE_AGENTS_MD_TOOLS = ['Codex', 'Cursor', 'GitHub Copilot', 'Windsurf', 'Zed', 'Cline', 'Jules', 'Amp'];

export const POINTER_TOOL_IDS = POINTER_TOOLS.map((t) => t.id) as [string, ...string[]];

export function toolById(id: string): AgentTool | undefined {
  return POINTER_TOOLS.find((t) => t.id === id);
}

export function toolForArtifact(artifactPath: string): AgentTool | undefined {
  return POINTER_TOOLS.find((t) => t.file === path.posix.basename(artifactPath));
}

/** Pointer tools this repo already shows signs of using. */
export function detectPointerTools(rootDir: string): string[] {
  return POINTER_TOOLS.filter((t) => t.evidence.some((e) => fs.existsSync(path.join(rootDir, e)))).map((t) => t.id);
}

/** Tool-specific rule files that coexist with AGENTS.md — worth knowing about, never touched. */
export const OTHER_RULE_FILES = [
  '.cursorrules',
  '.cursor/rules',
  '.windsurfrules',
  '.windsurf/rules',
  '.clinerules',
  '.github/copilot-instructions.md',
  '.github/instructions',
  '.junie/guidelines.md',
  '.rules',
];
