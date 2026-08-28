# Fix the bound/pivot interaction found by both verifier seats

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

`PIVOT_AMEND` is recorded but never performed when circling is first detected on
the final allowed round

## Context — the defect

Both verifier seats reported this independently on the commit that introduced the
debate driver, and it was confirmed by reading `src/run.js`.

In the debate loop, when circling is detected:

```js
if (circling) {
  const pivotDecision = selectPivot(debatePivotCount);
  finalPivotDecision = pivotDecision;          // records 'amend'
  debatePivotCount++;
  reportEvent(..., 'debate', 'pivot', { decision: pivotDecision, ... });
  if (pivotDecision === PIVOT_FRESH || pivotDecision === PIVOT_CONCLUDE) { ... break; }
  amendPlan = true;
}

if (debateRound >= maxDebateRounds) {
  outcome = 'needs-pivot';
  debateStopReason = 'rounds-exhausted';
  break;                                        // leaves before the amend
}
...
if (amendPlan) fixPlan = amendFixPlanWithLedger(fixPlan, debateLedger);   // unreachable
```

`detectCircling` needs three recorded rounds, so with `URO_DEBATE_ROUNDS=3` — the
**lowest bound at which the pivot path is reachable at all** — circling is first
detected on round 3. The code then selects `PIVOT_AMEND`, records it, emits
`debate/pivot decision=amend`, and immediately breaks as `rounds-exhausted`.

Two consequences:

1. **The promised behaviour does not happen.** `PIVOT_AMEND` means "amend the
   plan with what the ledger learned and retry once". No amend and no retry occur.
2. **The facts contradict themselves.** `finalPivotDecision: 'amend'` is recorded
   alongside `stopReason: 'rounds-exhausted'`, describing a pivot that never took
   place.

The test suite cannot catch it: every circling test uses `debateRounds` of 4 or
5, so none reaches the bound while a pivot is pending, and the amend test never
asserts that the plan text actually changed — so a skipped amend still passes.

## Required behavior

**A pivot decision must only be recorded and emitted when it will be acted on.**

When circling is detected on a round that is also the last allowed round:

- Emit `debate/circling` as today — that observation is real and must not be lost.
- Do **not** select a pivot, do **not** increment `debatePivotCount`, do **not**
  set `finalPivotDecision`, and do **not** emit `debate/pivot`.
- Stop with `debateStopReason: 'rounds-exhausted'`, and leave
  `finalPivotDecision` null.

`PIVOT_FRESH` and `PIVOT_CONCLUDE` are unaffected: both stop the loop themselves,
so recording them is always truthful. Only `PIVOT_AMEND` — the one decision that
promises a further round — must be suppressed when no further round is available.

Equivalently: the amend path may only be entered when a subsequent round can
actually run.

## Invariants

- `debate/circling` is still emitted whenever circling is detected, including on
  the final round. The detection is real information.
- No change to `detectCircling`, `shouldPivot`, or the pivot constants in
  `src/debate.js`. The defect is in the driver, not the state machine.
- `PIVOT_FRESH` still produces `needs-pivot` with the ledger; `PIVOT_CONCLUDE`
  still stops without claiming success.
- A run that never circles behaves exactly as it does today.
- `debatePivotCount` counts pivots actually taken, never pivots merely considered.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

1. **The reported case:** `debateRounds: 3` with a finding persisting three
   rounds stops with `stopReason: 'rounds-exhausted'`, `finalPivotDecision` null,
   `debatePivotCount` 0, and **no `debate/pivot` event** — while a
   `debate/circling` event **is** emitted.
2. **The amend path still works when a round remains:** with `debateRounds: 4`
   and circling detected on round 3, a pivot is recorded, and the plan sent to
   the executor on round 4 **actually contains the ledger amendment text**.
   Assert on the plan text captured by a spy executor, not merely on the event —
   this is the assertion whose absence hid the defect.
3. `PIVOT_FRESH` on the final allowed round still produces `needs-pivot` with the
   ledger, because it stops the loop itself.
4. `PIVOT_CONCLUDE` on the final allowed round still stops and does not report
   success.
5. `debatePivotCount` never counts a suppressed pivot.
6. **Positive control:** a run that never circles records no pivot events and is
   unchanged from current behaviour.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Changing the default `URO_DEBATE_ROUNDS`, or the bound's semantics.
- STORM regeneration after `needs-pivot`.
- Anything in `debate.js`, `review.js`, or `fix-plan.js`.
- The transcript UI.
