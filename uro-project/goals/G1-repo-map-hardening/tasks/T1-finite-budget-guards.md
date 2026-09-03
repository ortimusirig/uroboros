## Title
T1: The budget is finite, floored, and repairable — loudly

## Required behavior
Read the goal spec two directories up (spec.md) — its "Settled semantics" section is binding. In src/repo-map.js buildRepoMap:
- A budget that is not a finite number (NaN, Infinity, non-number) is refused with an Error whose message names the received value verbatim and states the repair ("must be a finite number of characters, e.g. 12000").
- A malformed numeric STRING (e.g. "12k", "12000" passed as a string) is refused with a message that names the received value and tells the caller to pass a number (parse or convert it) — settled rule 7 requires a direct buildRepoMap test for this exact case.
- A finite budget below MINIMUM_MAP_BUDGET is refused naming both the value and the floor constant's current value.
- Valid budgets at exactly MINIMUM_MAP_BUDGET keep working (existing floor tests stay green).

## Invariants
- Feedback over refusal: every rejection message states what was received AND how to repair it.
- No behavior change for valid finite budgets; the budget sweep in test/repo-map.test.js stays at 0 violations.
- Zero runtime dependencies.

## Test requirements
- New tests in test/repo-map.test.js (house style): NaN, Infinity, "12k", "12000"-as-string, 0, and MINIMUM_MAP_BUDGET minus 1 each refused with messages asserting the received value and the repair phrasing; MINIMUM_MAP_BUDGET accepted.
- Run: node --test test/repo-map.test.js — all green.

## Out of scope
CLI flag parsing (T5). Binary detection (T2). Read bounding (T4).
