# CtxKeep
### The AI Context Operating System — a Claude Code–first, adapter-based architecture for keeping AI coding assistants permanently in sync with a living codebase

> **Revision note (2026-10-04, v0.2).** This is the long-term vision document, kept as written. The shipped implementation deliberately diverges from it in these places; `DECISIONS.md` has the reasoning for each:
>
> - **Tool-agnostic, not Claude-first.** By 2026, `AGENTS.md` is read natively by Codex, Cursor, Copilot, Windsurf, Zed, Cline, and others, so it is the canonical output. Claude Code and Gemini CLI get a one-line pointer file (`@AGENTS.md`) instead of their own compiled copy (affects §1, §2, §18, §19).
> - **Change detection uses content hashes of the working tree,** not `git diff <checkpoint>..HEAD` (§13, §25). There is no `Checkpoint` table.
> - **Each region's integrity hash lives in its own marker** (`<!-- ctxkeep:start:id sha=… -->`), not in an `ArtifactBinding` table, so safety works on any clone without local state (§9, §16).
> - **Adapters are config-driven artifacts built from a section registry**, not Reader/Writer plugins (§17, §18). Documentation beyond agent context (`ARCHITECTURE.md`, per-module docs, embedded regions in a hand-written `DESIGN.md`) is in scope.
> - **"Token budgets" are fixed caps,** and always-loaded files carry no counts so they change only on structural change (§16). Scored pruning has not been built.
>
> For how the current system works, see [`how-it-works.md`](how-it-works.md). For configuration, see [`configuration.md`](configuration.md).

---

## Executive Summary

Every AI coding assistant today re-derives its understanding of a project from a pile of hand-maintained files — `CLAUDE.md`, `AGENTS.md`, memory banks, ADRs, manifests — that drift out of sync with the code and with each other the moment a human stops updating them by hand. Surveying the landscape turns up at least a dozen serious attempts to solve pieces of this problem (Graphify, Cline Memory Bank, Cursor Rules, Windsurf Memories, AGENTS.md), but none of them treat **context as a compiled artifact with a single source of truth**. They're all either static specs a human writes once, or an opaque automatic memory a human can't audit or trust.

CtxKeep's thesis: **AI context should be generated, versioned, and incrementally patched the way TypeScript compiles to JavaScript or Prisma compiles to SQL** — from one canonical, tool-agnostic knowledge model into deterministic, minimal-diff, token-budgeted outputs for whichever assistant you're using. Claude Code is the primary and best-supported target, because it has the richest set of context primitives (path-scoped rules, Skills, Hooks, MCP deferred loading, subagents, memory) to compile into. Everything else is an adapter.

---

## Table of Contents

1. Vision Statement
2. Core Philosophy
3. Problem Statement
4. Target Users
5. Existing Competitors and Why CtxKeep Is Different
6. Unique Selling Proposition
7. High-Level System Architecture
8. Core Modules and Responsibilities
9. Data Model
10. Internal Knowledge Representation
11. Project Lifecycle
12. Project Analysis Engine
13. Change Detection Engine
14. Impact Analysis Engine
15. Synchronization Engine
16. Context Compiler Architecture
17. Plugin Architecture
18. Adapter Architecture for Future AI Assistants
19. Claude-First Architecture and Why
20. Git Integration
21. MCP Integration
22. CLI Architecture
23. VS Code Extension Architecture
24. Configuration System
25. Incremental Update Strategy
26. Local-First Architecture
27. Privacy and Security Considerations
28. Scalability Considerations
29. Repository Structure
30. Development Roadmap
31. MVP Definition
32. Stretch Goals
33. Future Enterprise/Commercial Possibilities
34. Adoption & Trust Safeguards

---

## 1. Vision Statement

CtxKeep is the compiler layer between a living codebase and the AI assistants working on it. It continuously understands a project — its architecture, conventions, decisions, and verified state — and keeps every AI-context artifact (CLAUDE.md, Skills, AGENTS.md, memory banks, manifests, ADRs) synchronized with that understanding automatically, for the lifetime of the project. Claude Code is the primary compilation target and the design center of the system; every other assistant is reached through the same architecture via adapters, with no core-model rewrite required to add one.

---

## 2. Core Philosophy

- **Context is a build artifact, not a document.** Nobody hand-edits generated SQL from a Prisma schema. CtxKeep's outputs (`CLAUDE.md`, `AGENTS.md`, memory bank files) should be treated the same way — with clearly marked generated regions and a real "source of truth" living elsewhere.
- **Deterministic before generative.** Structural facts (what changed, what calls what, what's verified as of which SHA) are computed with AST diffing and graph traversal, not inferred by an LLM. LLMs are used only to *narrate* facts into prose, never to *detect* them. This is a direct response to reports that automatic, LLM-inferred memory (Cursor's auto-memories, in particular) can be inconsistent and isn't reliably generated.
- **Incremental over regenerative.** A change to one API route should never trigger a full rewrite of `CLAUDE.md`. CtxKeep patches only the regions whose upstream facts actually changed — the same discipline that makes incremental compilers and build systems (Bazel, Turborepo) fast and trustworthy.
- **Token economy is a design constraint, not an afterthought.** Every compiled artifact has an explicit token budget. The compiler scores and prunes facts against that budget the way a linker strips unused symbols.
- **Human judgment stays in the loop where it matters.** Mechanical bookkeeping (SHAs, file lists, verification dates) is fully automatic. Narrative and judgment content (why a decision was made, whether a pattern is actually a convention) is auto-*drafted* and human-*approved*, never silently auto-committed.
- **Claude-native first, assistant-agnostic by architecture.** Claude Code gets first-class treatment of every primitive it exposes. Nothing about the core knowledge model assumes Claude, so adapters for other tools are additive, not architectural surgery.
- **Local-first, git-native, no required cloud dependency.** The system must work fully offline, on a laptop, for a solo developer, with zero backend.

### A few places I'd push back on the brief

- **Don't try to emit every artifact type on day one.** A small project gets most of the benefit for little setup cost from just `AGENTS.md` + a git manifest. CtxKeep should ship with an opinionated, small default output set (CLAUDE.md, AGENTS.md, verification manifest) and treat Skills, Hooks, Cline Memory Bank emission, ADR drafting, and multi-adapter output as opt-in layers activated as the project grows. Boiling the ocean on day one is how these projects die in their own complexity.
- **Full auto-generation of ADRs and "decisions" is a trap.** Decisions are the one category of content where being wrong quietly is worse than not having it. CtxKeep should auto-*draft* ADR context/consequences sections from commit and conversation history, but require a human to write the decision and status fields, and should never auto-commit a Decision node as "confirmed" without an explicit approval step.
- **The knowledge graph should not be another vector database people have to run.** AST/graph-based structural retrieval tends to outperform embedding-based RAG for *code* specifically, so CtxKeep's core engine should be embedding-free by default (SQLite-backed structural graph). Embeddings are an optional plugin for prose/doc search only — not a dependency of the core loop.

---

## 3. Problem Statement

Three problems compound over a project's lifetime, and a fourth emerges specifically once teams try to adopt every context-artifact pattern at once:

1. **Context rot** — understanding degrades as a codebase grows past what fits (usefully) in a context window.
2. **Session amnesia** — every new AI session starts cold unless context is deliberately re-supplied; documented at 30–40% of AI interaction time spent on re-establishment.
3. **Unbounded cost growth** — token costs scale with context size, not with what actually changed.
4. **Artifact sprawl and drift (the gap no existing tool addresses)** — once a team adopts CLAUDE.md *and* AGENTS.md *and* a Cline-style memory bank *and* ADRs *and* a verification manifest, those artifacts are five independent places that can say five different things about the same fact. Nothing keeps them consistent with each other, or with the code, except developer discipline — and the common failure modes of hand-maintained context files (stale rules, over-sized files, LLM-authored instructions nobody reviews) are really just what happens when that discipline lapses.

CtxKeep exists to solve problem 4 in a way that structurally prevents problems 1–3 from recurring.

---

## 4. Target Users

| Segment | Need | Primary surface |
|---|---|---|
| Solo indie developer on Claude Code | Zero-ceremony context that doesn't rot as the side project grows | CLI, git hooks |
| Small dev team standardizing on Claude Code | Shared, committed, reviewable context that's the same for every teammate | CLI + CI check + VS Code extension |
| OSS maintainer | Lower the cost of AI-assisted contributions from strangers by giving any agent (not just the maintainer's) accurate context | AGENTS.md emission, public repo mode |
| Platform / DX team at a company | Roll out and enforce AI-context standards across dozens–hundreds of repos | Config presets, CI linting, (later) enterprise dashboard |
| Consultancies / dev agencies | Fast, trustworthy onboarding of new AI-assisted engineers (human or agent) into unfamiliar codebases | `ctxkeep explain`, technical-overview generation |

---

## 5. Existing Competitors and Why CtxKeep Is Different

| Tool / pattern | What it does | Why it isn't this |
|---|---|---|
| **Graphify / AiDex / codebase-memory-mcp** | Structural code knowledge graph, queried live via MCP | Solves *structural retrieval*, not artifact synchronization. Doesn't touch CLAUDE.md, AGENTS.md, ADRs, or memory banks. CtxKeep can *use* a Graphify-style graph as one input to its own IR, or ship its own lightweight equivalent — either way it's a data source, not a competitor at the product layer. |
| **Cline Memory Bank** | Six-file manual documentation discipline, re-read/re-written every session | Explicitly manual by design ("my only link to previous work" — a human process, not automation). Excellent format, no synchronization engine behind it. CtxKeep can treat the six-file schema as one compilation *target*. |
| **AGENTS.md tooling** | A static, cross-tool spec file | A file format and a set of authoring conventions, not a system. It doesn't detect drift or regenerate itself. |
| **Cursor "Memories" / Windsurf "Memories"** | Automatic, LLM-inferred memory extraction | Proprietary, cloud-coupled, not portable across tools, and reported by users as inconsistent in practice. No audit trail: you cannot see *why* a memory was written. |
| **ADR tooling (MADR, AWS guidance, etc.)** | Templates and process for historical decision records | A human-authored historical record by design; deliberately immutable, so it's a poor real-time operational guide (arguably why AGENTS.md-style living documents are emerging as a complement to traditional ADRs). |
| **Doc generators (Swimm, Mintlify, etc.)** | Generate human-readable documentation from code | Optimized for human reading experience and SEO/publishing, not for token budgets, LLM context-window economics, or Claude-specific primitives (Skills, Hooks, path-scoped rules). |
| **Augment Code's context engine** | Proprietary, cloud-hosted knowledge graph exposed to its own IDE | Requires using Augment specifically; not tool-agnostic, not open-source, no static compiled-artifact output for portability/auditability. |

**The gap:** every one of the above is either (a) a live query layer with no static artifacts, (b) a static artifact with no automation behind it, or (c) automatic but proprietary and unauditable. None of them is a compiler with a source of truth, a change-detection trigger, and multiple synchronized output targets.

---

## 6. Unique Selling Proposition

> **No comparable open-source tool combining compiled/versioned AI context output, deterministic git-history-driven change detection, and incremental (not full-rewrite) patching was found during research for this project** — the alternatives surveyed in §5 are each either hand-maintained documentation or opaque automatic memory, not this combination.

Concretely, that means: one source of truth, minimal-diff patches (not rewrites), full provenance (`ctxkeep explain` tells you *why* a line exists), a token budget enforced at compile time, and Claude Code treated as a first-class compilation target with every primitive it offers — while the architecture never assumes Claude is the only target.

---

## 7. High-Level System Architecture

```
                         ┌─────────────────────────────┐
                         │        Trigger Sources       │
                         │  git hooks · CLI · CI ·      │
                         │  file watcher · Claude        │
                         │  SessionStart hook            │
                         └───────────────┬──────────────┘
                                         │
                         ┌───────────────▼──────────────┐
                         │   Project Analysis Engine     │  (baseline + incremental)
                         │   AST parse · git mining ·    │
                         │   convention inference        │
                         └───────────────┬──────────────┘
                                         │  facts
                         ┌───────────────▼──────────────┐
                         │   CtxKeep IR (knowledge      │
                         │   graph — SQLite, local)      │◄────────────┐
                         └───────────────┬──────────────┘              │
                                         │                              │
                    ┌────────────────────┼────────────────────┐        │
                    │                    │                     │        │
        ┌───────────▼──────────┐ ┌───────▼────────┐ ┌──────────▼───────┐│
        │ Change Detection      │ │ Impact Analysis │ │ Synchronization  ││
        │ Engine (git diff/AST) │►│ Engine (graph    │►│ Engine (policy,  ││
        │                       │ │ traversal)        │ │ scheduling)      ││
        └───────────────────────┘ └────────────────┘ └─────────┬────────┘│
                                                                │         │
                                                    ┌───────────▼───────┐ │
                                                    │  Context Compiler │ │
                                                    │  (IR → target IR   │ │
                                                    │  → minimal-diff    │ │
                                                    │  emission, token-  │ │
                                                    │  budget aware)     │ │
                                                    └─────────┬─────────┘ │
                                                              │            │
                       ┌──────────────────────────────────────┼────────────┘
                       │                    │                  │
             ┌─────────▼───────┐ ┌──────────▼────────┐ ┌───────▼────────┐
             │ Claude Adapter    │ │ Cross-Tool Adapters│ │ CtxKeep MCP  │
             │ (CLAUDE.md,       │ │ (AGENTS.md, Cline  │ │ Server (live   │
             │ Skills, Hooks,    │ │ Memory Bank,        │ │ IR queries)    │
             │ manifest, memory) │ │ Cursor/Continue/    │ │                │
             │  ★ reference impl │ │ Windsurf — plugins) │ │                │
             └───────────────────┘ └─────────────────────┘ └────────────────┘
```

Two output *modes* run off the same IR: **compiled static artifacts** committed to git (portable, auditable, diffable, cache-friendly) and a **live MCP query surface** (JIT structural retrieval, in the spirit of Graphify/AiDex). This deliberately unifies the two dominant patterns seen across the AI-context tooling landscape — pre-built compiled context and just-in-time agentic retrieval — instead of picking one.

---

## 8. Core Modules and Responsibilities

| Module | Responsibility | Depends on |
|---|---|---|
| `ctxkeep-core` | Owns the IR, orchestrates the pipeline, exposes a stable internal API | — |
| `analysis-engine` | Baseline + incremental codebase understanding (AST, git mining, convention inference) | tree-sitter, git |
| `change-detector` | Classifies git diffs into semantic categories | git, AST diff |
| `impact-engine` | Graph traversal from changed nodes to stale artifacts | `ctxkeep-core` |
| `sync-engine` | Decides what to auto-patch vs. propose vs. flag; scheduling and triggers | `impact-engine` |
| `compiler` | IR → target-specific patches, token-budget scoring, marker-based region patching | `ctxkeep-core` |
| `adapters/*` | Reader/Writer/Capability implementations per AI assistant | `compiler` |
| `plugin-host` | Loads, sandboxes, and versions third-party plugins | `ctxkeep-core` |
| `mcp-server` | Exposes IR as live MCP tools | `ctxkeep-core` |
| `cli` | Primary user interface | all of the above |
| `vscode-extension` | Visual layer: graph explorer, staleness gutters, review UI | `cli`/`mcp-server` |

---

## 9. Data Model

| Entity | Purpose | Key fields |
|---|---|---|
| **Project** | Root metadata | `id`, `root_path`, `languages[]`, `adapters_enabled[]` |
| **Module** | Subsystem/domain boundary | `id`, `path_glob`, `name`, `parent_module_id` |
| **Symbol** | Function / class / route / schema / type | `id`, `module_id`, `kind`, `name`, `file_path`, `span`, `signature_hash` |
| **Convention** | An inferred or declared rule | `id`, `scope`, `statement`, `confidence`, `source` (`inferred`\|`declared`\|`human`), `evidence_refs[]` |
| **Decision** | ADR-like record | `id`, `title`, `context`, `decision`, `consequences`, `status`, `supersedes_id`, `origin` (`commit`\|`session`\|`manual`) |
| **Gotcha** | Non-obvious fact an agent cannot infer | `id`, `statement`, `scope`, `why_it_matters`, `added_by` |
| **ProgressItem** | Phase/task tracking | `id`, `phase_id`, `description`, `status`, `next_steps` |
| **VerificationCheckpoint** | Git anchor per module | `id`, `module_id`, `sha`, `tag`, `verified_at`, `verifier` |
| **ChangeEvent** | A detected, classified diff | `id`, `commit_sha`, `files_changed[]`, `symbols_changed[]`, `classification`, `timestamp` |
| **ArtifactBinding** | Provenance: which IR nodes produced which output region | `id`, `target_adapter`, `artifact_path`, `region_id`, `source_node_ids[]`, `content_hash`, `last_emitted_at` |
| **Plugin** | Registered extension | `id`, `name`, `kind`, `version`, `config` |

`ArtifactBinding` is the load-bearing entity: it's what makes `ctxkeep explain <file>:<line>` possible, and what makes incremental (not full) re-emission possible.

---

## 10. Internal Knowledge Representation

The IR is a **typed, content-addressed graph**, not a document store and not (by default) a vector index:

- **Nodes and edges** each get a stable ID derived from a hash of their defining facts (e.g., a `Symbol` node's ID is a hash of `file_path + signature_hash`), so unchanged facts never produce churn even across re-analysis runs.
- **Storage:** an embedded SQLite database (`.ctxkeep/graph.sqlite`) with a nodes table, an edges table, and an FTS5 index for text search. No external service, no server process required, single portable file.
- **Per-language confidence tiers.** Uniform tree-sitter coverage does not mean uniform *quality* — a Python decorator-heavy codebase and a Rust trait-heavy one don't yield equally reliable convention inference from the same generic pass. The analysis engine ships a small set of **Tier 1 languages** (JS/TS, Python, Go to start) with deep, framework-aware parsing and high-confidence convention detection, and treats everything else as **Tier 2 (basic)**: symbols and imports only, no confidence-scored convention inference until a language graduates to Tier 1. This is surfaced to the user (`ctxkeep status` shows per-language tier) rather than silently varying quality under a single "supported" label.
- **Deliberately not vector-first.** In line with the general finding that structural, AST-based retrieval tends to outperform embedding similarity for *code* understanding once JIT context loading became standard, the core graph is structural and deterministic. An optional `embeddings` plugin layers semantic search on top *specifically for prose* (docs, comments, ADR full text) — exactly the boundary where RAG remains genuinely useful rather than a replacement for structural analysis.
- **Two-tier truth:** "hard facts" (AST-derived: a function exists, calls another, is exported) are always machine-verified and carry no confidence score. "Soft facts" (inferred conventions, drafted decision rationale) carry an explicit `confidence` and `source` field and are never silently promoted to hard-fact status.
- **Not committed to git by default.** The graph database is regenerable local state (like `node_modules` or a build cache) — `.ctxkeep/graph.sqlite` is gitignored by default. What *is* committed is the compiled output (CLAUDE.md, AGENTS.md, manifest) and, optionally, a compact JSON export of the graph for team-shared setups where re-analysis cost matters.

---

## 11. Project Lifecycle

```
Discovery ──► Baseline Analysis ──► Steady-State Sync ──► Phase Checkpoint ──► (repeat) ──► Long-Term Maintenance
   │                 │                     │                     │
ctxkeep init   ctxkeep analyze    ctxkeep sync         ctxkeep tag-phase
                                       (triggered by hooks)   ctxkeep verify
```

- **Discovery** (`ctxkeep init`): detect languages/frameworks, propose module boundaries, propose which adapters to enable, write initial `.ctxkeep/config.yaml`.
- **Baseline Analysis** (`ctxkeep analyze`): full-repo scan, populate the IR from scratch, surface inferred conventions for human confirmation, produce the first compiled artifact set.
- **Steady-State Sync** (`ctxkeep sync`, or automatic via git hook / `SessionStart` hook): incremental — only touches what changed since the last checkpoint.
- **Phase Checkpoint** (`ctxkeep verify`, `ctxkeep tag-phase`): full re-verification of a module or the whole project, tag the commit, update the manifest, optionally prompt for an ADR if significant decisions were flagged during the phase.
- **Long-Term Maintenance**: periodic `ctxkeep doctor` health checks (stale conventions, orphaned bindings, oversized artifacts) — the automated equivalent of manually checking for the common ways hand-maintained context files rot.

---

## 12. Project Analysis Engine

**Inputs:** repository file tree, git history, existing context artifacts (for import/migration), language-specific parsers.

**Pipeline:**
1. **Structural parse** — tree-sitter across all detected languages; extract symbols, imports, call graphs, route/schema declarations.
2. **Git mining** — commit history, authorship patterns, hot-file frequency, existing tags, existing manifest files if present.
3. **Convention inference** — statistical pattern detection (e.g., "92% of API route files use handler pattern X") produces *candidate* `Convention` nodes with a confidence score; nothing above a configurable confidence floor is auto-declared without a human confirmation pass (`ctxkeep review conventions`).
4. **Existing-artifact ingestion** — if a project already has a `CLAUDE.md`/`AGENTS.md`/ADRs, each adapter's *Reader* parses them into IR deltas so adoption doesn't discard prior work; conflicting facts are surfaced, not silently overwritten.
5. **Module boundary detection** — combination of directory structure, import density (tightly-coupled directories cluster into a module), and human override in config.

**Output:** a populated IR ready for compilation, plus a "confirmation queue" of inferred-but-unconfirmed conventions.

**Cold-start triage.** On a large existing codebase, a naive first pass can surface hundreds of candidate conventions — enough to stall adoption at step one if presented as an undifferentiated list. The confirmation queue is therefore **ranked, not dumped**: candidates are sorted by `(confidence × blast-radius)`, where blast radius is how many modules/files the convention would affect if wrong. `ctxkeep review conventions` shows the top 10–15 by default, with the rest collapsed behind `--all`. The realistic first-session goal is "confirm the handful of conventions that matter," not "triage everything the analyzer noticed."

---

## 13. Change Detection Engine

- Triggered by a git hook (`post-commit`, `pre-push`) or explicit `ctxkeep diff`.
- Computes `git diff <last-checkpoint-sha>..HEAD --stat` first (near-zero cost), then, only for files in that stat, runs **AST-level diffing** (not line diffing) to know *what symbol* changed, not just *that a file* changed.
- Classifies every change into one of: `cosmetic` (formatting only — ignored), `structural` (new/removed file or module), `behavioral` (logic change inside an existing symbol), `interface` (signature/route/schema change), `dependency` (lockfile/package manifest change), `config` (env/build config change).
- Emits typed `ChangeEvent` nodes into the IR — this is the sole input to the Impact Analysis Engine.

---

## 14. Impact Analysis Engine

- Consumes `ChangeEvent` nodes and walks graph edges outward to find every IR node whose truth now depends on stale information (e.g., an `interface`-classified change to a route invalidates: the manifest entry for its module, the technical-overview "API surface" section, any `Decision` node that referenced that route, and any `Convention` node whose evidence included that file).
- Produces a **staleness report**: a ranked list of `{artifact, region, reason, confidence, severity}` — mechanical (manifest SHA) vs. semantic (prose section) is an explicit field, because it determines downstream handling.
- Severity ranking lets the Synchronization Engine decide what's safe to auto-patch immediately (git hook, sub-second) versus what should wait for an interactive `ctxkeep sync` or a flag in the VS Code sidebar.

---

## 15. Synchronization Engine

Three trigger tiers, matched to three response tiers:

| Trigger | Latency budget | What it's allowed to do |
|---|---|---|
| `post-commit` git hook | milliseconds | Mechanical-only patches (manifest SHA, file lists, timestamps). Never touches prose. |
| `ctxkeep sync` (interactive CLI) | seconds | Mechanical patches applied automatically; semantic patches shown as a diff for approval before writing. |
| CI job / `ctxkeep sync --check` | part of pipeline | Read-only: fails the build if staleness exceeds a configured threshold (e.g., an `interface` change with no corresponding manifest update in N commits). |

A `review_policy` in config (`auto` / `review-semantic` / `review-all`) lets teams tune how much autonomy the engine has — defaulting to "mechanical auto, semantic review-required," consistent with the philosophy in §2.

**When the mechanical/semantic classification is wrong.** The entire trust model rests on that boundary being reliable, so it can't be left implicit. Two safeguards: (1) every "mechanical" auto-patch is still a normal, individually-reviewable git commit/diff — nothing is applied outside version control, so a wrongly-auto-applied change is exactly as recoverable as any other commit; (2) a classification that turns out wrong in practice (e.g., a config change that was mechanically patched but actually had semantic consequences) is logged and can be reported via `ctxkeep feedback`, which narrows that specific pattern's classification going forward. The default posture is conservative: anything the classifier is unsure about is treated as semantic (review-required), not mechanical — false positives toward "ask a human" are cheap, false positives toward "auto-apply" are the ones that erode trust.

---

## 16. Context Compiler Architecture

Modeled explicitly as a multi-target compiler:

1. **Frontend**: reads the current IR + the current on-disk state of each target artifact.
2. **Region resolution**: every generated file uses HTML-comment markers delimiting CtxKeep-owned regions, e.g. `<!-- ctxkeep:start:api-conventions --> ... <!-- ctxkeep:end -->`. Content outside markers is human-owned and never touched — the same discipline OpenAPI/Prisma generators use to let generated and hand-written code coexist.
3. **Token-budget scoring**: each artifact type has a configured token budget (e.g., root `CLAUDE.md` < ~500 tokens-equivalent, chosen to keep root context skimmable rather than exhaustive). Candidate facts are scored on relevance, recency, and a "would omitting this cause a mistake?" heuristic, then greedily packed into budget — directly operationalizing that size discipline.
4. **Minimal-diff emission**: each region's last-emitted content hash is cached in `ArtifactBinding`; if the newly compiled content for a region hashes identically, the file is not touched at all — preserving git blame *and* keeping the artifact stable enough to stay warm in Claude's prompt cache (an explicit, measurable design goal: editing CLAUDE.md mid-session breaks caching, so the compiler treats "don't touch this file" as a first-class success state, not just an optimization).
5. **Backend/adapter handoff**: the scored, budgeted fact set is handed to the target adapter's Writer for final target-specific formatting.

---

## 17. Plugin Architecture

Plugin kinds, each with a versioned interface contract and sandboxed execution (separate process, capability-scoped filesystem/network access):

- **Analyzer plugins** — new language support, framework-specific convention detectors (e.g., a Next.js-aware plugin that understands route conventions beyond generic tree-sitter parsing).
- **Emitter plugins** — new output formats not covered by a full adapter (e.g., a team's internal wiki export).
- **Integration plugins** — pull external context into the IR (Linear/Jira → `ProgressItem`, Notion/Confluence → `Decision` enrichment).
- **Trigger plugins** — custom automation sources (Slack slash command, custom webhook, scheduled job).

Plugins declare a manifest (`ctxkeep-plugin.json`: name, kind, version, permissions requested) and are installed via `ctxkeep plugin install`. Core ships with zero required plugins — the MVP adapter and analyzers are built-in, not plugin-delivered, so a fresh install works with no plugin ecosystem dependency.

---

## 18. Adapter Architecture for Future AI Assistants

An **adapter** is a specialized plugin implementing three contracts:

1. **Reader** — parses a target's existing artifacts into IR deltas (enables adoption without discarding prior manual work, and enables drift detection: "this file was hand-edited outside CtxKeep's markers").
2. **Writer** — compiles a budgeted, scored fact set into the target's native format, using that target's own idioms (e.g., Cursor's `.mdc` frontmatter `alwaysApply`/`auto`/`agentRequested`/`manual` vs. Claude's path-scoped `paths:` rules — structurally similar concepts, different syntax).
3. **Capability descriptor** — a static declaration of what primitives the target supports (rules? path-scoping? on-demand skills? hooks? long-term memory file? MCP?). The compiler uses this to decide what to *fold* when a target lacks a primitive — e.g., a tool with no Skills concept gets skill content folded into a `manual`-trigger rule instead of silently dropped.

Claude's adapter is the **reference implementation**, built and maintained in core; every other adapter (Cursor, Cline, Continue, Windsurf, Codex/AGENTS.md-only tools) follows the same contract and can be community-maintained without touching `ctxkeep-core`.

---

## 19. Claude-First Architecture and Why

> **Revised in v0.2:** the shipped design is tool-agnostic. `AGENTS.md` is canonical, and Claude Code gets a pointer `CLAUDE.md` (`@AGENTS.md`), as does Gemini CLI (`GEMINI.md`). The Claude-specific integrations below (hooks, Skills, MCP) remain possible later layers, but no core output depends on them. See `DECISIONS.md`, "v0.2: AGENTS.md is canonical".

Claude Code is the design center, not just the first adapter shipped, for concrete reasons grounded in what it actually exposes:

- It has the **richest primitive set** to compile into — path-scoped rules, Skills (with `disable-model-invocation`), Hooks (`PreToolUse`/`PostToolUse`/`SessionStart`/`Stop`), deferred MCP tool loading, and subagents — so it's the best proving ground for a compiler this ambitious; a system that can target Claude well can trivially target simpler tools by omission.
- **`SessionStart` and `Stop` hooks are first-class integration points no other tool surveyed during this project's design offers as cleanly** — CtxKeep can register a `SessionStart` hook that runs `ctxkeep status --quiet` (surfacing staleness before Claude reads anything) and a `Stop` hook that can require verification (e.g., `ctxkeep sync --check`) before a session ends, turning synchronization from advisory into deterministic.
- The general shift in agentic coding toward harness-level scaffolding (context management, tool orchestration, verification loops carrying an increasing share of what makes an agent effective, not just the model's raw capability) is a direct mandate for exactly this kind of harness tooling.
- **Deferred MCP tool loading** means CtxKeep's own MCP server (§21) adds near-zero fixed startup cost even in projects running many other MCP servers, so there's no tension between "ship a live query layer" and "keep the token budget disciplined."
- Prompt caching economics (90% discount on stable prefixes) make CtxKeep's minimal-diff emission strategy (§16) *directly* valuable in dollars, not just diffs — a stable CLAUDE.md keeps the cache warm across a session's full history of turns.

---

## 20. Git Integration

- **Verification manifest automation**: `.ai/manifest.md` (or a structured `.ctxkeep/manifest.json` compiled *into* that human-readable file) is updated automatically by the mechanical-tier sync engine after every verified checkpoint.
- **Tag-based checkpoints**: `ctxkeep tag-phase <name>` wraps `git tag verified/<name>`, and the manifest stores the tag name (human-readable, rebase/branch-move-proof) rather than a raw SHA where possible.
- **Hooks**: installed via `ctxkeep init` into `.git/hooks/` (or via a `husky`/`lefthook`-style manager if the project already uses one) — `post-commit` for mechanical sync, `pre-push` for a staleness check.
- **Worktree awareness**: each worktree gets its own sync state keyed to its branch, so parallel Claude Code sessions across worktrees (an increasingly common pattern) don't clobber each other's checkpoints.
- **Commit-message enrichment (opt-in)**: a lightweight convention (e.g., `[decision: ...]` trailer) lets a commit feed a `Decision`/`ProgressItem` draft directly, reducing how often a human has to context-switch into a separate ADR workflow.

---

## 21. MCP Integration

CtxKeep ships **two MCP-facing roles**, not one:

1. **`ctxkeep-mcp` server** — exposes the IR as live tools: `query_architecture`, `get_convention(module)`, `get_verification_status(module)`, `find_related_decisions(symbol)`, `explain(file, line)`. This gives Claude (or any MCP client) just-in-time structural retrieval sourced from the *same* IR that compiles the static files — so the live answer and the static file can never actually disagree.
2. **MCP consumer** — CtxKeep's integration plugins (§17) can themselves be MCP clients, e.g., pulling Linear ticket state through a Linear MCP server to enrich `ProgressItem` nodes, rather than every integration needing a bespoke API client.

Both roles are opt-in and independently toggleable in config, since not every project wants a persistent MCP server running.

---

## 22. CLI Architecture

| Command | Purpose |
|---|---|
| `ctxkeep init` | Discovery: detect stack, propose modules/adapters, scaffold `.ctxkeep/config.yaml` |
| `ctxkeep analyze` | Full baseline analysis (populates IR from scratch) |
| `ctxkeep sync` | Incremental sync: mechanical auto-applied, semantic changes shown for review |
| `ctxkeep diff` | Show the current staleness report without writing anything |
| `ctxkeep verify [module]` | Full re-verification of a module or the project |
| `ctxkeep tag-phase <name>` | Verification checkpoint + git tag + manifest update |
| `ctxkeep review conventions` | Human confirmation queue for inferred conventions |
| `ctxkeep explain <path>[:<line>]` | Provenance: which IR nodes produced this content and why |
| `ctxkeep watch` | Daemon mode: sync engine runs continuously in the background |
| `ctxkeep doctor` | Health check: stale bindings, oversized artifacts, orphaned markers, config lint |
| `ctxkeep plugin install/list/remove` | Plugin management |
| `ctxkeep status --quiet` | Machine-readable one-liner, designed to be called from a Claude Code `SessionStart` hook |
| `ctxkeep try` (alias: `npx ctxkeep preview`) | Zero-commitment evaluation: runs analysis and shows the proposed `CLAUDE.md`/`AGENTS.md` diff without writing any files or requiring config. The 5-minute "see the value before you set anything up" path. |
| `ctxkeep rollback [--to <tag\|sha>]` | Reverts compiled artifacts to the last known-good `ArtifactBinding` state; equivalent to `git checkout` on CtxKeep-owned regions specifically, without touching human-owned content in the same file |
| `ctxkeep feedback` | Reports a wrong mechanical/semantic classification to narrow that pattern going forward (§15) |

---

## 23. VS Code Extension Architecture

- **Knowledge Graph Explorer** panel — browse modules, symbols, conventions, decisions as a navigable tree/graph.
- **Inline staleness gutters** — a small indicator next to a function/file whose corresponding context artifact is out of date, with a one-click "sync this."
- **Sync Review UI** — a diff view for any semantic patch queued by the sync engine, approve/edit/reject before it's written (this is the primary UI surface for the "auto-draft, human-approve" policy from §2).
- **ADR Drafting panel** — turns a flagged `Decision` candidate into a guided form (context/consequences pre-filled from history, decision/status left blank for the human).
- **Status bar indicator** — overall project staleness score, mirroring `ctxkeep status`.

---

## 24. Configuration System

`.ctxkeep/config.yaml` (committed to git; `.ctxkeep/config.local.yaml` for personal, gitignored overrides — mirroring the `CLAUDE.md` / `CLAUDE.local.md` split):

```yaml
adapters:
  claude: { enabled: true, emit: [claude_md, agents_md, skills, hooks, manifest] }
  cursor: { enabled: false }
  cline_memory_bank: { enabled: false }

token_budgets:
  claude_md_root: 500
  agents_md: 800

review_policy: review-semantic   # auto | review-semantic | review-all

triggers:
  post_commit_hook: true
  session_start_hook: true
  ci_check: true

ignore:
  - node_modules/
  - dist/
  - "*.lock"

modules:
  - path: src/api/**
    name: api
  - path: src/db/**
    name: db
```

---

## 25. Incremental Update Strategy

- **Content-addressed nodes**: every IR node's ID is a hash of its defining input; unchanged inputs never produce a new node ID, so nothing downstream recomputes.
- **Cached last-emitted-hash per artifact region** (`ArtifactBinding.content_hash`): a region is only rewritten if its computed content actually differs from what's already on disk — files with no real change are never touched, which simultaneously preserves git blame *and* protects prompt-cache warmth, per §16.
- **Change-scoped recompute**: the Impact Analysis Engine (§14) ensures only nodes reachable from an actual `ChangeEvent` are recomputed — a one-line change never triggers a whole-project re-analysis.
- **Baseline vs. incremental parsing**: `ctxkeep analyze` does a full parse once; every subsequent `ctxkeep sync` re-parses only files present in the current `git diff --stat` against the last checkpoint.

---

## 26. Local-First Architecture

- Everything — analysis, IR storage, compilation — runs on-device; `.ctxkeep/` holds the graph DB and config.
- No cloud service is required for any core function; the CLI, VS Code extension, and MCP server all operate fully offline.
- Optional, explicitly opt-in telemetry (anonymized, aggregate feature-usage only) — off by default.
- Any future team/cloud sync (§33) is additive to, never a prerequisite for, the local-first core.

---

## 27. Privacy and Security Considerations

- **No code leaves the machine by default** — no third-party API calls in the core analysis/compile loop; any LLM-assisted drafting step (ADR narration, convention summarization) is explicit, user-configured (bring-your-own API key), and clearly logged as "this content was sent to an external model."
- **Secrets hygiene**: a built-in scanner prevents `.env` values, credentials, or anything matching common secret patterns from being ingested into the IR or emitted into any compiled artifact, independent of `.gitignore`/`.claudeignore` coverage.
- **Plugin sandboxing**: plugins run in a separate process with declared, minimal permissions (filesystem scope, network allow-list); a plugin cannot silently gain access to the whole repo or arbitrary network egress.
- **Full audit trail**: `ctxkeep explain` plus a compile log means every emitted line is traceable to source facts and, if LLM-assisted, to the exact prompt/response that produced it.
- **Respect existing ignore semantics**: `.gitignore` and `.claudeignore` (or adapter-equivalent) are honored by the analysis engine so build artifacts, lockfiles, and vendored code are never parsed or surfaced.

---

## 28. Scalability Considerations

- **Module partitioning**: the IR is partitioned by module/domain, and adapters lazily compile only the artifacts touching modules with actual `ChangeEvent`s — mirroring the path-scoped-rules loading pattern that already works well in Claude Code itself.
- **Incremental analysis via content hashing** (§25) avoids re-parsing unchanged files even in monorepos with millions of lines.
- **Embedded DB scaling**: SQLite comfortably handles the node/edge volumes of large monorepos; if profiling shows it's the bottleneck at extreme scale, the storage layer is an internal implementation detail behind a stable interface and can be swapped for an embedded graph engine (e.g., Kùzu) without changing anything above it.
- **Distributed/parallel analysis (enterprise-tier, later)**: for very large multi-repo estates, baseline analysis can be sharded across worker processes — this is explicitly deferred past MVP (§31) and belongs with the commercial layer in §33, not the local core.

---

## 29. Repository Structure

```
ctxkeep/
├── packages/
│   ├── core/                 # IR, graph storage, orchestration
│   ├── analysis-engine/      # tree-sitter parsing, git mining, convention inference
│   ├── change-detector/
│   ├── impact-engine/
│   ├── sync-engine/
│   ├── compiler/             # region patching, token-budget scoring
│   ├── adapters/
│   │   ├── claude/           # reference implementation
│   │   ├── agents-md/
│   │   ├── cline-memory-bank/
│   │   ├── cursor/
│   │   ├── continue/
│   │   └── windsurf/
│   ├── mcp-server/
│   ├── plugin-host/
│   └── cli/
├── extensions/
│   └── vscode/
├── plugins/                  # first-party optional plugins (embeddings, Linear, Notion)
├── docs/
├── examples/                 # reference-configured sample projects, per project-size tier
└── e2e/                      # end-to-end tests against real sample repos
```

Sample projects under `examples/` are organized per project-size tier (small/medium/large), since the tooling and default output set that make sense scale with project size.

Monorepo, workspace-managed (e.g., npm workspaces), so `core` stays a stable, independently versioned dependency for every adapter and the CLI.

---

## 30. Development Roadmap

| Phase | Focus | Rough scope |
|---|---|---|
| **Phase 0 — Spec & design partners** | Finalize IR schema, marker-based patching format, config schema; recruit 3–5 real projects as design partners | No shipped code yet |
| **Phase 1 — MVP** (see §31) | Claude-only, CLI-only. Git manifest automation + `CLAUDE.md`/`AGENTS.md` compilation with marked regions. Heuristic (not full-graph) staleness detection. | ~6–8 weeks |
| **Phase 2 — Knowledge graph & live retrieval** | Full IR/graph engine, Impact Analysis Engine, `ctxkeep-mcp` server, Skills + Hooks emission, `ctxkeep explain` | ~8–10 weeks |
| **Phase 3 — Tooling & second adapters** | VS Code extension, plugin API opened to community, Cline Memory Bank + Cursor adapters | ~8–10 weeks |
| **Phase 4 — Team & CI features** | `ctxkeep sync --check` in CI, shared team config conventions, multi-repo config presets | ~6–8 weeks |
| **Phase 5 — Ecosystem** | Continue/Windsurf/Codex adapters, community plugin marketplace, enterprise groundwork (§33) | Ongoing |

---

## 31. MVP Definition

**In scope:**
- Claude Code only (single adapter).
- CLI only (no VS Code extension, no MCP server yet).
- `ctxkeep init` / `ctxkeep analyze` / `ctxkeep sync` / `ctxkeep tag-phase`.
- Compiled outputs: `CLAUDE.md`, `AGENTS.md`, `.ai/manifest.md` — with marker-based regions so hand-written content is preserved.
- Change detection at the **git diff / file-level**, not full AST-level impact analysis yet (that's Phase 2).
- `post-commit` hook for mechanical sync only.
- Basic convention inference with a human confirmation step.

**Explicitly out of scope for MVP:** Skills/Hooks emission, subagent orchestration hooks, Cline Memory Bank / Cursor / other adapters, plugin system, VS Code extension, MCP server, ADR drafting UI, embeddings/semantic search.

**Pre-launch checklist item:** trademark/name availability check for the public project name (see note at top of document).

---

## 32. Stretch Goals

- **Dynamic Workflows integration**: fan out large-scale re-verification (e.g., re-checking every module after a major refactor) across parallel subagents, graded against a rubric, mirroring Anthropic's June 2026 Dynamic Workflows pattern.
- **Natural-language project history queries** ("why did we choose Postgres over Mongo here?") answered from `Decision` provenance, not re-derived from scratch.
- **Context linting in CI**: fail a PR if a diff violates a declared `Convention` node, the same way a linter enforces style.
- **Cross-repo context federation**: a shared knowledge layer across a microservice fleet, so a change in one service's interface can flag staleness in a *dependent* service's context artifacts.
- **Auto-drafted ADRs surfaced directly in the VS Code review UI**, one click from "flagged decision" to "approved ADR committed."

---

## 33. Future Enterprise/Commercial Possibilities (Core Stays Open Source)

Open-core boundary, explicit from day one to avoid future trust erosion in the OSS community:

| Layer | License / model | Contents |
|---|---|---|
| **Core engine, Claude adapter, CLI, MCP server** | Permanently open source (MIT or Apache-2.0) | Everything in §7–§25 above |
| **Community adapters** | Open source, community-maintained under the same plugin contract | Cursor, Cline, Continue, Windsurf, Codex |
| **Hosted team dashboard** (commercial) | Proprietary, hosted | Shared knowledge graph across many repos/services, org-wide convention compliance reporting, SSO, audit logs |
| **Hosted MCP gateway** (commercial) | Proprietary, hosted | Managed, always-on `ctxkeep-mcp` for teams that don't want to self-host |
| **Enterprise-only plugins** (commercial) | Proprietary | Deep integrations with internal enterprise systems (private Jira/Confluence instances, internal SSO, compliance-specific exporters) |
| **Analytics** (commercial) | Proprietary | AI-assisted-dev velocity and cost reporting across an org's repos |

This mirrors the open-core model of projects like Sentry, Grafana, and Supabase: the thing that makes CtxKeep trustworthy as *infrastructure* — the core engine and the Claude adapter — is never paywalled, while the things only large organizations need (fleet-wide dashboards, hosted infra, compliance reporting) fund ongoing development.

---

## 34. Adoption & Trust Safeguards

These aren't new architecture — they're commitments about how the existing pieces behave, made explicit because the whole product lives or dies on whether developers trust it enough to let it touch their repo automatically.

- **Everything is a normal git diff.** No CtxKeep action is ever invisible or unreviewable-after-the-fact. Mechanical auto-patches are still individual commits; nothing bypasses version control, ever. If CtxKeep gets something wrong, the fix is the same muscle memory as fixing any other bad commit.
- **`ctxkeep rollback` is a first-class command, not an afterthought.** Reverting CtxKeep-owned regions back to the last verified state is a single command, scoped precisely to what CtxKeep wrote — it never touches human-owned content sharing the same file.
- **`ctxkeep try` removes the "configure it before you can see the value" problem.** A developer should be able to see a real, proposed `CLAUDE.md` diff for their actual repo in under 5 minutes, with zero config and zero files written, before deciding whether to adopt anything.
- **Conservative default classification.** When the sync engine is unsure whether a change is mechanical or semantic, it defaults to semantic (review-required). The cost of an unnecessary review prompt is small; the cost of a wrongly-auto-applied semantic change is trust, which is expensive to rebuild.
- **Per-language and per-feature honesty in `ctxkeep status`.** The tool tells you what tier of confidence it has for each language and each convention, rather than presenting uniform confidence it can't back up. A visible "basic support" label is better than a silent quality gap discovered later.
- **Cold-start is paced, not dumped.** First-run convention review is ranked and capped by default, so onboarding a legacy repo feels like "confirm a handful of important things," not "triage an unbounded backlog."

---

## Closing Note

The single hardest design decision in this plan is the one in §2's pushback section: resisting the urge to make CtxKeep "automatically write everything." Repeatedly, across the tools surveyed for this project, the ones that try to fully automate judgment (auto-memory in Cursor/Windsurf, LLM-authored `AGENTS.md`/`CLAUDE.md` files) underperform disciplined, mostly-manual approaches like Cline's Memory Bank and hand-written CLAUDE.md files. CtxKeep's bet is that the winning position isn't "more automation" — it's **automating the parts that are genuinely mechanical (drift detection, SHA bookkeeping, minimal-diff patching, token budgeting) with the same rigor as a compiler, while keeping a human explicitly in the loop for every fact that requires judgment.**
