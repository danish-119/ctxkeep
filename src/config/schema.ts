import { z } from 'zod';
import { POINTER_TOOL_IDS } from '../artifacts/agents';

/**
 * .ctxkeep/config.yaml. Every field here is read by the CLI — an unread
 * config field is a lie about what the tool does. `.strict()` turns a typo
 * like `artifact:` into an error instead of a silently ignored setting.
 */

export const ArtifactConfigSchema = z
  .object({
    /** Repo-relative path. May contain `{module}` to produce one file per module (e.g. `docs/modules/{module}.md`). */
    path: z.string().min(1),
    /**
     * Sections to keep present, in order (new ones are appended). Omit to
     * manage ONLY the markers you place in the file yourself — the way to
     * embed generated facts in a hand-written DESIGN.md without CtxKeep
     * deciding its structure.
     */
    sections: z.array(z.string().min(1)).optional(),
    /** Module-id globs limiting which modules per-module sections/files cover, e.g. `["src/*"]`. */
    modules: z.array(z.string().min(1)).optional(),
    /** Heading written once when CtxKeep creates the file (human-owned afterwards). */
    title: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export const ConfigSchema = z
  .object({
    version: z.number().int().optional(),
    /**
     * Agent tools that DON'T read AGENTS.md natively and need a pointer file importing it:
     * `claude` → CLAUDE.md, `gemini` → GEMINI.md. Codex, Cursor, Copilot, Windsurf, Zed, Cline, …
     * read AGENTS.md directly and need nothing. Omit to auto-detect from the repo (CLAUDE.md/.claude, GEMINI.md/.gemini).
     */
    agents: z.array(z.enum(POINTER_TOOL_IDS)).optional(),
    /** v0.1 field, still honoured when `agents` is absent: `adapters.claude.enabled` adds or drops CLAUDE.md. */
    adapters: z.object({ claude: z.object({ enabled: z.boolean().default(true) }).strict() }).strict().optional(),
    /** Module overrides: folder globs that define module boundaries; everything else is inferred. */
    modules: z
      .array(z.object({ path: z.string().min(1), name: z.string().optional() }).strict())
      .default([]),
    /** Extra gitignore-syntax patterns excluded from analysis. */
    ignore: z.array(z.string()).default([]),
    /** Artifacts to maintain. Omit to use the defaults (AGENTS.md, CLAUDE.md, ARCHITECTURE.md, .ai/manifest.md). */
    artifacts: z.array(ArtifactConfigSchema).optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ArtifactConfig = z.infer<typeof ArtifactConfigSchema>;
