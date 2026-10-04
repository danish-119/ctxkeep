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
| [`drift`](#drift) | `{ files, ignore }` | README.md, CONTRIBUTING.md and artifacts are checked |
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
| `agent-workflow` | "Keeping these docs true": tells every coding agent to run `ctxkeep sync` then `ctxkeep check` after changing code, and to fix what `check` reports. Uses `npx ctxkeep` when CtxKeep is a project dependency. In the default AGENTS.md. |
| `agents-import` | The pointer import line used by `CLAUDE.md`/`GEMINI.md`. |
| `update-docs-command` | Body of an agent slash command that runs the sync → check → fix loop. Generated as `.claude/commands/update-docs.md` (Claude Code's `/update-docs`) when the repo uses Claude Code. |

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
- **Container directories** are descended through, at any depth: `src`, `lib`, `packages`, `apps`, `libs`, `services`, `modules`, `features`, `cmd`, `internal`, and `pkg`. So `src/api/x.ts` → `src/api`, and `lib/features/auth/login.dart` → `lib/features/auth`. A file directly inside a container, such as `src/index.ts`, belongs to the container (`src`).
- **Nested projects:** a folder with its own manifest (`package.json`, `pubspec.yaml`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `pom.xml`, `composer.json`, `Gemfile`) is a project of its own, and inference restarts inside it. In a repo with `web/` and `mobile/` apps, `web/src/app/page.tsx` → `web/src/app`. Each nested project's stack and commands are also reported, attributed to its manifest and prefixed with the `cd` they need (`cd web && npm run dev`). Fixture and test folders never count as projects.
- **Large modules are split where the code actually branches.** This applies only to modules with 8 or more source files, and never to test folders:
  - A folder with no files of its own and a single subfolder is passed through. This finds JVM package roots, e.g. `src/main/java/com/acme/…`.
  - A folder holding at least half of its project's source, with two or more subfolders, is split one level deeper. Typically that's a Python project's single top-level package (`app/`, `mypackage/`). Modules created this way are never split again.

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

These are always excluded, even without a `.gitignore`: `node_modules/`, `dist/`, `build/`, `out/`, `coverage/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `.turbo/`, `.cache/`, `.parcel-cache/`, `.vite/`, `.angular/`, `.astro/`, `.output/`, `.vercel/`, `.netlify/`, `.wrangler/`, `.docusaurus/`, `.serverless/`, `.terraform/`, `.yarn/`, `.pnpm-store/`, `storybook-static/`, `.expo/`, `vendor/`, `venv/`, `.venv/`, `__pycache__/`, `.mypy_cache/`, `.pytest_cache/`, `.ruff_cache/`, `.tox/`, `.ipynb_checkpoints/`, `Pods/`, `DerivedData/`, `.gradle/`, `.dart_tool/`, `target/`, `bower_components/`, `*.min.js`, and `*.bundle.js`. To re-include one that really is source code in your project, negate it:

```yaml
ignore:
  - "!build/"
```

Files over 512 KB are tracked but not parsed, since they're almost always generated or vendored.

**Generated and minified files** are tracked for change detection but are never parsed or shown in any document. CtxKeep recognises them by content alone: a generator banner in their first lines (`@generated`, `Code generated … DO NOT EDIT`, `auto-generated`, `This file was generated`, `DO NOT EDIT this file`), or minified text (a file over 10 KB whose average line is longer than 300 characters).

If git refuses to read a repository ("dubious ownership", which happens when the folder belongs to another OS user), CtxKeep falls back to walking the filesystem and honours only the root `.gitignore`. It prints a warning naming the exact `git config --global --add safe.directory …` command that fixes it.

## `drift`

Settings for `ctxkeep check`, which verifies the **hand-written** parts of your docs against the code. Generated regions are never checked; they're correct by construction.

```yaml
drift:
  files: ["docs/*.md", "packages/*/README.md"]   # extra docs to check (gitignore-style globs)
  ignore: ["legacy/old-api.ts", "npm run deploy"] # references never to report, exactly as written
```

**Checked by default:** every configured artifact (AGENTS.md, CLAUDE.md, ARCHITECTURE.md, …), plus `README.md` and `CONTRIBUTING.md` at the root.

**What gets verified.** Only text written as code (inside backticks, or in a shell code block) or as a markdown link is considered, so ordinary prose never produces a finding.

| Reference | Example | Reported when |
|---|---|---|
| Command | `npm run test:unit`, `cd web && pnpm dev`, `make lint` | The script or target doesn't exist in that project's `package.json` or `Makefile`. A `cd` on one line of a shell block applies to the lines after it. A `cd` into a folder outside the repo (clone instructions) isn't checked. |
| Path | `src/auth/session.ts`, `docs/` | No such file or folder exists. Also accepted: paths relative to the doc, paths written relative to an app folder in a monorepo (`src/lib/x` for `web/src/lib/x`), import paths without an extension, and bare file names that exist anywhere. |
| Link | `[guide](docs/setup.md)` | The target doesn't exist, relative to the doc. |
| Code name | `PaymentService.charge()`, `formatPrice` | Some part of the name appears nowhere in the code. Runtime globals (`JSON.parse()`, `useState`, …) are exempt. |

**Never reported:** gitignored paths (`.env`, `dist/`), package names and subpaths (`react/jsx-runtime`, `@scope/pkg`), URLs, routes (`/api/users`), globs, placeholders (`path/to/…`, `your-app`, `MyPanel.ts`), paths that lead outside the repo (`../src/` written from a subfolder), and files CtxKeep generates.

**Silencing a deliberate mention.** Put a marker on the line, optionally with a reason (markers are invisible when the markdown renders):

```md
We don't use Drizzle's `withReplicas`. <!-- ctxkeep-ignore: library API, not ours -->

<!-- ctxkeep-ignore-start: example output from another repo -->
...
<!-- ctxkeep-ignore-end -->
```

Findings include a suggestion when the code has an obvious replacement: the closest script name, or a moved file's new location.

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
