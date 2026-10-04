# CtxKeep

[![npm](https://img.shields.io/npm/v/ctxkeep)](https://www.npmjs.com/package/ctxkeep)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![status](https://img.shields.io/badge/status-v0.3%20%2F%20pre--1.0-orange)

CtxKeep keeps your project's agent context and documentation (`AGENTS.md`, `ARCHITECTURE.md`, per-module docs, and any markdown file you point it at) in sync with the code. It does this automatically and incrementally, and it never touches text you wrote yourself. It also **checks** that text: when your README or AGENTS.md mentions a command, file or function that no longer exists, `ctxkeep check` points to the exact line, and your coding agent can fix it.

It works on web, mobile, backend, and AI projects: TypeScript/JavaScript (including React/JSX), Python, and Dart/Flutter are indexed down to symbols and imports. Swift, Kotlin, Java, Go, Rust, C#, and more are tracked at the file level.

> **This repo uses CtxKeep on itself.** [`AGENTS.md`](AGENTS.md), [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`.ai/manifest.md`](.ai/manifest.md) are generated and kept current by CtxKeep, next to hand-written notes it never touches. CI runs `ctxkeep check` on every push.

## Why CtxKeep exists

Coding agents lose track of a project in two ways. Context rot sets in as the codebase outgrows what fits usefully in a context window. Session amnesia means every session starts cold. Hand-written `AGENTS.md`/`CLAUDE.md`/architecture docs help, but they drift: nothing keeps them true as the code changes. Generic LLM-written context files don't fix this either. [Research shows](https://the-decoder.com/context-files-for-coding-agents-often-dont-help-and-may-even-hurt-performance/) they mostly restate what an agent can read for itself, and they cost more than they help.

CtxKeep takes the opposite approach:

- **It states only facts it can back up.** It reads commands from your `package.json`/`Makefile` and frameworks from declared dependencies. It builds module dependencies from resolved imports. Conventions appear only after a human confirms them. When coverage is partial, it says so.
- **It keeps the always-loaded file small and stable.** `AGENTS.md` changes only when the project's structure changes, not every time a file is added. Detail lives in on-demand docs (`ARCHITECTURE.md`, `.ai/manifest.md`).
- **It patches incrementally.** Content hashes tell it exactly which files changed, committed or not. It re-parses only those and rewrites only the regions whose content actually differs.
- **It keeps your text safe.** Generated text lives between markers. Anything outside them is never modified. A region you edited by hand is never overwritten without `--force`.
- **It catches your text when it goes stale.** The non-obvious knowledge only humans can write is what helps agents most, and it's what silently rots. `ctxkeep check` verifies every command, path, link and code name it mentions against the code.

## Install

```bash
npm i -g ctxkeep
```

That's it: `ctxkeep` is now a command you can run in any repository, whatever language the project is written in. It needs **Node.js 20 or newer**.

Other ways to run it:

- **No install:** `npx ctxkeep try`
- **Per project** (e.g. to pin the version for CI): `npm i -D ctxkeep`, then run `npx ctxkeep …`

To run from source instead: `git clone https://github.com/danish-119/ctxkeep.git && cd ctxkeep && npm install && npm run build`, then `node dist/cli/index.js <command> /path/to/repo`, or run `npm link` to get a `ctxkeep` command.

Native dependencies: `tree-sitter` ships prebuilt binaries for macOS (arm64/x64), Linux x64, and Windows x64. On other platforms (e.g. Linux arm64), `npm install` compiles them and needs a C/C++ toolchain.

## Quick start

```bash
ctxkeep try                       # 1. see exactly what would be written, as a diff
ctxkeep init                      # 2. write .ctxkeep/config.yaml (commented; commit it)
ctxkeep analyze --dry-run         # 3. review
ctxkeep analyze                   #    ...and write
# ...edit code, as usual...
ctxkeep sync                      # 4. patch only what changed
ctxkeep check                     # 5. before committing / in CI: exit 1 if docs are stale or wrong
```

<!-- ctxkeep-ignore-start: example output from another repo -->
Real `sync` output after adding a new module (`src/api`) and editing a file in an existing one:

```text
Source changes: 1 modified, 1 added in src/api, src/utils — re-parsed 2 files.
Artifacts:
  updated    AGENTS.md        updated layout
  updated    ARCHITECTURE.md  updated architecture
  updated    .ai/manifest.md  updated module:src/utils; added module:src/api
```

Had the edit only added a function to `src/utils`, the only change would have been the `module:src/utils` region of `.ai/manifest.md`.
<!-- ctxkeep-ignore-end -->

## What gets generated

By default, CtxKeep maintains these files:

| File | Loaded | Contents |
|---|---|---|
| `AGENTS.md` | Always, by the agent | Project and stack (each fact cites its manifest), commands, layout, confirmed conventions. The single source of truth for every coding agent. |
| `ARCHITECTURE.md` | On demand | Module dependency graph (Mermaid plus a table with import counts), declared entry points, most-imported files. |
| `.ai/manifest.md` | On demand | One card per module: description, size, dependencies, exported symbols ranked by how often they're imported. |
| `CLAUDE.md`, `GEMINI.md` | Only for tools that need them | One import line pointing at `AGENTS.md`. See below. |

### Works with every coding agent

`AGENTS.md` is read natively by Codex, Cursor, GitHub Copilot, Windsurf, Zed, Cline, Jules, and others. Two tools need a pointer file instead. CtxKeep writes it in that tool's own import syntax, so there is never a second copy that can drift:

| Tool | File | Content |
|---|---|---|
| Claude Code | `CLAUDE.md` | `@AGENTS.md` |
| Gemini CLI | `GEMINI.md` | `@./AGENTS.md` |

Pointer files are created only when the repo already uses that tool (a `CLAUDE.md` or `.claude/`, a `GEMINI.md` or `.gemini/`), or when you list it in config (`agents: [claude, gemini]`). An existing hand-written `CLAUDE.md` keeps its text; the import is added below it. Tool-specific rule files (`.cursor/rules`, `.github/copilot-instructions.md`, …) are left alone. <!-- ctxkeep-ignore -->

## Maintaining your own docs

Every artifact is a path plus an ordered list of **sections**: named, code-grounded blocks of generated text. Adding a new kind of doc is a config change, not a code change.

```yaml
# .ctxkeep/config.yaml
artifacts:
  - path: AGENTS.md
    sections: [overview, commands, layout, conventions]
  - path: ARCHITECTURE.md
    title: Architecture
    sections: [architecture, key-files]
  - path: DESIGN.md                    # no `sections`: "fill mode"
  - path: docs/modules/{module}.md     # one design doc per module
    modules: ["src/*"]
    sections: [module-summary, module-api, module-files]
  - path: "{module_dir}/AGENTS.md"     # nested, folder-scoped agent context
    modules: ["src/*"]
    sections: [module-summary, module-api]
```

Sections available: `overview`, `commands`, `layout`, `conventions`, `architecture`, `key-files`, `key-abstractions`, `agents-import`, and the per-module `module`, `module-summary`, `module-api`, `module-files`.

- **With `sections`, the list is authoritative.** Missing sections are inserted next to their neighbours. A known section you remove from the list is removed from the file, unless you edited it by hand.
- **Without `sections` (fill mode),** CtxKeep fills only the markers you place yourself, exactly where you place them. This is how you embed generated facts in a hand-written `DESIGN.md`: <!-- ctxkeep-ignore -->

  ```md
  ## Domain model

  <!-- ctxkeep:start:key-abstractions -->
  <!-- ctxkeep:end:key-abstractions -->
  ```

- **`{module}` / `{module_dir}`** expand to one file per module, and `modules:` filters which ones. When a module disappears, its file is deleted if nothing human-written remains in it.

Modules are inferred from folders (`src/<name>`, `packages/<name>`, `lib/<name>`, …) and can be overridden in config, as can ignored paths. **Every option, section, and default is described in [docs/configuration.md](docs/configuration.md).**

## Catching docs that lie

Generated sections can't go stale. The text *you* write can: a README says `npm run test:unit` after the script was renamed, or AGENTS.md points at a folder that moved. `ctxkeep check` reads the hand-written parts of AGENTS.md, CLAUDE.md, README.md, CONTRIBUTING.md and any configured docs, and verifies every command, path, link and code name they mention against the real repo: <!-- ctxkeep-ignore: illustrative output -->

```text
Hand-written docs: 2 statement(s) no longer match the code:

  README.md:19  `app/page.tsx`: path does not exist (did you mean `app/(route)/page.tsx`?)
  AGENTS.md:31  `npm run test:unit`: `test:unit` is not a script in package.json (did you mean `test`?)
```

It only looks at text written as code (backticks, shell blocks) or as links, so ordinary prose never produces a finding. It accepts paths written relative to an app folder in a monorepo, and import paths without extensions. If a mention is hypothetical on purpose, add `<!-- ctxkeep-ignore -->` to the line (or wrap a passage in `ctxkeep-ignore-start` / `ctxkeep-ignore-end`), or list it under `drift.ignore` in config.

### Let your coding agent fix it

CtxKeep finds what's wrong deterministically; the AI you already use rewrites the text. Nothing calls an AI API, and you need no key.

- Generated AGENTS.md includes a short **"Keeping these docs true"** section telling every agent (Claude Code, Codex, Cursor, Copilot, …) to run `ctxkeep sync`, then `ctxkeep check`, and fix what it reports.
- `ctxkeep check --json` gives agents a precise list: file, line, what's wrong, and a suggested fix.
- In repos that use Claude Code, CtxKeep also maintains a **`/update-docs`** slash command that runs the whole loop.

You review the resulting diff like any other change.

## Safety model

- **Markers carry their own hash:** `<!-- ctxkeep:start:layout sha=1a2b3c4d5e6f -->`. On any clone, without any local state, CtxKeep can tell whether you edited a region since it was generated. If you did, `sync` reports a conflict, leaves the region alone, and exits 1. `--force` overwrites it.
- Text outside markers is never modified, and the file's line endings (LF or CRLF) are preserved.
- Writes are atomic per file (temp file plus rename).
- Malformed markers stop work on that file with the file and line number. CtxKeep never guesses where a region ends.
- `--dry-run` shows a unified diff and writes nothing, not even the graph. `try` doesn't even create `.ctxkeep/`.
- `ctxkeep rollback` restores every generated region to its content at git `HEAD`, and leaves human text alone.

## Commands

| Command | What it does |
|---|---|
| `ctxkeep try [path]` | Preview of everything `analyze` would write. No config needed, writes nothing. |
| `ctxkeep init [path]` | Writes a commented `.ctxkeep/config.yaml` with agent tools detected from the repo. |
| `ctxkeep analyze [path] [--dry-run] [--force]` | Full re-parse; use after upgrading CtxKeep or changing config. |
| `ctxkeep sync [path] [--dry-run] [--check] [--force]` | Incremental update. `--check` exits 1 if any generated section is stale. |
| `ctxkeep check [path] [--json]` | Verify everything, write nothing: generated sections are current, and hand-written docs mention no missing command, path, link or code name. Exits 1 otherwise. |
| `ctxkeep review conventions [path]` | Confirm, reject, or skip detected conventions (at least 3 samples, at least 80% agreement). |
| `ctxkeep rollback [path] [--dry-run]` | Restore generated regions to `HEAD`. |

Run `ctxkeep` with no arguments for an overview, and `ctxkeep <command> --help` for a command's options.

Exit codes: `0` on success; `1` on an error, on a hand-edit conflict, when `ctxkeep check` finds stale or wrong docs, or (with `sync --check`) when any generated section is out of date.

Commit `.ctxkeep/config.yaml` and `.ctxkeep/conventions.yaml` (your convention review decisions). `.ctxkeep/graph.sqlite` is a pure cache, ignored via `.ctxkeep/.gitignore`, so a fresh clone or a CI runner regenerates exactly the same docs.

Upgrading from v0.1? Run `ctxkeep analyze --dry-run` and read [docs/upgrading-to-v0.2.md](docs/upgrading-to-v0.2.md). Your config and convention decisions carry over, and there's a one-time diff in the generated files.

## Documentation

| Document | For |
|---|---|
| [docs/configuration.md](docs/configuration.md) | Every config option, section, template token, module rule, and default |
| [docs/upgrading-to-v0.2.md](docs/upgrading-to-v0.2.md) | What changes when moving from v0.1 |
| [docs/how-it-works.md](docs/how-it-works.md) | Contributors: the pipeline, change detection, marker format, and how to add sections, tools, and languages |
| [DECISIONS.md](DECISIONS.md) | Why each design choice was made, and what was rejected |
| [docs/ctxkeep-architecture-plan.md](docs/ctxkeep-architecture-plan.md) | The long-term vision (with notes where v0.2 deliberately diverges) |

## Development

```bash
npm install
npm run typecheck
npm test                 # unit + integration + golden-file suites
npm run build
```

The golden-file suite (`test/goldenFiles.spec.ts`) runs the real CLI against six fixture repos: plain TS, plain Python, mixed, a React/Vite web app, a Flutter app with Android/iOS shells, and a Python AI service. It compares every generated file byte-for-byte. After an intentional output change, regenerate the snapshots with `UPDATE_GOLDEN=1 npx vitest run test/goldenFiles.spec.ts` and review the diff. [docs/how-it-works.md](docs/how-it-works.md) covers the internals.

## Not here yet

LLM-written prose (CtxKeep makes no LLM calls; your own coding agent fixes the text `check` flags), an MCP server (next), watch mode and git-hook installation, a VS Code extension, symbol-level indexing for Swift, Kotlin, Java, Go, and Rust, and token-scored pruning (fixed caps are used instead). See `DECISIONS.md` for why each is deferred.

## License

MIT. See `LICENSE`.
