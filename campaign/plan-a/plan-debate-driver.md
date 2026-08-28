# Drive the debate loop from run.js

## IMPLEMENT THIS NOW

This design is **APPROVED**. Do not stop to ask for design approval, do not
propose an alternative and wait — write the code, add the tests, run the gate.
Producing no diff is a failed pass.

If you genuinely cannot proceed without a decision from the operator, write
`DECISION.md` in the worktree root using this exact shape and stop:

```
## Q1
Kind: technical | product | authority
Question: <one line>
Options: <one line>
Recommendation: <one line>
```

## Title

Wire `debate.js`, `review.js` and `fix-plan.js` into the run as a bounded review
loop

## Context

Three modules exist and are fully tested, and **nothing drives them**:

- `src/debate.js` — `DebateLedger`, `detectCircling`, `shouldPivot`,
  `PIVOT_AMEND` / `PIVOT_FRESH` / `PIVOT_CONCLUDE`
- `src/review.js` — `parseReview`, `detectReview`; blocking findings must name a
  test or are demoted to suggestions
- `src/fix-plan.js` — turns findings into executor work

Today `run.js` verifies exactly once. The verifier emits a verdict and the run
ends. A reviewer that finds a real bug **cannot cause it to be fixed** — its
findings are prose in a report, and the operator re-runs by hand.

## Required behavior

### 1. A bounded debate loop after the gate passes

Replace the single verify step with a loop:

```
gate passes
  → verify (existing two seats, unchanged)
      → no blocking findings  → converged, outcome review-ready
      → blocking findings     → build a fix plan → re-run executor → re-run gate
                              → record the round in the ledger → repeat
```

- Findings come from `parseReview`/`detectReview`. Suggestions never drive
  another round; only blocking findings do.
- Each round records its finding ids in a `DebateLedger`.
- **Bound it.** A new `URO_DEBATE_ROUNDS`, default **2**, maximum **5**,
  validated like the existing integer settings. On exhaustion the run stops and
  reports honestly — it must not silently claim success.
- The gate must pass again after every fix round. A fix that breaks the gate
  fails the run exactly as a first-pass gate failure does.

### 2. Circling detection and pivot

After each round, consult `detectCircling(ledger)`:

- Not circling → continue.
- Circling → `shouldPivot(pivotCount)`:
  - `PIVOT_AMEND` — amend the existing plan with what the ledger has learned and
    retry once.
  - `PIVOT_FRESH` — stop with a new outcome **`needs-pivot`**, carrying the
    ledger (all findings seen, which recurred, which resolved, the round
    history). The approach itself is wrong; regenerating the plan is a
    campaign-level concern and is out of scope here.
  - `PIVOT_CONCLUDE` — stop and report honestly. Never report success.

### 3. Events — declare before emitting

Emit `debate/round`, `debate/resist`, `debate/converged`, `debate/circling`,
`debate/pivot`.

**Declare `debate` in `EVENT_STAGES`, and every new type in `EVENT_TYPES`, and
every pair in `EVENT_PAIRS`, in the same change.** An undeclared stage makes
`createEvent` throw and `reportEvent` swallow it — the defect already fixed twice
in this repository, for `decision` and for `executor/extended`. Do not repeat it.

If the conformance ratchet in `test/events.test.js` then reports these pairs as
unemitted, resolve it honestly: substantive reasons and an updated count. Do not
weaken `assertEventConformance` and do not remove its `future-stage/start`
negative control.

### 4. Facts and report

`uro-runfacts.json` gains a `debate` section: rounds run, findings per round,
resolved and stuck finding ids, whether circling was detected, pivot count and
final pivot decision. `uro-report.md` states how many rounds ran and why the
loop stopped — converged, rounds exhausted, circling, or pivot.

## Invariants

- **The gate remains the only thing that can pass a change.** A debate round
  cannot skip it, shorten it, or override its exit codes.
- A run with no blocking findings behaves exactly as today: one verify pass, one
  round recorded, outcome `review-ready`.
- The verifier stays read-only. Fixes are made by the executor, never by the
  reviewer.
- `UNVERIFIED` must never be treated as "no findings". A seat that did not
  produce a readable verdict cannot silently converge the loop.
- Existing outcomes keep their meanings and exit codes. `needs-pivot` is new.
- Zero external dependencies. ESM style matching the rest of the codebase.
- Do not modify `debate.js`, `review.js`, or `fix-plan.js`. They are tested; this
  task consumes them.

## Test requirements

Use injected executor, gate and verifier seams as the existing `run.test.js`
tests do. No test may call a real agent binary.

1. No blocking findings → one round, outcome `review-ready`, unchanged from
   today's behaviour. **This is the regression control.**
2. One blocking finding, fixed in round two → two rounds recorded, converged,
   `review-ready`.
3. A finding that persists across three rounds → `detectCircling` fires and the
   pivot path is taken.
4. `PIVOT_FRESH` produces outcome `needs-pivot` with the ledger in the facts.
5. `PIVOT_CONCLUDE` stops and does **not** report success.
6. `URO_DEBATE_ROUNDS` exhaustion stops the run and says so; it does not report
   `review-ready`.
7. A fix round that breaks the gate fails the run.
8. `UNVERIFIED` from a seat does not converge the loop.
9. Every `debate/*` pair round-trips through `createEvent` without throwing, and
   appears in `events.jsonl`.
10. Suggestions alone never trigger another round.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Wiring a `decisionResolver` so `DECISION.md` challenges are answered rather
  than halting. Separate task.
- STORM regeneration of a plan after `needs-pivot` — that is campaign-level.
- Cursor writing tests itself.
- The transcript UI.
