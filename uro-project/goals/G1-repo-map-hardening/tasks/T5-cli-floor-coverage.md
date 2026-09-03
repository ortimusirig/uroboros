## Title
T5: The flag and the builder agree, and coverage reconciles bidirectionally

## Required behavior
Read the goal spec two directories up (spec.md); settled rule 5 and run-9 findings S3/S7 are binding.
- src/args.js is MIXED CRLF — byte-preserving edits only (its carriage-return count must stay exactly 134; test/args.test.js must stay exactly 179; verify with a byte count of CR characters before and after, and check git diff --stat for phantom churn; if your editing tool normalizes line endings, splice bytes with a small node script instead).
- --map-budget refuses values below MINIMUM_MAP_BUDGET (import the constant from src/repo-map.js, never a literal) with a message naming the flag, the received value, and the floor; malformed values name the repair.
- A real process test: spawning node bin/loop.js decompose with a below-floor --map-budget exits 2 and stderr names the flag and the floor (run-9 S7 demands a genuine bin-level test, not a parseArgs re-call).
- src/repo-map.js: after final-rung classification (never before), a bidirectional coverage reconciliation asserts every declared row exists in the classified set and every classified path is declared somewhere (rendered, too-large, omitted, binary, or withheld) — a bare count equality is insufficient. On mismatch the map refuses loudly (internal-error message naming the direction of the mismatch) rather than rendering an untrue map.
- Update the determinism-and-caps audit table for any bound this task adds; extend docs/usage.md's --map-budget paragraph with the floor.

## Invariants
- src/args.js CR count 134 and test/args.test.js CR count 179 unchanged.
- Coverage checking cannot pass by counting; membership is checked in both directions with intentional-mismatch tests proving both failure modes.
- Budget sweep 0 violations. Zero runtime dependencies.

## Test requirements
- test/args.test.js (CRLF-safe): below-floor and malformed --map-budget messages.
- test/repo-map.test.js: intentional missing-declaration and extraneous-declaration fixtures each fail the reconciliation with the direction named; a clean map passes.
- A bin-level spawn test (node child_process spawning bin/loop.js) asserting exit code 2 and the stderr content for the below-floor flag.
- Run: node --test test/repo-map.test.js AND node --test test/args.test.js — all green.

## Out of scope
New CLI flags. Any behavior change for valid budgets above the floor.
