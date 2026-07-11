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

Once a convention is confirmed or rejected via `ctxkeep review conventions`, its status is permanent — `upsertConventions` refreshes `statement`/`confidence` on re-analysis but never touches `status` (by design, see the entry above this one). This means a **confirmed** convention keeps appearing in `CLAUDE.md` even if the underlying code later stops following that pattern (e.g. a module that was 9/9 named-exports at confirmation time drifts to 4/9 after refactoring) — nothing currently detects or flags that drift. Known MVP limitation, not a bug, not fixed yet.

---

## 2026-07-11 — Known gap: module deletion/rename orphans that module's `conventions` rows

`conventions.module_id` references `modules.id`, but nothing deletes or re-keys existing convention rows when a module disappears (folder removed) or is effectively renamed (folder renamed, which this project's folder-based module inference treats as a brand-new module id). The old rows stay in the table forever, referencing a `module_id` that no longer resolves to anything in `modules` — orphaned, not cleaned up. Same class of gap as the "module = folder, no removal handling" cut already noted for `persistAnalysis`/`persistModuleSymbols`; not fixed yet.

---

## 2026-07-11 — `ctxkeep rollback` regenerates from git HEAD; it does not restore from its own history

**Chosen:** `ctxkeep rollback` reverts each CtxKeep-owned region to its content **as of the last git commit (HEAD)**, by reading the historical file content via `git show HEAD:<path>`, extracting that region's content with `extractRegionContent` (the exact inverse of `patchRegion`'s splice), and re-patching it into the current working-tree file through the normal `patchRegion` path.

**Rejected:** Extending `artifact_bindings` (or a new table) to retain prior content/hashes so rollback could restore from CtxKeep's own history, independent of git.

**Why:** `artifact_bindings` currently stores only the latest hash per (artifact, region) — by design, it's a cache-validity table for the NO_OP check, not a history log (contrast with `checkpoints`, which is deliberately append-only — see the entry above). Since `CLAUDE.md`, `AGENTS.md`, and `.ai/manifest.md` are committed to git (decided in Milestone 2), **git already has full history of every version of these files** — building a parallel history mechanism in SQLite would duplicate what git does better (arbitrary point-in-time restore, not just one step back) and would need its own storage-growth/pruning story. The architecture plan §22 itself frames `ctxkeep rollback` as "equivalent to `git checkout` on CtxKeep-owned regions specifically" — this implementation takes that literally rather than inventing a second history store.

**Scope cut for MVP:** only rolls back to HEAD, not `--to <tag|sha>` (mentioned as a future flag in architecture plan §22). Reading an arbitrary historical ref is the same mechanism (`git show <ref>:<path>`) — adding the flag later is a small extension, not a redesign.

**Known limitation, stated explicitly in the CLI's own output:** this reverts the *compiled file* to match HEAD; it does not undo anything in the graph (`modules`/`symbols`/`conventions`). If nothing in the source code changed, the next `ctxkeep analyze`/`sync` recomputes the same facts from the graph and can reintroduce the exact content rollback just reverted. This is expected, not a bug — the same way reverting a generated build artifact doesn't stop the next build from regenerating it. Rollback is for undoing an unwanted *compiled* change (e.g. a bad manual edit inside the markers, or "I don't want this sync's output yet"), not for undoing what the graph itself now believes is true.

**Bug found while testing this, fixed the same day:** the first implementation reused `patchRegion` as-is, which decides NO_OP by comparing against the *cached* hash in `artifact_bindings` — correct for analyze/sync, where patchRegion is the only writer, but wrong for rollback, whose entire job is detecting content that drifted *without* going through patchRegion (a hand-edit). The cache doesn't know about that drift, so rollback silently did nothing in exactly the case it exists to handle. Fixed by adding `patchRegion({ ..., verifyAgainstDisk: true })`, which for rollback's call only compares against what's actually on disk right now instead of the cache. The analyze/sync hot path is unchanged and untouched by this.

---
