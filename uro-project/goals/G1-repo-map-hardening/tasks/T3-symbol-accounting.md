## Title
T3: Symbol-scan accounting distinguishes its three states on every rung

## Required behavior
Read the goal spec two directories up (spec.md); settled rule 1 is binding. In src/repo-map.js, for every fallback rung including collapsedNoSymbols:
- Three states are tracked and declared separately: scan-ran-with-results-rendered, scan-ran-but-result-withheld (trimmed by budget), and scan-never-ran.
- symbolsSkipped (and any equivalent self-description) counts ONLY scans that never ran; a scanned-empty file counts as ran-with-zero-results, not skipped; a scanned-but-unrendered result is declared as withheld, not skipped.
- The rendered map's omission notes name the counts per state where nonzero, in the existing self-declaring style.

## Invariants
- No rung may describe a completed scan as withheld work or vice versa (the "false when scans ran and only results were removed" defect from the deliberation record).
- Budget sweep 0 violations; existing symbol tests stay green. Zero runtime dependencies.

## Test requirements
- test/repo-map.test.js: fixtures forcing each state on at least two different rungs (including collapsedNoSymbols): assert the three counts independently and that symbolsSkipped equals exactly the never-ran count; a scanned-empty file asserts zero contribution to skipped.
- Run: node --test test/repo-map.test.js — all green.

## Out of scope
Which files get admitted for scanning (T4). Coverage reconciliation (T5).
