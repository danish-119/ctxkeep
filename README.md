# CtxKeep

CtxKeep keeps `CLAUDE.md`, `AGENTS.md`, and `.ai/manifest.md` in sync with your actual codebase — automatically, incrementally, and without ever touching content you wrote by hand.

It parses your repo with [tree-sitter](https://tree-sitter.github.io/tree-sitter/), tracks what's changed since the last commit it looked at, and patches only the parts of those files that need it — leaving everything else, including any hand-written prose sharing the same file, byte-for-byte untouched.

This is the MVP described in `docs/ctxkeep-mvp-build-spec.md`. If you want the reasoning behind a specific design choice, check `DECISIONS.md` first — it's a running log of what was chosen, what was rejected, and why.

## Requirements

- Node.js ≥ 20 (npm ships with Node, no separate install needed)
- A git repository (CtxKeep reads git history for change detection; it works on TypeScript, JavaScript, and Python files)

## Setup

```bash
git clone <this-repo>
cd ctxkeep
npm install
npm run build
```

Everything below assumes you're running the CLI via `npm run dev --` (which runs the TypeScript source directly) or the built `node dist/cli/index.js`. Either works identically.

## The 4-command demo loop

This is the entire MVP loop end to end, run against any real repo.

### 1. `ctxkeep try` — see the value with zero setup

```bash
$ npm run dev -- try /path/to/some/repo
```

Walks the repo, parses every `.ts`/`.tsx`/`.js`/`.py` file, and prints the `CLAUDE.md` it *would* generate as a diff against nothing. **Writes zero files.** No config, no `.ctxkeep/` directory, nothing on disk changes — this is the "see if it's worth adopting" command.

### 2. `ctxkeep init && ctxkeep analyze` — adopt it for real

```bash
$ npm run dev -- init /path/to/some/repo
Wrote .ctxkeep/config.yaml
Detected typescript across 8 module(s), 36 file(s).
Next: run `ctxkeep analyze` to populate the graph.

$ npm run dev -- analyze /path/to/some/repo
Analyzed 36 file(s).
Wrote 8 module(s) and 132 symbol(s) to .ctxkeep/graph.sqlite
Detected 16 convention candidate(s) (existing confirm/reject decisions preserved).
Compiled 14 region(s): 14 written, 0 unchanged (no-op).
```

`init` scaffolds `.ctxkeep/config.yaml` (committed to git — it's config, not build state). `analyze` does the full baseline scan: populates `.ctxkeep/graph.sqlite` (gitignored — it's regenerable, like `node_modules`) and writes `CLAUDE.md`, `AGENTS.md`, and `.ai/manifest.md` with `<!-- ctxkeep:start:... / ctxkeep:end -->` marker regions.

Run `analyze` again right now with no code changes — it will report `0 written` and touch nothing. That's not an incidental property; it's the thing the whole compiler is built around (see `docs/ctxkeep-mvp-build-spec.md` §5).

### 3. Edit some code, commit it

```bash
$ echo 'export function newThing() {}' >> src/somemodule/file.ts
$ git add -A && git commit -m "add newThing"
```

Any normal commit. CtxKeep doesn't need to know about this in advance.

### 4. `ctxkeep sync` — patch only what changed

```bash
$ npm run dev -- sync /path/to/some/repo
Resynced module "somemodule" (5 symbol(s)).
Resynced module "othermodule" (3 symbol(s)).
HEAD is 5f2a91c. 2/8 module(s) resynced.
Compiled 14 region(s): 2 written, 12 unchanged (no-op).
```

`sync` runs `git diff <last-checkpoint-sha>..HEAD` to see what changed, maps changed files to modules (folder = module), re-parses only the stale ones, and recompiles only their regions.

**Note on the very first `sync`:** `analyze` never writes to the `checkpoints` table — only `sync` does. So the *first* `sync` you run has no prior checkpoint to diff against, and per the "no checkpoint = everything stale" rule (build spec §4 Milestone 4), it resyncs **every** module once, to establish a baseline. That's expected, not a bug — you'll see every module listed above. Make a *second* edit and commit, then run `sync` again:

```bash
$ echo 'export function anotherThing() {}' >> src/somemodule/file.ts
$ git add -A && git commit -m "add anotherThing"
$ npm run dev -- sync /path/to/some/repo
Resynced module "somemodule" (6 symbol(s)).
HEAD is 8a1c204. 1/8 module(s) resynced.
Compiled 14 region(s): 1 written, 13 unchanged (no-op).
```

*Now* only `somemodule` is stale. Check `git diff` on `CLAUDE.md`: the change is scoped to exactly the `module:somemodule` region — every other region, including `othermodule`'s, the manifest, and `AGENTS.md`, is byte-identical. This was verified directly against a real fixture repo while writing this README (two real `sync` runs, second one scoped to one module out of two) — not a hypothetical.

## Other commands

| Command | What it does |
|---|---|
| `ctxkeep review conventions [path]` | Interactively confirm/reject/skip up to the top 10 pending inferred conventions (by confidence). Confirmed ones appear in `CLAUDE.md`'s Conventions section; rejected ones never resurface; skipped ones reappear next run. |
| `ctxkeep rollback [path]` | Reverts every CtxKeep-owned region back to its content as of the last git commit (`HEAD`), without touching human-owned content elsewhere in the same file. See `DECISIONS.md` for exactly what this does and doesn't undo. |

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test             # vitest run — includes the golden-file suite in test/fixtures/
npm run build        # compile to dist/
```

The golden-file suite (`test/goldenFiles.spec.ts`) spawns the actual CLI as a subprocess against small fixture repos in `test/fixtures/` and compares the output against checked-in snapshots — it's the one place in the test suite that exercises the real `init`/`analyze` pipeline the way a user actually invokes it, rather than calling internal functions directly.

## What's deliberately not here yet

This is an MVP, not the full system described in `ctxkeep-architecture-plan.md`. No LLM calls anywhere in the default path, no plugin system, no adapters beyond Claude, no VS Code extension, no MCP server, and no real symbol-level impact analysis (change detection is module-level: "any file in a module changed" marks the whole module stale, not a precise dependency graph). `docs/ctxkeep-mvp-build-spec.md` §6 has the full, current list of what's cut and what breaks if you forget it's cut.

## License

MIT — see `LICENSE`.
