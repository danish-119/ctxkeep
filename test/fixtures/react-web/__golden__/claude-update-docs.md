---
description: Fix docs that no longer match the code (runs ctxkeep sync and check, then edits what they report)
---

<!-- ctxkeep:start:update-docs-command sha=f3ffeb47b204 -->
Bring this project's documentation back in line with the code.

1. Run `ctxkeep sync` to refresh the generated sections.
2. Run `ctxkeep check --json` and read the `drift` list. Each entry has a file, a line, what is wrong, and sometimes a suggestion.
3. For each entry, fix the hand-written text at that location so it matches the code. Use the suggestion when it is right; read the code when unsure. If a reference is intentionally hypothetical, add `<!-- ctxkeep-ignore -->` to that line instead.
4. Never edit between `ctxkeep:start` / `ctxkeep:end` markers.
5. Run `ctxkeep check` again until it reports nothing, then summarize what you changed.
<!-- ctxkeep:end:update-docs-command -->
