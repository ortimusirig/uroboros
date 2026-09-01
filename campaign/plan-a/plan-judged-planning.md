# Planning is judged, and a seat that does not understand may ask

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

## Context — measured, not asserted

`loop plan` decides whether a plan may proceed with `runPlanGate`, a set of
mechanical rules in `src/plan-gate.js`. It checks five things: `gate.json` is
well formed, cited paths exist, cited line numbers exist, test files named in
`gate.json` exist, and the plan carries five headings spelled exactly

```js
export const REQUIRED_PLAN_SECTIONS = Object.freeze([
  'Title', 'Required behavior', 'Invariants', 'Test requirements', 'Out of scope',
]);
```

The last rule rejects a plan for how it spells a heading. A plan can state its
behaviour, its invariants and its tests perfectly clearly and fail because it
wrote "Scope" instead of "Out of scope".

**The deeper defect is that the gate does not supplement the review — it
replaces it.** In `src/plan.js` (~918):

```js
let reviewed = false;
if (gateResult.passed === true) {
  reviewed = true;
  review = normalizeReview(await reviewPlan({ ... }));
  findings = reviewFindings(review);
} else {
  findings = gateFindings(gateResult.failures ?? []);
}
```

When the mechanical gate fails, **no seat ever reads the plan**. The reviewer is
not consulted, the arbiter judges only the mechanical failures, and the run
reports on a plan nobody read. A rule about heading spelling can therefore
terminate a planning round on its own.

## Required behavior

### 1. The mechanical gate stops deciding

`runPlanGate` is replaced by an advisory inspection. It gathers the same facts
and returns them as **observations**; it does not return `passed`, and nothing
branches on it.

Keep gathering, because these are facts and cheap to establish:

- `gate.json` parses and has the expected shape.
- A cited path exists, and lies inside the target.
- A cited line number exists in the file it names.
- A test file named in `gate.json` exists.

**Drop the required-section rule entirely.** Whether a plan is clear enough to
implement is a judgement, and it now belongs to the seats. Do not replace it
with a softer rule, a score, a threshold, or a required-section warning; the
absence of a rule is the point.

Each observation names what was checked and what was found, in a form a reader
can act on. An observation is never a verdict.

### 2. The reviewer always runs

`reviewPlan` is invoked on every round, regardless of what the inspection found.
The observations are supplied to it as advisory context, clearly marked as
mechanical findings that carry no authority.

A plan with a broken citation is a plan the reviewer should see and judge —
perhaps the citation is a typo in an otherwise sound plan, perhaps it reveals
the author never opened the file. A rule cannot tell those apart; a reader can.

### 3. Either planning seat may ask instead of verdicting

Both seats in the planning loop — the drafting seat and the reviewing seat —
may respond with a **question** rather than a verdict when they do not
understand the plan well enough to proceed.

- A question is a first-class outcome, distinct from approval and from a
  blocking finding. A seat that does not understand something must not have to
  disguise that as an objection.
- **Claude answers**, through the existing arbiter seam. Technical and product
  questions are answered by the arbiter; an `authority` question is the
  operator's and stops the run as `needs-decision`, exactly as today.
- The answer is appended to the planning context for the next round, so the
  next draft is written with the answer in hand.
- Questions and their answers are recorded in the plan facts and the report. A
  reader must be able to see what a seat did not understand and what it was
  told.
- **No cap on questions.** A round that produces only questions is progress, not
  a stall. If a seat keeps asking without converging, that is a judgement for
  the arbiter's pivot decision, which already exists — not a counter.

### 4. Convergence is judged

A plan is approved when the reviewing seat says it is ready and the arbiter
agrees, not when a rule set is satisfied. The existing pivot judgement decides
when a planning approach is dead and a fresh one is needed.

The inspection's observations are evidence available to that judgement, never a
precondition for it.

## Invariants

- **No mechanical rule decides whether a plan proceeds.** Not headings, not
  citation counts, not thresholds.
- Factual observations are still gathered, and are always advisory.
- The reviewer runs on every round.
- An `authority` question still stops the run for the operator.
- The code gate — the operator's commands and their exit codes, in `loop run` —
  is untouched. That gate is structural and stays exactly as it is. This change
  is only about the *plan* gate.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

Use injected seams; no test may spawn a real agent.

1. A plan missing every required heading still reaches the reviewer, and is
   approved when the reviewer and arbiter approve it.
2. A plan with a broken citation reaches the reviewer, with the observation
   supplied as advisory context — assert the reviewer received it.
3. The inspection returns no `passed` field, and nothing in `plan.js` branches
   on one. **Mutation control:** making the inspection report every plan as
   defective changes no outcome.
4. The reviewer is invoked on every round, including rounds where the inspection
   found problems — assert the call count, not just the outcome.
5. A drafting seat may ask a question; it is routed to the arbiter and the
   answer reaches the next round's draft input.
6. A reviewing seat may ask a question; same routing, same reuse.
7. A question is not recorded as a blocking finding, and does not by itself fail
   a round.
8. An `authority` question stops the run as `needs-decision` and names the
   question.
9. Questions and answers appear in the plan facts and in the report.
10. **Positive control:** a genuinely unclear plan can still be rejected — a
    reviewer blocking finding still blocks, and the arbiter can still overrule
    it, exactly as today.
11. **Positive control:** `loop run`'s code gate is unchanged — a red gate still
    fails a run.
12. Any new `plan/*` or `arbiter/*` event pair is declared in `EVENT_STAGES`,
    `EVENT_TYPES` and `EVENT_PAIRS` in this same change, and round-trips through
    `createEvent`. Undeclared pairs have been silently swallowed four times in
    this repository.

Do not delete, skip, or weaken any existing test. Where an existing test asserts
the removed required-section rule, replace it with one asserting the new
behaviour — that such a plan now reaches the reviewer — rather than deleting the
coverage.

## Out of scope

- The code gate in `loop run`. It is not touched.
- The verifier seats' review of a *diff*; this change is about plan review.
- STORM candidate generation and the FRESH pivot, which already work.
- Any new model, seat, or CLI.
