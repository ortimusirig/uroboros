## Title
T4: Content work is bounded before it happens, by a named admission rule

## Required behavior
Read the goal spec two directories up (spec.md); settled rules 2, 3, 4 and the run-9 enforcement-order findings are binding. In src/repo-map.js:
- A NAMED admission rule computes, from the operator budget alone, which paths may be content-read, in what order, and up to what count ceiling — before any readFile. Doubling the tracked-file count must not double readFile calls; actual reads never exceed the computed ceiling.
- Size is gated BEFORE content: an admitted path's size is checked via stat metadata first, and the content read itself is bounded to at most ceiling-plus-one bytes (an injectable read adapter makes this testable) — a too-large file is never fully read or split; it becomes the admitted-but-too-large state.
- Per-file identity is three-way on every rung: inspected / admitted-but-too-large / omitted — each declared.
- A budget-derived, self-declared per-file byte ceiling is mandatory (settled rule 3) and joins the determinism-and-caps audit table in docs/superpowers/specs/2026-09-01-decomposition-spine-design.md in the same commit, per the table's closure clause.
- Pre-read row-space reservation derives from a single template registry using true maxima (longest actual path, count widths, ceiling widths, bounded symbol payloads) — never a fixed-width or "representative" estimate (settled rule 4, run-9 S4).
- Stat failures are conservative and visible: the path stays declared with a metadata-unavailable state, never silently dropped.

## Invariants
- No unbounded work on any path: bytes, read calls, and reservations are all budget-derived and self-declared.
- The map remains correct and self-declaring at exactly MINIMUM_MAP_BUDGET (attempted survey with zero inspections is legitimate and declared).
- Budget sweep 0 violations. Zero runtime dependencies.

## Test requirements
- test/repo-map.test.js with injectable stat/read adapters: a large synthetic tree (around 1,700 files) and its doubled twin under the same budget assert identical read ceilings, actual reads within ceiling, and a POSITIVE expected read count (not merely calls-below-ceiling — run-9 S5); an oversized admitted file asserts the read adapter was invoked with the bounded length and the file lands in admitted-but-too-large; a stat-failure fixture asserts the declared state; a reservation test asserts a longest-path row still fits its reserved space after classification.
- Run: node --test test/repo-map.test.js — all green.

## Out of scope
CLI wiring (T5). Binary rule internals (consume T2's classifier as landed).
