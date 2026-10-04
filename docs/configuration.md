# Configuration reference

CtxKeep reads `.ctxkeep/config.yaml`. The file is optional: with no config, every setting below takes its default. `ctxkeep init` writes a commented copy for your repo. Commit it.

Unknown keys are rejected rather than silently ignored, so a typo such as `artifact:` fails with a clear message instead of doing nothing.

```yaml
version: 2

agents: [claude]            # pointer files for tools that don't read AGENTS.md

artifacts:                  # the documents CtxKeep maintains
  - path: AGENTS.md
    sections: [overview, commands, layout, conventions]
  - path: ARCHITECTURE.md
    title: Architecture
    sections: [architecture, key-files]
  - path: .ai/manifest.md
    title: Module index
    sections: [module]

modules: []                 # module boundary overrides
ignore: []                  # extra paths to exclude
```

| Key | Type | Default |
|---|---|---|
| [`version`](#version) | number | (informational) |
| [`agents`](#agents) | list of `claude`, `gemini` | detected from the repo |
| [`artifacts`](#artifacts) | list of artifacts | AGENTS.md, ARCHITECTURE.md, .ai/manifest.md |
| [`modules`](#modules) | list of `{ path, name? }` | `[]` (all inferred) |
| [`ignore`](#ignore) | list of gitignore patterns | `[]` |
| [`adapters`](#adapters-v01) | v0.1 setting | (only read when `agents` is absent) |

---

## `version`

The config format version. `init` writes `2`. It's informational; CtxKeep doesn't change behaviour based on it.

## `agents`

`AGENTS.md` is the single source of truth for every coding agent. Most tools read it directly, so they need nothing extra. These include Codex, Cursor, GitHub Copilot, Windsurf, Zed, Cline, and Jules.

Two tools don't read it by default. For each one you list, CtxKeep maintains a pointer file that contains only an import line in that tool's own syntax:

| Value | File | Generated content |
|---|---|---|
| `claude` | `CLAUDE.md` | `@AGENTS.md` |
| `gemini` | `GEMINI.md` | `@./AGENTS.md` |

- **Omitted:** detected on every run. `claude` is used if the repo has a `CLAUDE.md` or `.claude/`; `gemini` if it has a `GEMINI.md` or `.gemini/`.
- **`agents: []`:** no pointer files, even if those files exist.
- **Existing files are kept.** If `CLAUDE.md` already has your own notes, the import region is added below them, and your text is never modified.
- A pointer file is skipped if `artifacts` already lists that path, so you can give it custom sections instead.

Tool-specific rule files (`.cursor/rules`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`, …) are never touched. `init` lists any it finds.

## `artifacts`

Each entry is one document, or one per module when the path is a template.

| Field | Required | Meaning |
|---|---|---|
| `path` | yes | Repo-relative path. May contain `{module}` or `{module_dir}`; see [Per-module files](#per-module-files). |
| `sections` | no | Ordered list of [sections](#sections). Omit it for [fill mode](#fill-mode). |
| `modules` | no | Module-id globs limiting which modules module-scoped sections or files cover, e.g. `["src/*"]`. Default: every non-test module. |
| `title` | no | A `# Title` heading written once, when CtxKeep creates the file. After that it's yours to edit. |
| `enabled` | no | `false` turns the artifact off without deleting the entry. |

Omitting `artifacts` gives the defaults: `AGENTS.md`, `ARCHITECTURE.md`, and `.ai/manifest.md`, plus pointer files from [`agents`](#agents). Listing `artifacts` replaces the defaults entirely, so include `AGENTS.md` if you want it.

### Sections

A section is a named block of generated text. Each one states only what analysis can back up, and renders identically for identical code.

**Project sections** produce one region per artifact:

| Section | Contents |
|---|---|
| `overview` | Project name and description, languages, detected stack (each fact with the manifest it came from), and pointers to the other configured docs. |
| `commands` | `package.json` scripts, run through the package manager the lockfile indicates, and `Makefile` targets. If the project defines none, standard toolchain commands for a manifest that's present (`flutter test`, `./gradlew test`, `go test ./...`, `cargo test`, `pytest`), labelled as such. Capped at 25. |
| `layout` | One row per module: path, kind (source or tests), languages, and a description taken from the module's own `README.md` or entry-file doc comment. The description column appears only when at least one module has one. Capped at 40 rows. |
| `conventions` | Conventions confirmed with `ctxkeep review conventions` that still hold in the code. |
| `architecture` | Module dependency graph from resolved imports: a Mermaid diagram (up to 60 edges) and a table of files, depends-on, and used-by with import counts. |
| `key-files` | Entry points declared in manifests (`package.json` `bin`/`main`, `pyproject.toml` scripts) and the 10 most-imported source files. |
| `key-abstractions` | The 20 most-referenced exported classes, interfaces, types, and enums. |
| `agents-import` | The pointer import line used by `CLAUDE.md`/`GEMINI.md`. |

**Module sections** produce one region per module, with id `<section>:<module id>`:

| Section | Contents |
|---|---|
| `module` | Full card: heading, description, size, dependencies, exported symbols (up to 40, most-imported first). |
| `module-summary` | Heading, description, size, and dependencies; no symbol list. |
| `module-api` | Exported symbols only. |
| `module-files` | Every file in the module, with its own doc-comment summary when it has one. |

In a normal artifact, a module section expands to one region per module. In a [per-module file](#per-module-files), it renders just that file's module.

AGENTS.md is loaded into every agent session, so its default sections deliberately contain no counts. Adding a file therefore doesn't rewrite it. Counts live in the on-demand docs.

### How `sections` behaves

- **The list is authoritative.** Listed sections are kept present, and a missing one is inserted next to its neighbours in list order. A known section that isn't listed is removed from the file, unless you edited it by hand.
- **Order on first creation** follows the list. After that, regions stay wherever they are in the file, so you can move them.
- Text outside regions is never touched.

### Fill mode

An artifact with no `sections` key is managed in **fill mode**. CtxKeep only fills the markers you put in the file yourself, exactly where you put them, and adds or removes nothing else. Use it to embed generated facts in a hand-written document:

```yaml
artifacts:
  - path: DESIGN.md
```

```md
# Design

## Domain model

The core types, kept current by CtxKeep:

<!-- ctxkeep:start:key-abstractions -->
<!-- ctxkeep:end:key-abstractions -->

## Why we split billing out
...your own prose...
```

Module sections work too: `<!-- ctxkeep:start:module-api:src/billing -->` … `<!-- ctxkeep:end:module-api:src/billing -->`. If that module is later deleted, its region is removed.

`init` adds `DESIGN.md`, `docs/DESIGN.md`, `docs/design.md`, or `docs/architecture.md` in fill mode when it finds one.

### Per-module files

A path containing a template token produces one file per module:

| Token | Expands to | Example |
|---|---|---|
| `{module}` | a file-safe slug of the module id | `docs/modules/{module}.md` → `docs/modules/src-api.md` |
| `{module_dir}` | the module's own folder; must start the path | `{module_dir}/AGENTS.md` → `src/api/AGENTS.md` |

```yaml
artifacts:
  - path: docs/modules/{module}.md          # a design doc per module
    modules: ["src/*"]
    sections: [module-summary, module-api, module-files]
  - path: "{module_dir}/AGENTS.md"          # nested, folder-scoped agent context
    modules: ["src/*"]
    sections: [module-summary, module-api]
```

Nested `AGENTS.md` files are applied by Cursor, Copilot, Cline, and Codex only when an agent works inside that folder. That makes them a tool-agnostic way to give scoped context. `{module_dir}` never generates a file for the root module, since that would be the root `AGENTS.md` itself. Quote paths that start with `{`, as YAML requires.

When a module disappears, its file is deleted if nothing human-written is left in it. Otherwise only the generated regions are removed and your text stays.

### Module-id globs (`modules:` filter)

| Pattern | Matches |
|---|---|
| `src/*` | `src/api`, `src/cli` (exactly one level below `src`) |
| `src/**` | `src` and everything below it |
| `packages/w*` | `packages/web`, `packages/worker` |
| `**` | every module |

Without a `modules:` filter, test modules are left out. With one, every module that matches is included, test modules too.

## `modules`

Modules are inferred from folders:

- A file in the repo root belongs to the root module, shown as `(root)`.
- Otherwise the first folder is the module, e.g. `app`, `android`, `test`.
- If the first folder is a container directory (`src`, `lib`, `packages`, `apps`, `libs`, `services`, `modules`, `cmd`, `internal`, or `pkg`), the first two folders form the module, e.g. `src/api` or `packages/web`. A file directly inside the container, such as `src/index.ts`, belongs to `src`.

A module whose files are all tests or fixtures is a test module. Test directories are `test`, `tests`, `__tests__`, `spec`, `specs`, `e2e`, `testing`, `integration_test`, `androidTest`, `fixtures`, and `__fixtures__`. Test files are `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.{py,go,dart}`, and `*Test(s).{swift,kt,java,cs}`. Test files are counted but their symbols aren't indexed.

Override inference where it's wrong. Entries are checked in order and the first match wins:

```yaml
modules:
  - path: src/features/*     # one module per folder under src/features
  - path: src/legacy/**      # everything under src/legacy is a single module
```

Module ids are recomputed on every run, so changing overrides needs no re-parse. Run `ctxkeep sync` and the artifacts follow. `name` is accepted for readability but not used, because module ids are always the folder path.

## `ignore`

Extra patterns to exclude, in `.gitignore` syntax. CtxKeep already honours git's ignores, including nested `.gitignore` files, `.git/info/exclude`, and global excludes, by listing files with `git ls-files`. Outside a git repo it reads the root `.gitignore`.

```yaml
ignore:
  - "src/generated/"
  - "**/*.pb.ts"
```

These are always excluded, even without a `.gitignore`: `node_modules/`, `dist/`, `build/`, `out/`, `coverage/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `.turbo/`, `.cache/`, `.parcel-cache/`, `.expo/`, `vendor/`, `venv/`, `.venv/`, `__pycache__/`, `.mypy_cache/`, `.pytest_cache/`, `.ruff_cache/`, `.tox/`, `.ipynb_checkpoints/`, `Pods/`, `DerivedData/`, `.gradle/`, `.dart_tool/`, `target/`, `bower_components/`, `*.min.js`, and `*.bundle.js`. To re-include one that really is source code in your project, negate it:

```yaml
ignore:
  - "!build/"
```

Files over 512 KB are tracked but not parsed, since they're almost always generated or vendored.

## `adapters` (v0.1)

The v0.1 setting `adapters: { claude: { enabled: true|false } }` is still accepted. It's only read when `agents` is absent: `true` adds `CLAUDE.md`, `false` suppresses it even if detected. New configs should use `agents`. See [upgrading](upgrading-to-v0.2.md).

---

## Languages

| Coverage | Languages |
|---|---|
| Symbols and imports (tree-sitter) | TypeScript (`.ts .tsx .mts .cts`), JavaScript (`.js .jsx .mjs .cjs`), Python |
| Symbols and imports (line-based) | Dart: top-level classes, mixins, enums, typedefs, and `import`/`export`/`part` directives |
| File level only | Swift, Kotlin, Java, Go, Rust, C#, C, C++, Objective-C, Ruby, PHP, Scala, Elixir, Vue, Svelte, Jupyter |

File-level languages still appear in layout, sizes, stack detection, and change detection. Generated docs say explicitly when a module's symbols aren't indexed.

Import resolution handles relative imports, TypeScript ESM `.js` → `.ts` specifiers, `index` files, `tsconfig.json`/`jsconfig.json` `paths` aliases (e.g. `@/*`), Python relative imports, absolute imports from the repo root or a `src/` layout, `from pkg import submodule`, and Dart relative or `package:<your app>/…` imports. Imports of third-party packages are treated as external.

**Public symbols:** an ES `export` (or CommonJS `module.exports`/`exports.x`) in JS/TS. In Python, a top-level name not starting with `_`, or exactly the names in `__all__` when it's defined; UPPER_CASE module constants count too. In Dart, a top-level type not starting with `_`.

## Conventions

`ctxkeep review conventions` shows up to 10 pending candidates at a time. A candidate needs at least 3 samples and at least 80% agreement. These patterns are detected:

| Pattern | Scope | Example statement |
|---|---|---|
| export style | per JS/TS module | "Files in `src/api/` use named exports only (no default exports)." |
| file naming | per module, multi-word names only | "Multi-word file names in `src/ui/` are PascalCase." |
| test location | repo | "Tests live in a separate `tests/` tree, not next to source files." |
| test naming | repo | "Test files are named `test_*.py`." |

Confirmed conventions go into the `conventions` section while they still hold in the code. One that stops holding is dropped, and `sync` prints a warning. Rejected ones never come back. Review decisions are stored in `.ctxkeep/graph.sqlite`, the only data there that can't be regenerated.
