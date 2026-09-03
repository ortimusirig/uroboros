## Title
T5b: The flag and the builder agree, and coverage reconciles honestly on EVERY rung — including the last-resort one

## Required behavior
This unit re-attempts T5 (T5-cli-floor-coverage.md — read it first; every requirement there still binds) with one landing-review refusal to repair. Claude refused the previous attempt with this finding, which is now a requirement:

The compactFallback rung's `renderCompactFallback` returned `declaredPaths: new Set(entries.map(e => e.path))` — built from the exact same `entries` array, with the exact same map expression, as the `classifiedPaths` the reconciliation compares against. Two Sets constructed identically from identical input are always equal, so the coverage check on the last-resort rung could never throw regardless of what was actually rendered or omitted — a tautology, precisely the bare identity settled rule 5 forbids, on the rung most likely to accumulate future accounting bugs.

Fix requirement:
- On EVERY return path including compactFallback, `declaredPaths` must be derived from what was ACTUALLY rendered or explicitly declared-omitted — for the fallback rung, parse the rendered output text (or track render decisions in the rendering code path itself, independently of the input entries) so the reconciliation compares two independently-derived sets.
- A mutation-control test per rung: intentionally break each renderer (drop one path from its output/declarations) and assert `reconcileRepoMapCoverage` throws naming the missing-declaration direction; intentionally declare an extra path and assert the extraneous direction. The compactFallback rung MUST have both controls — the previous attempt's isolated hand-built-Set tests could not see the tautology.
- Everything else from T5 unchanged: the CRLF byte-preservation rules (src/args.js CR count exactly 134, test/args.test.js exactly 179), --map-budget floor via the imported MINIMUM_MAP_BUDGET with repair-naming messages, the bin-level spawn test asserting exit code 2 and stderr naming the flag and floor, the audit-table update, and the docs/usage.md floor sentence.

## Invariants
- No coverage check may be satisfiable by construction: each comparison's two sides must come from independent derivations (input classification vs actual render/declaration).
- src/args.js CR 134 and test/args.test.js CR 179 unchanged; git diff --stat shows no phantom churn.
- Budget sweep 0 violations; the 41 existing repo-map tests stay green. Zero runtime dependencies.

## Test requirements
- All of T5's test requirements, PLUS the per-rung mutation controls described above (a temporarily-broken renderer per rung proving the reconciliation genuinely fails in both directions, restored before commit — or implemented as injectable render hooks if cleaner in the house style).
- Run: node --test test/repo-map.test.js AND node --test test/args.test.js — all green.

## Out of scope
Re-doing T1–T4 (landed). New CLI flags. Any behavior change for valid budgets above the floor.
