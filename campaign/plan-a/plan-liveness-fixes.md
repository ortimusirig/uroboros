# Fix the two defects both verifier seats found in the liveness change

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

## Context

The liveness-as-conversation change is applied to the working tree and passes
685/685. Both verifier seats returned `ISSUES`, each finding a **different**
defect. Both were confirmed by hand before this plan was written.

## Defect 1 — a seat judged *working* is killed anyway

Reported by the correctness seat:

> *"In `src/spawn.js` (~368–374): `status === 'working'` with a bad
> `nextIntervalMs` calls `unavailable()` → unjudged kill. In
> `src/liveness-judge.js` (~57–59): invalid `nextIntervalMs` discards the whole
> working JSON."*

A judge reads the evidence, concludes the seat is alive, and says so — and a
single malformed field in its answer throws the entire verdict away and kills the
seat as though no judge had answered at all.

**This is the exact failure the change exists to prevent, reintroduced in the
parsing.** A seat that has been judged working must not die because the judge's
cadence suggestion was unusable.

### Required behavior

- A `working` verdict is **honoured whenever the status is readable**, regardless
  of whether `nextIntervalMs` is usable.
- An unusable or absent `nextIntervalMs` falls back to **reusing the previous
  interval**, exactly as an absent one already does. It is never silently
  shortened, and never escalated to a kill.
- `unavailable()` is reserved for the case it was named for: **no judge answered
  at all.** A judge that answered badly is not a judge that did not answer.
- The malformed field is recorded — the operator should be able to see that a
  judge returned an unusable interval — but it does not change the outcome.

## Defect 2 — the facts path is untested

Reported by the intent seat, with a falsification recipe:

> *"Counterfactual: remove `decide(decision)` from `createLivenessDeadline` → all
> new tests stay green while production `facts.livenessChecks` stays empty."*

**Verified by hand.** All three `decide(decision)` calls in `src/spawn.js` were
commented out and the suite ran **685 tests, 685 passing**. Nothing depends on
the production path that records liveness decisions into the run facts.

The cause is precise: `test/liveness-judgement.test.js`'s run-integration test
calls `options.onLivenessDecision(...)` from inside a **stub** `runExecutor`, and
`deadlineHarness` never wires `onDecision`. The test exercises the stub, not the
wiring.

### Required behavior

- Wire `onDecision` through `deadlineHarness` so the facts path is exercised by
  the real code path rather than by a stub calling the callback directly.
- Add the counterfactual as a **regression test**: with the decision recording
  disabled, a test must fail. Assert against `facts.livenessChecks` being
  populated by a run that went through `createLivenessDeadline`, not by a stub.
- The test must fail if `decide(decision)` is removed. That is the acceptance
  criterion for this defect, and it is checkable by running the counterfactual.

## Also address — non-blocking notes from the seats

Both were raised as non-blocking and are cheap:

- **Req 2 coverage.** "Resets the gap" is currently asserted only through
  next-check timing. Assert `lastByteAt` is reset directly as well, so the reset
  is tested rather than inferred.
- **Report ordering.** `uro-report.md` prints the verifier's reasoning stream
  under `## Correctness verifier findings` and the actual verdict further down
  under `## Verifier plan artifact`. A reader meets the trace before the finding.
  **Print the plan artifact first** when one exists, so the verdict leads. Do not
  drop the findings text; reorder only.

## Invariants

- No seat judged **working** is ever killed for a defect in the judge's own
  answer.
- `unavailable` means no judge answered — nothing else.
- An interval is never silently shortened.
- Everything else in the liveness change is unchanged; this is a repair, not a
  redesign.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

1. **Defect 1:** a `working` verdict with an invalid `nextIntervalMs` keeps the
   seat alive and reuses the previous interval — assert the process was **not**
   killed.
2. A `working` verdict with a **valid** interval still honours it — the
   narrowness control.
3. `unavailable()` is still reached when **no judge answers**, and still kills.
4. The malformed interval is recorded in the facts without changing the outcome.
5. **Defect 2:** `facts.livenessChecks` is populated through the real
   `createLivenessDeadline` path, not by a stub invoking the callback.
6. **The counterfactual:** removing the decision recording makes a test fail.
   State in the test name that it is the mutation control.
7. Req 2: `lastByteAt` is asserted reset directly.
8. The report prints the verifier plan artifact **before** the findings stream,
   and still prints both.
9. **Positive control:** a normal run with no liveness check is unaffected — no
   `livenessChecks` entries, no behavioural change.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Mutation testing as a capability; that has its own plan.
- The arbiter, capability veto, Cursor's scoped write, STORM, or the FRESH pivot.
