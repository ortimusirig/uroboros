# Implement src/debate.js — Debate Loop State Machine

## Title
Debate loop state machine with circling detection and pivot escalation

## Required behavior

Create `src/debate.js` that exports:

1. **`DebateLedger` class** — tracks findings across debate rounds.
   - `record(round, findingIds)` — record which finding IDs appeared in a round
   - `round(n)` — return the finding IDs for round n (empty array if not recorded)
   - `currentRound` — getter, returns the highest recorded round number (0 if none)
   - `allFindings()` — return a Set of all unique finding IDs seen across all rounds
   - `resolvedFindings()` — return a Set of finding IDs that appeared in earlier rounds but NOT in the latest round
   - `stuckFindings()` — return a Set of finding IDs present in ALL of the last 3 consecutive rounds. Returns empty set if fewer than 3 rounds recorded.

2. **`detectCircling(ledger)`** — determine if the debate loop is circling.
   - Returns `true` if ANY of:
     - A finding ID appears in all of the last 3 consecutive rounds
     - The total finding count is NOT decreasing over the last 3 consecutive rounds
   - Returns `false` if fewer than 3 rounds recorded
   - Returns `false` if all findings eventually resolve (last round is empty)

3. **`shouldPivot(pivotCount)`** — determine the escalation strategy.
   - `pivotCount === 0` → return `PIVOT_AMEND`
   - `pivotCount === 1` → return `PIVOT_FRESH`
   - `pivotCount >= 2` → return `PIVOT_CONCLUDE`

4. **Pivot strategy constants** — exported:
   - `PIVOT_AMEND` — a distinct non-empty string
   - `PIVOT_FRESH` — a distinct non-empty string
   - `PIVOT_CONCLUDE` — a distinct non-empty string

## Invariants

- Do NOT modify the test file `test/debate.test.js`
- Pure functions and a simple class, zero external dependencies
- ESM module style matching the rest of the codebase
- The DebateLedger does NOT run the loop — it only tracks state. The loop driver will be in run.js.

## Out of scope

- REVIEW.md parsing (that's in review.js)
- Fix plan generation (that's in fix-plan.js)
- Integration with run.js (that's a separate unit)
- Any changes to existing files
