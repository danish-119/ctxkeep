# How CtxKeep works

This is a contributor-level tour of the v0.2 implementation. For the reasoning behind each choice, and the alternatives that were rejected, see [`DECISIONS.md`](../DECISIONS.md).

## The pipeline

`try`, `analyze`, and `sync` all run one pipeline (`src/pipeline.ts`):

```text
refresh graph  →  build model  →  detect conventions  →  plan artifacts  →  render against disk  →  write
 (incremental)     (pure)          (pure + DB upsert)      (from config)      (pure, reads files)     (atomic)
```

| Stage | Code | What it does |
|---|---|---|
| Refresh | `src/analysis/refresh.ts` | Brings `.ctxkeep/graph.sqlite` in line with the working tree. The only incremental stage. |
| Model | `src/analysis/model.ts` | Builds the `ContextModel` from the graph and manifests: files, modules, symbols, resolved imports, stack, commands. |
| Conventions | `src/analysis/conventions.ts`, `src/graph/conventions.ts` | Re-detects candidate patterns and keeps human review decisions. |
| Plan | `src/artifacts/plan.ts` | Expands config into concrete files and regions, including per-module templates, agent pointer files, and orphaned per-module files. |
| Render | `src/artifacts/sections.ts`, `src/compiler/apply.ts` | Computes each file's new text without writing anything. |
| Write | `src/artifacts/plan.ts` (`writeArtifacts`) | Temp file plus rename, one file at a time. Skipped by `try`, `--dry-run`, and `--check`. |

Only the refresh stage is incremental, because parsing is the expensive part. Everything after it re-runs over the whole model each time, which takes milliseconds. Comparing content then decides what actually changes, so no artifact can be missed because a dependency was declared wrong. Previews run on an in-memory copy of the graph, so even the refresh isn't persisted.

## Change detection

The `files` table records `size`, `mtime_ms`, `content_hash` (sha1), `parse_status`, and `doc_summary` for every tracked file. A refresh:

1. Lists files with `git ls-files -z --cached --others --exclude-standard`. That covers tracked and untracked files and honours every git ignore source. Outside git, it walks the filesystem and reads the root `.gitignore`. Built-in and configured ignores are applied in both cases.
2. Skips a file without reading it if its size and mtime are unchanged and it was last modified more than 2 seconds before the previous scan started. Files modified inside that window are always re-hashed, the same "racy clean" rule git's index uses.
3. Hashes the remaining files. Same hash: only the mtime is updated. New hash: the file is queued for parsing, unless its content shows it's generated or minified (a generator banner, or an average line over 300 characters in a file over 10 KB). Generated files are recorded but never parsed or shown in artifacts.
4. Parses every queued file. For 100 or more files this runs on a worker-thread pool (`src/analysis/parsePool.ts`); the main thread waits on a shared counter and collects results synchronously, so the pipeline stays synchronous. On a 2,200-file monorepo that cut a full scan from ~28 s to ~7 s. Below the threshold, or if workers can't start, parsing is serial; the output is identical either way. `CTXKEEP_PARSE_THREADS` overrides the thread count, and `1` disables the pool.
5. Writes everything in one transaction, replacing changed files' symbols and imports.
6. Deletes graph rows for paths that no longer exist. Symbols and imports cascade. A rename is a delete plus an add.

A `parser_version` stored in `meta` forces one full re-parse when extraction logic changes, so an upgrade never leaves symbols from an older parser behind. `analyze` always re-parses everything.

What is stored and what is derived:

- **Stored:** per-file parse output. Imports are stored **raw** (specifier plus imported names).
- **Derived on every run:** import resolution, module membership, symbol reference counts, and dependency edges. Adding a file that satisfies an existing import, or changing module overrides, needs no re-parse.

## Parsing

| Language | Parser | Extracts |
|---|---|---|
| TS/JS | tree-sitter (`tree-sitter-typescript`, `tree-sitter-javascript`; JSX through the JS grammar) | Top-level functions, classes, interfaces, types, enums, variables; ES and CommonJS exports with default-ness; `import`/`export … from`/`require`; leading `/** */` doc |
| Python | tree-sitter | Top-level functions, classes, UPPER_CASE constants; public = no leading `_` (or `__all__`); `import`/`from … import`; module docstring |
| Dart | line-based (`src/analysis/dartParser.ts`) | Column-0 classes, mixins, enums, typedefs; `import`/`export`/`part`; leading `///` doc |
| Others | none | File-level tracking only |

Parsers are cached per grammar. Input is fed through a read callback to get around node-tree-sitter 0.21's 32 KB string limit. Files over 512 KB aren't parsed.

## Modules

A module id **is** its folder path (`src/api`, `test`, or `.` for the root). Each run builds one resolver with `createModuleResolver` in `src/analysis/modules.ts`, and every caller (model, sync messages, `init`) uses it, so ids always agree. The rules, in order:

1. Config overrides match first.
2. Inference restarts inside nested projects, i.e. folders with their own manifest (`findProjectRoots` in `src/analysis/projects.ts`).
3. Container directories (`src`, `lib`, `packages`, `features`, …) are descended through at any depth.
4. `findDominantFolders` adjusts modules with 8 or more source files, based on the real file layout. Single-child folder chains are passed through, and a folder holding half or more of its project's source is split one level deeper, at most once.

A module is a test module when every file in it is a test or fixture file. Test files are counted but never indexed.

## Sections and artifacts

A section (`src/artifacts/sections.ts`) is `{ name, scope: 'project' | 'module', render(ctx, module?) }`. Renderers are pure functions of the model, with stable ordering and no clocks. An artifact is a config entry: a path plus ordered sections.

`planArtifacts` turns the configured artifacts into `ArtifactPlan`s. Each plan has a concrete path, a header for new files, the desired regions in order, and a `resolve(id)` function. `resolve` handles regions found on disk that aren't in the desired list:

- **content:** a marker placed in fill mode, or a module section; it gets filled.
- **`'orphan'`:** the region describes a module that's gone, a section no longer listed, or a retired v0.1 region; it gets removed.
- **`null`:** an unknown id; it's left untouched and reported.

Templates (`{module}`, `{module_dir}`) produce one plan per module. Plans are also created to clean up existing files that match the template but whose module no longer exists.

Agent pointer files come from `src/artifacts/agents.ts`. It's one table of tools that don't read `AGENTS.md` natively, each with its file name, import syntax, and repo evidence. `resolveArtifactConfigs` adds one `agents-import` artifact per resolved tool.

## Regions and markers

```md
<!-- ctxkeep:start:<id> sha=<first 12 hex of sha256(content)> -->
<content>
<!-- ctxkeep:end:<id> -->
```

`src/compiler/markers.ts` parses markers line by line:

- Markers must be on their own line.
- Markers inside fenced code blocks are ignored.
- Nesting, duplicates, mismatched or unclosed ends throw a `MarkerError` that names the file and line.
- v0.1 markers (no `sha`, generic `<!-- ctxkeep:end -->`) parse as `legacy`.

`applyRegions` in `src/compiler/apply.ts` computes a file's new text from its current text and the desired regions:

- **Unchanged:** content already correct and not a legacy marker. Nothing changes; if every region is unchanged, the file isn't written at all.
- **Updated:** the content differs and the region is unedited, meaning the recorded `sha` matches its current content or it's legacy.
- **Conflict:** the content differs, but the region was edited by hand (the `sha` doesn't match). It's left as is unless `force` is set.
- **Added:** inserted after the nearest preceding desired region already in the file, else before the nearest following one, else appended after a single blank line.
- **Removed:** orphans that are unedited. One adjacent blank line goes with them, so add/remove cycles don't accumulate whitespace.

Text outside markers is passed through byte for byte. The file's dominant line ending is detected and kept.

Because each marker carries its own hash, safety doesn't depend on local state. Any clone, CI runner, or `rollback` can tell generated content from hand edits.

## Drift checking (`ctxkeep check`)

Generated regions can't go stale. Hand-written text can, and it's the text that matters most to agents. `src/drift/` checks it in two steps:

1. **`extract.ts`** reads the human parts of each doc. It skips generated regions, `ctxkeep-ignore` lines and blocks, and non-shell code blocks. From what's left it collects references written as code or links:
   - commands in backticks or shell blocks (`npm`/`pnpm`/`yarn`/`bun` scripts, `make` targets, tracking `cd` within a line and across the lines of a block);
   - paths in backticks;
   - markdown link targets;
   - code names in backticks (`Foo.bar()`, multi-hump identifiers).
2. **`verify.ts`** checks each reference against the real repo:
   - commands against the `package.json`/`Makefile` of the directory they run in;
   - paths and links against the file listing, accepting extension/index variants and paths that match the end of a real path (monorepo-relative mentions), and skipping gitignored, package, placeholder and out-of-repo paths;
   - code names against indexed symbols, then the source text.

   Suggestions come from the closest script name (edit distance) or the unique file with the same name, never from tests or fixtures.

The rules were tuned on 18 real projects. The final run reported 4 findings, of which 3 were real stale statements and 1 a deliberate mention of a library API. `check` runs the sync pipeline in preview mode for freshness, then drift, and exits 1 if either finds something; `--json` returns `{ ok, stale, drift, fix }` for agents. `sync` prints a short drift reminder but doesn't fail on it.

## Rollback

`src/compiler/rollback.ts` reads each artifact at HEAD (`git show HEAD:./<path>`, which works from a subdirectory too) and parses its regions. It then runs `applyRegions` with HEAD's regions as the desired set and `force` enabled, so hand edits inside regions are reverted. Regions added since HEAD are kept and reported. A file deleted since HEAD is restored whole.

## The graph

`src/graph/schema.ts` (schema v2): `files`, `symbols`, `imports`, `conventions`, `meta`. Everything except confirmed and rejected rows in `conventions` is a regenerable cache. `src/graph/db.ts` migrates v0.1 graphs (keeping review decisions and re-keying their module ids), refuses graphs from newer versions, and turns a corrupt file into an actionable error.

## Tests

| Suite | Covers |
|---|---|
| `test/analysis/*` | Parser output, import resolution, module inference, stack and command detection, convention detection |
| `test/compiler/*` | Marker parsing and region application (the safety contract), rollback |
| `test/graph/*` | Convention lifecycle, v0.1 migration, corrupt or newer graphs |
| `test/pipeline.spec.ts` | In-process integration: change detection, module lifecycle, safety, artifact system, agent pointers, determinism |
| `test/cli/cli.spec.ts` | The real CLI as a subprocess: exit codes, messages, the full demo loop |
| `test/goldenFiles.spec.ts` | Byte-exact output for six fixture repos, and the run-twice-no-op property |

Regenerate golden snapshots after an intentional output change with `UPDATE_GOLDEN=1 npx vitest run test/goldenFiles.spec.ts`, and review the diff.

## Adding things

- **A new section:** add a `SectionDef` to `SECTIONS` in `src/artifacts/sections.ts`. It must be a pure function of the model and state only what the model can back up. It's then usable from config, with no CLI changes.
- **A new agent tool that doesn't read AGENTS.md:** add an entry to `POINTER_TOOLS` in `src/artifacts/agents.ts`.
- **A new stack fact or framework:** add it to the dependency tables in `src/analysis/stack.ts`. Every fact needs a manifest source.
- **A new language at file level:** add its extension in `src/analysis/languages.ts`. Parsing it needs an extractor wired into `parseFile`, an entry in `PARSED_LANGUAGES`, and import resolution in `src/analysis/imports.ts`. Bump `PARSER_VERSION` whenever extraction output changes.
