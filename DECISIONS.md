# Decisions

Lightweight decision log — one entry per non-obvious technical choice, written
when the decision is made (or, for these first two, retroactively as soon as
the gap was noticed). Not full ADRs — AGENTS.md/CLAUDE.md are the living
operational guide; this file is the lighter-weight historical record of why
things are the way they are.

---

## 2026-07-10 — Pin `tree-sitter` core to `0.21.1`

**Chosen:** `tree-sitter@0.21.1`, `tree-sitter-typescript@0.23.2`,
`tree-sitter-javascript@0.23.1`, `tree-sitter-python@0.21.0` — exact pins, not
ranges.

**Rejected:** Installing all four packages at `latest` (`tree-sitter@0.25.0`,
`tree-sitter-typescript@0.23.2`, `tree-sitter-javascript@0.25.0`,
`tree-sitter-python@0.25.0`).

**Why:** `tree-sitter-typescript@latest` peer-depends on `tree-sitter@^0.21.0`
while `tree-sitter-python@latest` (0.23.x+) peer-depends on `tree-sitter@^0.22.1`
— no single `tree-sitter` core version satisfies both latest grammar packages
at once. `tree-sitter-javascript@0.23.1` further narrows this to `^0.21.1`.
The highest version where all three grammars agree with a single core version
is `tree-sitter@0.21.1` + `tree-sitter-python@0.21.0` (rather than
`tree-sitter-python@latest`). This trades a slightly older Python grammar for
zero peer-dependency conflicts across all three Tier-1 languages.

**Risk carried forward:** `tree-sitter-python@0.21.0` is several minor versions
behind `tree-sitter-python@latest`. If a future Python syntax feature isn't
parsed correctly, check whether a newer `tree-sitter-python` has since aligned
its peer range with a newer shared `tree-sitter` core before assuming it's a
bug in our extraction code.

---

## 2026-07-10 — Pin `better-sqlite3` to `12.11.1`

> **Superseded 2026-07-11 — see the entry below.** The Node 20 gap flagged as
> a future CI risk here turned out to be a live install-time bug, not just a
> risk: `engines` declares Node ≥20, so any Node 20 install of this project
> was already broken. Re-pinned to `12.9.0` the next day. Left this entry
> intact for the history of *why* `12.11.1` was chosen originally — the
> reasoning about the ClangCL failure and the win32-x64/Node 24 prebuild
> still stands, it's just no longer the version in `package.json`.

**Chosen:** `better-sqlite3@12.11.1` (exact pin).

**Rejected:** `better-sqlite3@^11.7.0` (the range originally specified),
which resolved to `11.10.0`.

**Why:** `better-sqlite3@11.10.0` has no published prebuilt binary for this
dev machine's runtime (Node 24.13.0, win32-x64, NODE_MODULE_VERSION 137).
`pnpm install` fell through to a local `node-gyp rebuild`, which failed with:

```text
MSB8020: The build tools for ClangCL (Platform Toolset = 'ClangCL') cannot be
found. To build using the ClangCL build tools, please install ClangCL build
tools.
```

i.e. Visual Studio 2022 is installed but without the ClangCL component
better-sqlite3's native build selected. Rather than installing additional
Visual Studio components on the dev machine (a system-level change outside
this project's scope), checked GitHub release assets directly and confirmed
`better-sqlite3@12.11.1` ships a prebuilt binary for
`node-v137-win32-x64` — installs cleanly with no compilation step.

**Known risk for CI (recorded now, not fixed now):** Prebuilt binaries for
`better-sqlite3@12.11.1` exist **only** for these Node ABI (`NODE_MODULE_VERSION`)
numbers, verified directly against the `v12.11.1` GitHub release asset list
(not guessed):

| Node ABI | Node major version | Prebuilt? |
| --- | --- | --- |
| 108 | 18 | No |
| 115 | **20** | **No** |
| 120 | 21 | No |
| 127 | 22 | Yes |
| 131 | 23 | No |
| 137 | 24 | Yes (what this machine uses) |
| 141 | 25 | Yes |
| 147 | 26 | Yes |

Platform/arch coverage for the ABIs that *do* have prebuilds is broad —
`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linuxmusl-x64`,
`linuxmusl-arm64`, `linux-arm`, `linuxmusl-arm`, `win32-x64`, `win32-arm64` are
all present for ABI 127/137/141/147. So the gap is **not** macOS or Linux
platform coverage — it's specifically that ABI 115 (**Node 20**) has no
prebuilt binary at all, for any platform.

This matters because `package.json` declares `"engines": { "node": ">=20" }`
(per build spec §2's "Node.js (≥20)" requirement) — meaning our own stated
minimum supported Node version is exactly the one version this pinned
dependency has no prebuilt binary for. A contributor or CI runner on Node 20,
21, or 23 will silently fall through to a local compile and can hit the same
ClangCL-class failure this machine hit, on any OS where a full native
toolchain isn't already set up.

**Not fixing now — flagging for whenever CI is set up (not yet built):**
options to revisit at that point: (a) bump the engines minimum to Node ≥22,
(b) pin CI runners to Node 22/24, or (c) accept the local-compile fallback
and make sure CI images have full build toolchains (`build-essential` /
Xcode CLI tools / a VS toolset with the correct component) so the fallback
path is exercised and known-working rather than assumed.

---

## 2026-07-11 — Re-pin `better-sqlite3` to `12.9.0` (resolves the Node 20 gap)

**Chosen:** `better-sqlite3@12.9.0` (exact pin, down from `12.11.1`).

**Rejected:** (a) bumping `engines.node` to `>=22` and living with `12.11.1`,
(b) staying on `12.11.1` and accepting the Node 20 install failure as a
documented-but-unfixed known issue.

**Why:** Code review correctly flagged that the Node 20
gap logged in the entry above wasn't a future CI risk — it was a **live
install-time bug**. `package.json` has said `"engines": { "node": ">=20" }`
since Milestone 1 (matching build spec §2's "Node.js (≥20)" requirement), but
`better-sqlite3@12.11.1` has no prebuilt binary for Node ABI 115 (Node 20)
on any platform, meaning `pnpm install` on Node 20 was already falling
through to a local compile that can hit the exact same ClangCL-class failure
this machine hit on Node 24/`11.10.0`. Anyone following this project's own
stated minimum Node version could not `pnpm install` cleanly.

Rather than raise the floor to Node 22 (which would mean correcting
`ctxkeep-mvp-build-spec.md` §2's explicit "Node.js (≥20)" — a source-of-
truth spec document, not something to quietly work around in code), checked
whether an older `better-sqlite3` still covered this machine's actual
runtime (Node 24, ABI 137) while *also* covering ABI 115. Queried the GitHub
release asset lists directly for several versions between `11.7.0` and
`12.11.1`:

| Version | ABIs with prebuilt binaries |
| --- | --- |
| `12.11.1` (previous pin) | 127, 137, 141, 147 — **no 115** |
| `12.10.1` | 127, 131, 137, 141, 147 — **no 115** |
| `12.9.0` | **115**, 127, 131, 137, 141 |
| `12.4.1` | 115, 127, 131, 137 |
| `11.10.0` (original range target) | 115, 120, 127, 131, 137 (but no win32 prebuild for the exact patch pnpm resolved — see entry above) |

`12.9.0` is the newest version that still covers ABI 115 (Node 20), and it
covers ABI 137 (Node 24, this machine) too, across the same broad
darwin/linux/linuxmusl/win32 × x64/arm64 matrix as `12.11.1`. Re-pinned to
it, reinstalled (prebuild install, no compile step triggered), reran the
full test suite (25/25 passing) and confirmed the native binding loads.

**No doc correction needed:** since this fix keeps `engines.node: >=20`
true in practice, `ctxkeep-mvp-build-spec.md` §2's "Node.js (≥20)" remains
accurate — it was the *code* that was contradicting the spec, not the other
way around.

**Risk carried forward:** `12.9.0` is now two minor versions behind
`12.11.1`. If `better-sqlite3` releases stop shipping Node 20 prebuilds
going forward (Node 20 LTS maintenance ends 2026-04-30 per Node's release
schedule, so this is plausible), this same gap will reopen on the next bump
attempt. Re-check ABI coverage the same way (query the release assets
directly, don't assume) before bumping this dependency again, and revisit
whether the `engines` floor should move to Node ≥22 once Node 20 is
actually past end-of-life rather than working around it indefinitely.

---

## 2026-07-11 — `checkpoints` is intentionally append-only, not upserted

> **Superseded 2026-10-04 (v0.2):** the `checkpoints` table no longer exists. Change detection moved from git-diff-against-checkpoint to content hashing (see "v0.2: change detection by content hash" below).

**Note, not a decision to revisit:** `checkpoints` (build spec §3) has no
`UNIQUE` constraint on `module_id`, unlike `artifact_bindings` (which does,
and is genuinely upserted). Every successful resync of a module inserts a
**new** row rather than overwriting the old one — the table is a full
verification history, and "the" checkpoint for a module is its most recent
row by `verified_at` (see `getCheckpoint` in `src/graph/checkpoints.ts`).

Recorded here because it's easy for a future reader (or a future me) to see
"no unique constraint" next to `artifact_bindings`'s upsert pattern and
assume it's an oversight rather than the intended design. It isn't — fixing
it to "one row per module" would be the actual bug. Correctness of the
most-recent-row lookup (ordering, not just presence) is covered by
`test/graph/checkpoints.spec.ts` and the double-resync scenario in
`test/analysis/syncPlan.spec.ts`.

---

## 2026-07-11 — Known gap: confirmed/rejected convention status is never re-evaluated

> **Resolved 2026-10-04 (v0.2):** conventions are re-detected every run; a confirmed one that stops holding goes inactive, is no longer emitted, and is reported as lapsed. See "v0.2: conventions".

Once a convention is confirmed or rejected via `ctxkeep review conventions`, its status is permanent — `upsertConventions` refreshes `statement`/`confidence` on re-analysis but never touches `status` (by design, see the entry above this one). This means a **confirmed** convention keeps appearing in `CLAUDE.md` even if the underlying code later stops following that pattern (e.g. a module that was 9/9 named-exports at confirmation time drifts to 4/9 after refactoring) — nothing currently detects or flags that drift. Known MVP limitation, not a bug, not fixed yet.

---

## 2026-07-11 — Known gap: module deletion/rename orphans that module's `conventions` rows

> **Resolved 2026-10-04 (v0.2):** module rows no longer exist (membership is computed per run). A vanished module's conventions go inactive, and its artifact regions/files are removed. See "v0.2: conventions" and "v0.2: the artifact system".

`conventions.module_id` references `modules.id`, but nothing deletes or re-keys existing convention rows when a module disappears (folder removed) or is effectively renamed (folder renamed, which this project's folder-based module inference treats as a brand-new module id). The old rows stay in the table forever, referencing a `module_id` that no longer resolves to anything in `modules` — orphaned, not cleaned up. Same class of gap as the "module = folder, no removal handling" cut already noted for `persistAnalysis`/`persistModuleSymbols`; not fixed yet.

---

## 2026-07-11 — `ctxkeep rollback` regenerates from git HEAD; it does not restore from its own history

> **Partly superseded 2026-10-04 (v0.2):** it still restores from HEAD, but now enumerates regions from the files' own markers instead of `artifact_bindings` (which no longer exists), so it works on a fresh clone with no graph. The `verifyAgainstDisk` workaround described below is gone: every write path now compares against disk.

**Chosen:** `ctxkeep rollback` reverts each CtxKeep-owned region to its content **as of the last git commit (HEAD)**, by reading the historical file content via `git show HEAD:<path>`, extracting that region's content with `extractRegionContent` (the exact inverse of `patchRegion`'s splice), and re-patching it into the current working-tree file through the normal `patchRegion` path.

**Rejected:** Extending `artifact_bindings` (or a new table) to retain prior content/hashes so rollback could restore from CtxKeep's own history, independent of git.

**Why:** `artifact_bindings` currently stores only the latest hash per (artifact, region) — by design, it's a cache-validity table for the NO_OP check, not a history log (contrast with `checkpoints`, which is deliberately append-only — see the entry above). Since `CLAUDE.md`, `AGENTS.md`, and `.ai/manifest.md` are committed to git (decided in Milestone 2), **git already has full history of every version of these files** — building a parallel history mechanism in SQLite would duplicate what git does better (arbitrary point-in-time restore, not just one step back) and would need its own storage-growth/pruning story. The architecture plan §22 itself frames `ctxkeep rollback` as "equivalent to `git checkout` on CtxKeep-owned regions specifically" — this implementation takes that literally rather than inventing a second history store.

**Scope cut for MVP:** only rolls back to HEAD, not `--to <tag|sha>` (mentioned as a future flag in architecture plan §22). Reading an arbitrary historical ref is the same mechanism (`git show <ref>:<path>`) — adding the flag later is a small extension, not a redesign.

**Known limitation, stated explicitly in the CLI's own output:** this reverts the *compiled file* to match HEAD; it does not undo anything in the graph (`modules`/`symbols`/`conventions`). If nothing in the source code changed, the next `ctxkeep analyze`/`sync` recomputes the same facts from the graph and can reintroduce the exact content rollback just reverted. This is expected, not a bug — the same way reverting a generated build artifact doesn't stop the next build from regenerating it. Rollback is for undoing an unwanted *compiled* change (e.g. a bad manual edit inside the markers, or "I don't want this sync's output yet"), not for undoing what the graph itself now believes is true.

**Bug found while testing this, fixed the same day:** the first implementation reused `patchRegion` as-is, which decides NO_OP by comparing against the *cached* hash in `artifact_bindings` — correct for analyze/sync, where patchRegion is the only writer, but wrong for rollback, whose entire job is detecting content that drifted *without* going through patchRegion (a hand-edit). The cache doesn't know about that drift, so rollback silently did nothing in exactly the case it exists to handle. Fixed by adding `patchRegion({ ..., verifyAgainstDisk: true })`, which for rollback's call only compares against what's actually on disk right now instead of the cache. The analyze/sync hot path is unchanged and untouched by this.

---

## 2026-10-04 — v0.2: what was weak, and the shape of the fix

Dogfooding v0.1 on this repo produced a 228-line CLAUDE.md. Most of it was test helpers (`db`, `counter`, `REPO_ROOT`) labelled "export", fixtures were indexed as code, and `test/` was mis-globbed as `src/test/**`. The manifest still said change detection "arrives in Milestone 4". Meanwhile, 2026 research on context files is consistent: auto-generated files that restate discoverable code *hurt* agents, and what helps is short, non-discoverable, exact information, with commands first. The sources are the [ETH Zurich study](https://the-decoder.com/context-files-for-coding-agents-often-dont-help-and-may-even-hurt-performance/) and [GitHub's analysis of 2,500 AGENTS.md files](https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/). v0.2 is organised around that finding, not around adding features.

**Rejected:** a larger rewrite toward the architecture plan's IR/impact engine, LLM prose, or MCP. None of them fixes the trust problem, and all of them grow the surface that has to be trustworthy.

---

## 2026-10-04 — v0.2: AGENTS.md is canonical; pointer files are per-tool and opt-in by evidence

**Chosen:** `AGENTS.md` holds the always-loaded context. Tools that don't read it natively get a pointer file containing only an import line in that tool's syntax: `CLAUDE.md` (`@AGENTS.md`, Claude Code memory imports) and `GEMINI.md` (`@./AGENTS.md`, Gemini CLI's memory import processor). Pointers are emitted only when `agents:` lists the tool, or when the repo already shows it in use (`CLAUDE.md`/`.claude`, `GEMINI.md`/`.gemini`). All tool knowledge lives in one table, `src/artifacts/agents.ts`.

**Rejected:**

- **v0.1's duplicated overview/modules in both CLAUDE.md and AGENTS.md.** Two copies drift.
- **Copying content into every tool's native format** (`.cursor/rules`, `.github/copilot-instructions.md`, …). As of 2026, those tools read AGENTS.md natively (Codex, Cursor, Copilot, Windsurf, Zed, Cline, Jules), so copies add drift risk for no gain.
- **Always emitting CLAUDE.md.** It privileges one vendor and creates a file most repos don't need.

**Upgrade path:** a v0.1 config (`adapters.claude.enabled: true`) still yields CLAUDE.md. Its old `overview`/`modules`/`module:*` regions are removed on upgrade (they carry no hash, so they count as unedited), and human text is kept.

---

## 2026-10-04 — v0.2: always-loaded content changes only on structural change

**Chosen:** `AGENTS.md` sections carry no counts (files per module, symbols, import weights). Counts live in the on-demand docs (`ARCHITECTURE.md`, `.ai/manifest.md`). Adding a file to an existing module therefore never rewrites AGENTS.md. That keeps the agent's prompt cache warm (architecture plan §16) and git history readable.

**Accepted cost:** `.ai/manifest.md` ranks exported symbols by how many files import them, so a new import elsewhere can update a module card whose files didn't change. That is an honest change to what the card states, in a file that isn't always loaded.

---

## 2026-10-04 — v0.2: change detection by content hash, not `git diff <checkpoint>..HEAD`

**Chosen:** the graph's `files` table stores size, mtime and sha1 for each tracked file. `sync` stats every file and hashes only those whose size or mtime moved, or that fall in a 2-second "racy" window around the previous scan (the same rule git's index uses). It re-parses only files whose hash changed. Deleted paths cascade-delete their symbols and imports.

**Why:** v0.1's approach had real false negatives:

- A deleted file never marked its module stale, so its symbols stayed forever.
- Renames lost the old path.
- A rebased-away checkpoint SHA crashed sync with a misleading message.
- Uncommitted edits were invisible.
- `analyze` wrote no checkpoints, so the first `sync` rescanned everything.

Content hashing has none of these failure modes. It also works without git, and it is file-granular instead of module-granular.

**Supporting choices:**

- **Imports are stored raw and resolved at render time** against the current file set. Adding a file that satisfies an existing import updates the dependency graph without re-parsing the importer.
- **Module membership isn't stored at all.** It's a pure function of path and config, so changing module overrides needs no re-parse or migration.
- **A `parser_version` in `meta`** forces one full re-parse when extraction logic changes.

**Rejected:** keeping git as the change source "because the architecture plan says so" (§13). The plan's goal is correct incremental recompute. Git history was a means to that, and the wrong one for a tool that works on the working tree.

---

## 2026-10-04 — v0.2: ownership and integrity live in the markers, not the graph

**Chosen:** markers carry a hash of the content CtxKeep wrote: `<!-- ctxkeep:start:<id> sha=<12 hex> -->` … `<!-- ctxkeep:end:<id> -->`. NO_OP is decided by comparing against what's on disk. `artifact_bindings` is removed.

**Why:** `graph.sqlite` is gitignored, so on any teammate's clone v0.1 had no bindings. Hand-edits inside markers were silently overwritten, and `rollback` found nothing to roll back. With the hash in the file, every clone can tell "generated, untouched" apart from "edited by hand". Hand-edited regions are reported as conflicts (exit 1) and are never overwritten or removed without `--force`. Named end markers mean a stray end marker can't close the wrong region.

**Also changed:**

- Markers inside fenced code blocks are ignored, so docs can show examples.
- Malformed marker pairs fail only that one file, with a line number.
- The file's dominant line ending (LF or CRLF) is preserved, replacing v0.1's normalise-to-LF.
- Writes go to a temp file and are then renamed into place.

---

## 2026-10-04 — v0.2: the artifact system

**Chosen:** an artifact is a path plus an ordered list of sections in config. A section is a named, pure renderer over the context model (`src/artifacts/sections.ts`). New documentation types are config, not CLI code. The rules:

- **With `sections`, the list is authoritative.** Missing listed sections are inserted next to their neighbours, and known sections that aren't listed are removed (if unedited).
- **Without `sections` ("fill mode"),** only markers the author placed are filled, in place. This is how generated facts get embedded into a hand-written `DESIGN.md` without CtxKeep dictating its structure.
- **`{module}` (slug) and `{module_dir}` (folder) templates** produce per-module docs or nested `AGENTS.md` files. A file whose module vanished is deleted only if nothing human-written remains in it.

**Which artifacts are affected** is answered by rendering every artifact from the graph on each run and letting content comparison decide. Rendering takes milliseconds; parsing is the expensive part, and it stays incremental.

**Rejected:** per-section dependency declarations. A wrong declaration is a silent false negative, which is exactly the failure this release removes elsewhere.

---

## 2026-10-04 — v0.2: conventions are strict, value-keyed, and re-validated

**Chosen:**

- **Thresholds:** a candidate needs at least 3 samples and at least 80% agreement.
- **Only positive patterns are proposed.** v0.1's "N functions have no try/catch" described an absence, not a convention.
- **Detectors:** export style and multi-word file naming per module; test location and test naming repo-wide.
- **The id includes the detected value** (`src/api:export-style:named`). If the code flips style, a human's confirmation can't silently transfer to the new claim.
- **Every run re-detects.** Confirmed conventions that are no longer true are not emitted, and are reported as lapsed.
- **Statements are count-free,** so they don't churn AGENTS.md.

**Migration:** v0.1 graphs are migrated to schema `user_version` 2. Confirmed and rejected rows are re-keyed from folder names to path ids using the old `modules.path_glob`. Everything else in the graph is cache and is rebuilt.

---

## 2026-10-04 — v0.2: language coverage for "any project"

**Chosen:**

- **File-level tracking for every common source extension:** Swift, Kotlin, Java, Go, Rust, C#, C/C++, Ruby, PHP, Vue, Svelte, notebooks, and more. This gives layout, sizes and change detection.
- **Tree-sitter parsing for TS/JS and Python,** covering symbols and imports. JS/TS now includes `.jsx/.mjs/.cjs/.mts/.cts`, and resolution handles tsconfig `paths` aliases and the Python src layout.
- **A line-based extractor for Dart:** top-level types plus `import`/`part` directives, with `package:<self>/` resolution. It is reliable because `dart format` puts every top-level declaration at column 0, and it gives Flutter apps real symbols and dependency edges without a grammar.

**Rejected for now:** tree-sitter grammars for Swift, Kotlin, Go and Rust. Each would need the native peer-dependency pin from the first entry of this file re-validated, and would widen the prebuild matrix below. Artifacts state explicitly which languages are file-level only, rather than implying completeness.

**Stack facts and commands:**

- Stack facts come only from declared manifest data (dependency names, lockfiles, Gradle plugins, `Package.swift`, `*.xcodeproj`, `go.mod`, …), and each is rendered with its source.
- Standard toolchain commands (`flutter test`, `./gradlew test`, `go test ./...`, `cargo test`, `pytest`) are emitted only when the project defines no scripts or targets of its own.

---

## 2026-10-04 — v0.2: distribution is an npm CLI; native prebuild matrix

**Chosen:** CtxKeep ships as an npm package that exposes the `ctxkeep` binary. People can run it with `npx ctxkeep try`, install it with `npm i -D ctxkeep`, or install it globally. It works on non-JS projects; Node ≥ 20 is the only requirement on the machine. There is no stable programmatic API in v0.2.

**Verified 2026-10-04:** `npm pack`, then install into an empty project, then `npx ctxkeep try`/`analyze`/`sync`, on npm 11.17, Node 24, win32-x64. It works. Two facts are carried forward:

- **Prebuild coverage:** `tree-sitter@0.21.1` ships prebuilt binaries only for darwin-arm64, darwin-x64, linux-x64 and win32-x64. On linux-arm64 (Graviton CI, Docker on Apple Silicon) or Windows-on-ARM, install falls back to a source build that needs a C++ toolchain. This is the same class of risk as the `better-sqlite3` entries above; revisit it when bumping the tree-sitter pin.
- **npm install-script warnings:** npm 11 prints "allow-scripts" warnings for the install scripts of the five native packages. In 11.17 they are advisory (the binaries were in place). A future npm that blocks them by default would need `npm approve-scripts` documented.

Published to npm as `ctxkeep@0.2.0` on 2026-10-04.

---

## 2026-10-04 — v0.2.1: fixes from running on 18 real projects

`ctxkeep try` (read-only) was run on 18 of the maintainer's own projects: Next.js/React apps, Flutter, React Native/Expo, Express, Python AI agents, LangChain, a Python + Next.js full-stack app, a 2,200-file Tauri/Rust/TS monorepo, Java/Maven, Rust, and a Chrome extension. Each run was checked to have written nothing; all 18 were clean. Fixtures had missed these problems:

| Found | Fix |
|---|---|
| A repo holding several apps (`web/` with its own package.json, `mobile/` with its own pubspec.yaml) collapsed each app into one module and showed **no stack or commands**, because manifests were read only at the root. | Nested projects: any folder with its own manifest is a project root. Inference restarts inside it, and its stack and commands are reported with their source and the `cd` they need. Test and fixture folders never count. |
| Feature-first layouts (`lib/features/*`, `src/features/*`) were one module. | `features` is a container, and containers are descended through at any depth. |
| A Python project's single top-level package (`app/` with `memory/`, `tools/`, `voice/`) was one module. JVM projects were one module (`src/main/java/com/acme/…`). | `findDominantFolders`: in modules with 8+ source files, single-child chains are passed through, and a folder holding half or more of its project's source is split one level deeper (once). Test folders and small modules are left alone, since restructuring them only lengthened labels (`android/` → `android/app/`). |
| README-derived descriptions kept relative markdown links (`[FlexFit](../README.md)`), which break once copied into AGENTS.md. | Links and images are reduced to their text, in READMEs and doc comments (including `{@link X}`). |
| Vite's `.vite/` cache and minified bundles committed under `public/` were parsed as source: noise in the docs, and most of the parse time. | More tool caches are ignored by default, and generated or minified files are detected by content (generator banner, or average line > 300 chars) and never parsed or shown. |
| A 2,200-file monorepo took ~36 s for a full scan; ~95% of that was tree-sitter. | Parallel parsing on a worker-thread pool, kept synchronous for callers (Atomics.wait + receiveMessageOnPort), with a serial fallback and byte-identical output (verified). A full scan went from ~28 s to ~7 s. |
| git refused one repo ("dubious ownership"), and CtxKeep silently fell back to a filesystem walk. | A warning now says what happened and gives the exact `git config --global --add safe.directory` fix. |
| Long script lists buried dev/build/test under 25 lint variants. | Core commands (install, dev, start, build, test, lint, typecheck, check, format) come first, and the list is capped at 15. |

**Rejected:** child-process parallelism, because workers proved to work with the pinned tree-sitter binding and are cheaper; and making the pipeline async for workers, which would have churned every API and test for no user-visible gain.

---
