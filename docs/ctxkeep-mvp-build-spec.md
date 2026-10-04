# CtxKeep — MVP Build Specification
### A concrete, buildable Phase 0 → Phase 1 spec (companion to `ctxkeep-architecture-plan.md`)

> **Status (2026-10-04):** this spec is complete and historical. It describes the v0.1 MVP. The current system (v0.2) is described in [`how-it-works.md`](how-it-works.md) and [`configuration.md`](configuration.md), with the reasons for each change in `DECISIONS.md`. Notably, CLAUDE.md is no longer a primary output (§0, §1), and the `checkpoints`/`artifact_bindings` tables in §3 no longer exist.
>
> This document exists to answer one question: **what do I actually build first, in what order, with what tools, to prove the idea works?** It intentionally ignores most of the full architecture doc (adapters, plugins, VS Code extension, MCP server, enterprise tier). Nothing below should take more than a few weeks for one developer to reach a working prototype.

---

## 0. What "done" looks like for this spec

A single CLI tool that, run against a real TypeScript or Python repo, does this end-to-end:

```
$ ctxkeep try
→ analyzes the repo (parses code, mines git history)
→ shows a diff of a proposed CLAUDE.md (nothing written yet)

$ ctxkeep init && ctxkeep analyze
→ writes .ctxkeep/config.yaml
→ writes .ctxkeep/graph.sqlite
→ writes CLAUDE.md and AGENTS.md with ctxkeep:start/end markers
→ writes .ai/manifest.md

$ (edit some code, commit)

$ ctxkeep sync
→ detects what changed via git diff
→ patches only the affected regions in CLAUDE.md/manifest
→ leaves everything else byte-identical
```

If that loop works reliably on 2–3 real repos, the core bet is validated and Phase 2 (full graph, MCP server, adapters) is justified. If it doesn't, better to find out now, cheaply, than after building the rest of the architecture doc.

---

## 1. Scope Lock — Explicitly IN and OUT

### IN (build this)
- CLI only. No VS Code extension, no daemon/watch mode, no MCP server.
- One adapter: **Claude** (CLAUDE.md + AGENTS.md + `.ai/manifest.md`).
- Two languages at Tier 1: **TypeScript/JavaScript** and **Python**. Everything else: file/symbol listing only, no convention inference.
- File-level + basic AST-level change detection (not full graph impact analysis — see §6).
- Marker-based region patching (`<!-- ctxkeep:start:X -->...<!-- ctxkeep:end -->`).
- Simple token-budget truncation (word/line-count heuristic — not the full relevance-scoring algorithm from the architecture doc).
- Convention inference: pattern frequency only (e.g., "N% of files in this folder do X"), ranked confirmation queue, capped at top 10.
- `post-commit` git hook (mechanical patch only) is optional/manual to wire up — not auto-installed yet.
- No LLM calls required for the core loop. An optional `--draft-with-claude` flag on `ctxkeep analyze` can call the Anthropic API (user's own key) to turn raw facts into better prose — but the tool must work with zero LLM calls, only worse prose, if no key is set.

### OUT (do not build yet — noted so you don't scope-creep)
- Plugin system, plugin sandboxing.
- Any adapter other than Claude.
- Skills / Hooks / subagent emission.
- Full Impact Analysis Engine (graph traversal from changed symbol → all affected artifacts). MVP uses a simpler rule: "if any file in a module changed, mark that module's sections stale."
- ADR drafting UI, Decision node workflow.
- VS Code extension.
- `ctxkeep-mcp` server.
- Embeddings/semantic search.
- CI integration (`--check` mode) — add once the core loop is trustworthy.

---

## 2. Tech Stack Decisions

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript, Node.js (≥20)** | Best tree-sitter binding support, same ecosystem as MCP SDK (needed later), same ecosystem as VS Code extensions (needed later). Avoids a language switch at Phase 3. |
| CLI framework | **`commander`** (or `clipanion`) | Minimal, well-understood, no need for oclif's plugin machinery yet. |
| Parsing | **`tree-sitter`** + `tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-python` | Matches the architecture doc's structural-first approach; avoid any embedding/vector dependency in MVP. |
| Storage | **SQLite via `better-sqlite3`** | Synchronous, zero-config, single file, matches §10 of the architecture doc exactly. |
| Git access | **`simple-git`** (shell out to system `git`) | Avoid re-implementing git plumbing; system git is always present in dev environments. |
| Config | **YAML via `js-yaml`**, validated with **`zod`** | Matches `.ctxkeep/config.yaml` from the architecture doc; zod gives you schema validation and good error messages for free. |
| Testing | **`vitest`** | Fast, TS-native. |
| Package manager | **`npm`** | Ships with Node.js, no separate install step; single-package MVP has no workspace needs yet. |

**Repository shape for MVP** (deliberately a subset of the full §29 layout — don't build the empty folders yet):

```
ctxkeep/
├── src/
│   ├── cli/                  # command definitions (init, analyze, sync, try, diff)
│   ├── analysis/              # tree-sitter parsing, git mining, convention inference
│   ├── graph/                 # SQLite schema, node/edge read-write
│   ├── compiler/               # marker-region patching, token-budget truncation
│   ├── adapters/
│   │   └── claude/            # CLAUDE.md / AGENTS.md / manifest writers + readers
│   └── config/                 # zod schema + loader for .ctxkeep/config.yaml
├── test/
│   └── fixtures/               # small sample repos used as golden-output tests
├── package.json
└── README.md
```

---

## 3. Data Model — MVP Subset

Only build these SQLite tables to start (full schema from the architecture doc's §9 comes later, as needed):

```sql
CREATE TABLE modules (
  id TEXT PRIMARY KEY,
  path_glob TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE symbols (
  id TEXT PRIMARY KEY,
  module_id TEXT REFERENCES modules(id),
  kind TEXT NOT NULL,          -- 'function' | 'class' | 'route' | 'export'
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  span_start INTEGER,
  span_end INTEGER,
  signature_hash TEXT NOT NULL
);

CREATE TABLE conventions (
  id TEXT PRIMARY KEY,
  module_id TEXT REFERENCES modules(id),
  statement TEXT NOT NULL,
  confidence REAL NOT NULL,     -- 0.0–1.0
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'confirmed' | 'rejected'
  evidence_file_paths TEXT      -- JSON array
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  module_id TEXT REFERENCES modules(id),
  sha TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE artifact_bindings (
  id TEXT PRIMARY KEY,
  artifact_path TEXT NOT NULL,
  region_id TEXT NOT NULL,       -- e.g. "api-conventions"
  content_hash TEXT NOT NULL,
  last_emitted_at TEXT NOT NULL,
  UNIQUE(artifact_path, region_id)
);
```

`ArtifactBinding` is the one table you must get right early — it's what makes minimal-diff emission (§25 of the architecture doc) actually work. Skipping it is the single most tempting shortcut and the one most likely to produce noisy, untrustworthy diffs.

---

## 4. Build Order (Milestone-by-Milestone)

This order is chosen so that **every milestone ends with something runnable and demoable**, not a partially-wired system.

### Milestone 1 — Skeleton + `ctxkeep try` (no writes, no config)
- CLI scaffold with `commander`.
- Walk the repo tree, respect `.gitignore`, filter to `.ts/.tsx/.js/.py`.
- Parse each file with tree-sitter, extract top-level functions/classes/exports only (no call graph yet).
- Hardcode a single naive `CLAUDE.md` template (project name, detected languages, list of top-level modules by folder).
- `ctxkeep try` prints the proposed file to stdout as a diff against "empty."
- **Demo criteria:** run against 2 real repos, output is recognizably useful, not garbage.

### Milestone 2 — Config + `ctxkeep init` + SQLite graph
- `.ctxkeep/config.yaml` schema (zod) + `ctxkeep init` scaffolds it with detected languages/module guesses.
- Wire up `better-sqlite3`, create the tables from §3, populate `modules` and `symbols` from the Milestone 1 parse.
- `ctxkeep analyze` = Milestone 1's parse, now persisted to the graph instead of just printed.

### Milestone 3 — Marker-based compiler + first real write
- Implement the region-marker patching logic: given a target file + a map of `region_id → content`, either insert markers fresh or replace only the marked block, leaving everything else untouched.
- `ctxkeep analyze` now actually writes `CLAUDE.md`, `AGENTS.md`, `.ai/manifest.md` with markers.
- Populate `artifact_bindings` with content hashes after every write.
- **Demo criteria:** run twice in a row with no code changes → second run touches zero files (hash match, no-op). This is the single most important correctness property in the whole MVP — test it explicitly.

### Milestone 4 — Change detection + `ctxkeep sync`
- `git diff <last-checkpoint-sha>..HEAD --name-only` (via `simple-git`) → list of changed files.
- Map changed files → affected modules (simple: changed file's folder → module).
- Re-parse only those files, update `symbols` table for just those modules.
- Recompile only the regions belonging to affected modules; unaffected regions untouched (verify via `artifact_bindings` hash check from Milestone 3).
- Update `checkpoints` table with new SHA per verified module.
- **Demo criteria:** change one file, run `ctxkeep sync`, confirm only the relevant section of `CLAUDE.md` changed in `git diff`.

### Milestone 5 — Convention inference + confirmation queue
- Simple frequency-based pattern detection within a module (start with just 2–3 concrete pattern classes: "consistent export style," "consistent error-handling pattern," "consistent file-naming pattern" — don't try to be general yet).
- Populate `conventions` table with `status='pending'`, ranked by `confidence`.
- `ctxkeep review conventions` — simple CLI y/n loop over the top 10, confirmed ones get included in the next `CLAUDE.md` compile, rejected ones are excluded and remembered (don't re-ask).

### Milestone 6 — Polish, golden-file tests, rollback
- `ctxkeep rollback` — revert `artifact_bindings`-tracked regions to their last-recorded content.
- Golden-file test suite: 3 small fixture repos in `test/fixtures/`, snapshot-test the exact `CLAUDE.md`/`AGENTS.md` output, and explicitly test the "run twice, zero diff" property from Milestone 3.
- README with the exact 4-command demo loop from §0.
- **This is the actual MVP.** Everything past this point is Phase 2 territory from the architecture doc.

---

## 5. The One Algorithm Worth Getting Right Early: Region Patching

This is worth pseudocode because getting it wrong silently undermines the whole "minimal diff, cache-friendly" value proposition.

```
function patchRegion(filePath, regionId, newContent):
  fileText = read(filePath) or "" if file doesn't exist
  startMarker = `<!-- ctxkeep:start:${regionId} -->`
  endMarker   = `<!-- ctxkeep:end:${regionId} -->`

  newHash = hash(newContent)
  existingBinding = db.getBinding(filePath, regionId)

  if existingBinding and existingBinding.content_hash == newHash:
    return NO_OP   # critical: do not touch the file at all

  if startMarker in fileText:
    fileText = replaceBetween(fileText, startMarker, endMarker, newContent)
  else:
    fileText = fileText + "\n" + startMarker + "\n" + newContent + "\n" + endMarker + "\n"

  write(filePath, fileText)
  db.upsertBinding(filePath, regionId, newHash, now())
  return WRITTEN
```

The `NO_OP` path is not an optimization to add later — it's the thing that makes the whole tool trustworthy. Build the test for it in Milestone 3, not Milestone 6.

---

## 6. Where MVP Deliberately Cuts Corners (and what breaks if you forget they're cut)

> **Revisited 2026-07-11, end of Milestone 6.** Reality had diverged from this table in one significant way (token budget) and a few gaps discovered during Milestones 4-6 weren't reflected at all. Corrected below; see `DECISIONS.md` for the fuller reasoning behind each of the newer rows.

> **v0.2 status (2026-10-04).** These rows are now resolved: module removal/rename handling; whole-module resync (sync is now file-granular, by content hash); unbounded module regions (fixed caps, with detail moved to on-demand docs); convention re-validation. Rollback still restores from HEAD only. Token budgeting is still fixed caps rather than scored pruning. See the v0.2 entries in `DECISIONS.md`.

| Corner cut | Real risk if forgotten | Fix, later phase |
|---|---|---|
| Module = folder, no real boundary detection, no removal/rename handling | Misclassifies cross-cutting code; deleting or renaming a folder orphans that module's `checkpoints`/`conventions` rows (they keep referencing a `module_id` that no longer resolves to anything in `modules`) | Real module inference — Phase 2 |
| Change detection = file-level, not symbol-level | Whole-module resync on a one-line change (wasteful, not wrong) | AST-diff-based Impact Analysis Engine — Phase 2 |
| **No token budget or truncation of any kind** (corrected — this table originally said "word-count truncation," implying some limit exists; none was ever implemented) | Module regions in `CLAUDE.md` grow completely unbounded — a large real module can produce hundreds of untruncated lines in one region | Word-count heuristic first, then scored/ranked pruning — Phase 2 |
| No plugin system | Fine for MVP | Phase 3 |
| No LLM by default | Prose is plainer than a human-written CLAUDE.md | `--draft-with-claude` flag already scoped in as escape hatch, never implemented (not required for MVP per §1) |
| **(new)** Confirmed/rejected convention status is permanent, never re-validated | A confirmed convention keeps appearing in `CLAUDE.md` even after the code drifts away from the pattern it was confirmed for | Periodic re-validation / drift detection for conventions — Phase 2 |
| **(new)** `ctxkeep rollback` restores from git HEAD only, not a retained history | Can't step back further than the last commit; a subsequent `analyze`/`sync` can reintroduce the exact content rollback just reverted, since graph state isn't rolled back with it | `--to <tag\|sha>` flag; possibly graph-level checkpointing for a fuller undo — Phase 2 |

None of these are silent traps as long as this table exists, stays current, and gets checked before claiming "MVP done."

---

## 7. Decisions You Need to Make Before Milestone 1

1. **Confirm the two Tier-1 languages** (TypeScript/JS + Python assumed above) — pick based on what repos you'll actually dogfood this on.
2. **Pick the license now** (MIT recommended, matches §33 of the architecture doc) — trivial to do before any code exists, annoying to retrofit.
3. **Pick your own dogfood repo(s)** — you need 2–3 real, moderately-sized repos to validate against continuously, not just toy fixtures. This matters more than any code decision above.
4. **Decide the project's actual public name** — the trademark/availability check flagged in the architecture doc should happen now, before it's baked into package names, CLI binary names, and config file paths (`.ctxkeep/`) that are annoying to rename later.

---

## 8. Definition of Done for This Spec

You're ready to start Milestone 1 the moment you have: Node 20+ installed, a `git init`-ed repo for the tool itself, and answers to the four questions in §7. Nothing else is a prerequisite.
