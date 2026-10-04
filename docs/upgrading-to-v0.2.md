# Upgrading from v0.1 to v0.2

Most of the upgrade is automatic: run `ctxkeep analyze` once and review the diff. This page explains what will change in your files, so the diff holds no surprises.

## The short version

```bash
ctxkeep analyze --dry-run   # review: expect a one-time diff in every generated file
ctxkeep analyze             # apply
git add -A && git commit -m "Upgrade CtxKeep to v0.2"
```

Your `.ctxkeep/config.yaml` keeps working as it is. Your convention review decisions are kept. Text you wrote outside CtxKeep's markers is not touched.

## What changes in your files

### CLAUDE.md becomes a pointer to AGENTS.md

v0.1 wrote the same overview and module list into both `CLAUDE.md` and `AGENTS.md`, plus per-module symbol lists in `CLAUDE.md`. In v0.2, `AGENTS.md` is the single source of truth, read by Codex, Cursor, Copilot, Windsurf, Zed, Cline, and others. `CLAUDE.md` gets one import line:

```md
@AGENTS.md
```

On upgrade, the old `overview`, `modules`, `module:*` and `conventions` regions are removed from `CLAUDE.md`. They carry no hash, which marks them as unedited CtxKeep output. Anything you wrote outside them stays. Your v0.1 config's `adapters.claude.enabled: true` keeps `CLAUDE.md` in the artifact set. To decide explicitly, replace it with [`agents`](configuration.md#agents):

```yaml
agents: [claude]          # or [claude, gemini], or [] for none
```

### AGENTS.md is restructured

It now contains `overview` (with the detected stack and pointers to the other docs), `commands`, `layout`, and `conventions`. Counts and per-module symbol lists moved out of it, so it changes only when the project's structure changes.

### Two new on-demand docs

- `ARCHITECTURE.md` holds the module dependency graph and key files.
- `.ai/manifest.md` holds one card per module with its exported symbols. It replaces the old verification-manifest table.

Don't want one of them? List your own [`artifacts`](configuration.md#artifacts) instead of relying on the defaults.

### Module names are now paths

v0.1 named modules by bare folder (`api`), and misnamed folders outside `src/`. v0.2 uses the real path (`src/api`, `test`, `packages/web`), so every module name in the docs is a path an agent can open. Region ids follow: `module:api` becomes `module:src/api`.

If your v0.1 config lists `modules:` entries such as `- { name: api, path: src/api/** }`, they still work. They're now treated as [overrides](configuration.md#modules), and since they match what inference produces anyway, you can delete them.

### The marker format gains a hash

```md
<!-- ctxkeep:start:layout sha=1a2b3c4d5e6f -->
...
<!-- ctxkeep:end:layout -->
```

Every region is rewritten once to the new format; `sync` reports these as `marker format upgraded`. From then on, CtxKeep can detect hand edits inside regions on any clone and won't overwrite them without `--force`.

## What happens to `.ctxkeep/graph.sqlite`

The graph is migrated in place the first time v0.2 opens it:

- **Convention decisions are kept.** Confirmed and rejected conventions are re-keyed to the new module ids. Pending ones are dropped and re-detected.
- **The rest is rebuilt.** Symbols, files, and imports are cache, and the next scan repopulates them. The `checkpoints` and `artifact_bindings` tables no longer exist.
- **v0.1's "error-handling" convention is gone,** confirmed or not, because v0.2 no longer proposes patterns of absence.

Conventions now need at least 3 samples and at least 80% agreement. A confirmed v0.1 convention that doesn't meet that bar, or no longer holds, is not emitted. `sync` warns about it rather than silently dropping it.

A graph written by a newer CtxKeep is refused with a clear message, not silently downgraded.

## Behaviour changes worth knowing

| v0.1 | v0.2 |
|---|---|
| `sync` saw only committed changes, via `git diff` since a stored commit | `sync` compares the working tree by content hash: uncommitted edits, deletes, and renames all count, and git isn't required |
| The first `sync` after `analyze` re-parsed everything | It's a no-op if nothing changed |
| Deleting a file left its symbols in the docs | They're removed |
| A deleted module's section stayed forever | It's removed (unless you edited it by hand) |
| Hand edits inside markers were overwritten | They're reported as a conflict (exit code 1) until you move them or pass `--force` |
| `analyze`/`sync` required `init` first | Both work without a config, using defaults |
| CRLF files were rewritten as LF | The file's own line endings are kept |
| `rollback` needed the local graph | It works from the files alone, on any clone |
| Only `.ts .tsx .js .py` | TS/JS (incl. JSX), Python, and Dart are indexed; Swift, Kotlin, Go, Rust, Java, and more are tracked at file level |

New flags: `--dry-run` on `analyze`, `sync`, and `rollback`; `--check` and `--force` on `sync` (`--force` on `analyze` too).
