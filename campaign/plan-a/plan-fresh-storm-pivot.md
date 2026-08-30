# FRESH must re-plan, and re-plan by STORM

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

## Source design

Implements the **Fresh approach** rung of §Circling Detection and Pivot in
`docs/superpowers/specs/2026-08-25-three-way-debate-loop-design.md`, using the
multi-perspective candidate generation of **§Mode A — divergent (STORM with
execution)** from `2026-08-15-v3-orchestrated-campaigns-design.md`.

**Depends on:** `plan-claude-seat.md`, which removes the round cap and makes the
pivot ladder the primary stop condition. Land that first.

**Explicitly NOT implemented here:** the arbiter itself, the capability veto, and
Cursor's scoped write — each has its own plan.

## Context — the defect

`detectCircling` works. `shouldPivot` works. The ladder is `AMEND → FRESH →
CONCLUDE`, and two of the three rungs do what they say.

**FRESH does not.** The spec:

> *"**Fresh approach** — New branch from the pre-debate snapshot. Cursor's
> accumulated test files carry over (they define the problem, not the solution).
> Claude writes a new plan with a different implementation strategy. Codex starts
> fresh."*

Today it sets `outcome = 'needs-pivot'` and stops. No new branch, no new plan, no
carry-over. The loop detects that its approach has failed and then simply ends —
the operator is handed a ledger and left to start again by hand.

That is the one rung where the loop is supposed to *learn* rather than stop, and
it is the rung that does the least.

The missing half now exists: `loop plan` turns a goal into an agreed plan, and
`loop queue` already chains `goal → plan → run`. What is absent is the hand-off.

## Required behavior

### 0. The arbiter decides when to pivot — not a counter

`detectCircling` and `shouldPivot` are deterministic rules with numbers in them:
a finding surviving *three* rounds, a count not falling over *three* rounds, and
a ladder keyed to a pivot counter. Those are the same species of arbitrary bound
as the round cap being removed in the dependent plan.

They become **evidence**, not the decision.

- `detectCircling` keeps its signature and its tests. Its output is reported to
  the arbiter as an observation: which finding ids recurred, over how many
  rounds, and whether the total is falling.
- **The arbiter decides** what that means: keep debating, `AMEND`, `FRESH`, or
  `CONCLUDE`. It is given the ledger, the round history, the current findings,
  and the circling signal, and answers with a decision and its reasoning.
- The arbiter may pivot **before** the deterministic rule fires, when the
  evidence plainly warrants it, and may decline to pivot when it does not. A
  finding recurring three times because the executor is genuinely converging on
  it is not the same as a loop going in circles, and only judgement can tell
  those apart.
- `shouldPivot` remains as the **fallback when the arbiter is unavailable**, so
  behaviour degrades to today's deterministic ladder rather than to no pivot at
  all. `debate.js` is not modified.
- The decision and its reasoning are recorded in the facts and emitted as an
  event, so a pivot is never unexplained.

The only remaining bound is the operator's **token budget**, which is theirs to
set rather than a number the tool invented.

### 1. FRESH re-plans instead of stopping

On `PIVOT_FRESH`, the run does not end. It:

1. **Snapshots the pre-debate state.** The branch point is the commit as it stood
   before the first debate round — not the accumulated fix attempts. The failed
   approach is abandoned, not amended.
2. **Carries the reviewer's tests forward.** Files under `__uro_review/` move to
   the new branch unchanged. Per the spec, *"they define the problem, not the
   solution"* — the tests survive precisely because they are the part that was
   right.
3. **Re-plans** by invoking the planning path with the debate ledger as input.
4. **Starts a new implementation** from that plan, on the new branch.

The debate ledger continues across the pivot. A FRESH that produces the same
failing findings must still be able to reach `CONCLUDE`; re-planning may not
reset the escalation.

### 2. Re-planning uses STORM, not a single draft

Ordinary planning drafts once and iterates. **FRESH does not**, because FRESH
means the approach itself failed — iterating on it is the very thing that
produced the circling.

So re-planning generates **N candidates from genuinely distinct perspectives**,
per Mode A:

- The perspectives must be **materially different framings**, not rewordings —
  the campaigns spec is explicit that *"N candidates that are secretly one
  approach is N times the cost for nothing."*
- **The ledger is the input that makes them informed.** Each candidate is told
  which findings recurred, which resolved, and which framing already failed, and
  is required to differ from it.
- `N` defaults to **3** and is settable by `--pivot-candidates`, bounded to a
  small maximum.
- Candidates are generated through the existing planning path so they inherit
  the plan gate and its checks. **A candidate that fails the plan gate is
  discarded, not selected.**
- Selection follows Mode A: judgement over the surviving candidates, with the
  ledger as context. **Nothing is scored** — the campaigns spec forbids a metric
  an actor could optimise toward.
- If **every** candidate fails the plan gate, escalate to `CONCLUDE` and report
  honestly. A pivot that cannot produce a viable plan is not a pivot.

### 3. Events and facts

Emit `pivot/replan_start`, `pivot/candidate`, `pivot/selected`, and
`pivot/exhausted`.

**Declare every new stage and type in `EVENT_STAGES`, `EVENT_TYPES` and
`EVENT_PAIRS` in this same change.** Undeclared pairs have been silently
swallowed four times in this repository.

Run facts record, for each pivot: the ledger at the point of pivot, each
candidate's declared perspective, which candidates failed the plan gate and why,
which was selected, and the branch created.

## Invariants

- **The gate remains the only thing that can pass a change.** A pivot changes the
  plan, never the standard.
- The pre-debate snapshot is the branch point. FRESH must not build on the
  discarded attempts.
- Reviewer tests carry over unmodified; the executor is still forbidden to touch
  `__uro_review/`.
- The ledger persists across pivots so escalation terminates.
- `AMEND` and `CONCLUDE` are unchanged.
- A run that never circles behaves exactly as it does today.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

Use injected seams; no test may spawn a real agent.

1. `PIVOT_FRESH` creates a new branch from the **pre-debate** commit, not from
   the last fix attempt — assert the branch point.
2. Files under `__uro_review/` are present on the new branch, byte-identical.
3. Re-planning generates the configured number of candidates, each with a
   **declared, distinct perspective**.
4. Each candidate receives the ledger — assert the recurring finding ids reach
   the candidate's input.
5. A candidate failing the plan gate is discarded and not selected.
6. **All** candidates failing the plan gate escalates to `CONCLUDE` and reports
   honestly; it does not silently proceed.
7. The selected candidate's plan drives a new implementation on the new branch.
8. The ledger persists across the pivot: a FRESH followed by continued circling
   still reaches `CONCLUDE` — **the non-reset regression control**.
9. `AMEND` and `CONCLUDE` behave exactly as before.
9a. The arbiter may pivot **before** `detectCircling` fires, and may decline to
    pivot when it does — assert both directions, so the decision is genuinely the
    arbiter's and not the rule's.
9b. With the arbiter unavailable, `shouldPivot`'s deterministic ladder still
    applies — degradation, not absence.
9c. Every pivot decision records the arbiter's stated reasoning.
10. **Positive control:** a run that never circles creates no branch, generates
    no candidates, and emits no `pivot/*` events.
11. Every new `pivot/*` pair round-trips through `createEvent` without throwing.
12. Facts record each candidate's perspective, its plan-gate result, and the
    selection.

Do not delete, skip, or weaken any existing test.

## Out of scope

- The arbiter, the capability veto, Cursor's scoped write.
- Using STORM for ordinary planning. Initial plans and fix-plan replans keep the
  single-draft iteration; STORM is reserved for FRESH, where the approach itself
  has failed and distinct framings are the point.
- Running candidates concurrently to completion, as campaign Mode A does. Here
  candidates are *planned* in parallel and one is selected; only the selected
  plan is implemented.
