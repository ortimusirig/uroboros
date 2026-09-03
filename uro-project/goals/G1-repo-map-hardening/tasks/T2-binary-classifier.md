## Title
T2: Binary files are classified conservatively and disclosed, never line-counted

## Required behavior
Read the goal spec two directories up (spec.md); settled rule 6 is binding. In src/repo-map.js:
- Detection operates on raw buffer evidence (the read already yields bytes): a NUL byte anywhere marks binary, AND a conservative heuristic catches non-NUL binaries (for example: a high fraction of bytes outside printable-ASCII plus common whitespace within the sampled prefix). The heuristic's exact rule is stated in a code comment and DISCLOSED in the rendered map's treatment note.
- String inputs from test doubles keep working (classify the string's characters by the same rule).
- A binary file is never line-counted and never symbol-scanned; its row states the treatment (for example "binary — not line-counted").
- The disclosure survives fallback rungs: under a tight budget where the binary's row is trimmed, the omission accounting still covers it truthfully (no undisclosed treatment) — run-9 finding S6.

## Invariants
- Conservative direction: uncertain content may be called binary (losing a line count) but text is never silently treated as binary without the row saying so.
- Budget sweep stays at 0 violations. Zero runtime dependencies.

## Test requirements
- test/repo-map.test.js: a non-NUL binary buffer (dense high bytes) is classified binary; a text control of the same length is not; a binary file with a source extension (.js name, binary content) is neither line-counted nor symbol-scanned; a tight-budget case where the binary row falls to a fallback rung still accounts for it.
- Run: node --test test/repo-map.test.js — all green.

## Out of scope
Read bounding and admission (T4). Symbol accounting states (T3).
