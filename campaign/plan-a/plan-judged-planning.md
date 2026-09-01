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

A plan is approved by judgement, not by a rule set being satisfied — see §6 for
exactly whose judgement and how many. The existing pivot judgement decides when
a planning approach is dead and a fresh one is needed.

The inspection's observations are evidence available to that judgement, never a
precondition for it.

### 5. The debate always happens

No path may end a round before the seats have talked. Two can today, and both
go:

- `src/plan.js` (~854): when no candidate passes the mechanical gate the run
  returns `candidates-exhausted` — **with no seat having read any plan.**
- `src/plan.js` (~921): a failed gate skips `reviewPlan` entirely.

With no pass/fail there is no surviving subset at ~599: **every candidate goes to
the selection seat**, which compares them and picks. `exhausted` then means only
that drafting produced nothing to discuss — not that a rule rejected everything.

Ending the debate becomes something the arbiter **decides**, never something a
rule causes.

### 6. A pass is three seats converging

Approval today is an absence: `gateResult.passed === true && surviving.length === 0`.
Nobody has to actually agree. It becomes a presence — **all three seats
affirmatively agree**:

- **The drafting seat** states that it understands the plan and can implement it.
  It says nothing at all today; producing an artifact is not agreement.
- **The reviewing seat** states the plan is ready.
- **The arbiter** agrees.

Silence is not consent. A seat that did not run, or returned nothing readable,
has not agreed and cannot be counted toward convergence — the same rule
`UNVERIFIED` already encodes for diffs.

**An overruled objection is not agreement.** The arbiter may overrule a finding,
and that finding stops blocking, but the reviewing seat must still come back and
say ready. Claude persuades by answering, not by outvoting. If a seat will not
agree, the escape is the **pivot** — replan or conclude, which the arbiter
already judges — never forcing the plan through.

A question is how a seat says *not yet*: it is neither agreement nor objection,
and it leaves the round unconverged by definition.

### 7. An answer carries its provenance

When the arbiter answers a question about a plan, the run records **whether the
answering seat also authored that plan**. In `loop plan` the draft comes from
the executor seat, so the arbiter is genuinely third-party; on the `loop run`
path the operator may have written the plan the arbiter is now interpreting.

This is recorded, not forbidden. A reader must be able to weigh an answer rather
than assume independence — the same defect as the executor answering its own
questions, one layer up.

### 8. An overlooked observation is overruled out loud

The inspection's observations are advisory, which creates a real risk: a
reviewer skims past *"cited path does not exist"* and approves a plan with
fabricated citations.

A seat may disregard any observation, but must **say so and say why**. The
outcome is not forced; the judgement is made visible. This mirrors the existing
rule that a blocking finding without a test is demoted — the seat still decides,
it simply has to state the decision.

### 9. A question may be judged unnecessary

The arbiter may answer a question with *"that is answerable from the plan"*,
naming where, and record that. Without this, questions become a free way to
stall — endless clarification instead of commitment. The arbiter pushes back
rather than only serving.

## Invariants

- **No mechanical rule decides whether a plan proceeds.** Not headings, not
  citation counts, not thresholds.
- **No code path returns from a round without the seats having spoken.**
- **A pass requires all three seats to agree.** An absence of objections is not
  agreement, and an overruled objection is not agreement.
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

13. A plan whose every candidate would have failed the old gate still reaches the
    seats — assert `candidates-exhausted` is not returned for that reason.
14. Convergence requires all three seats; assert a round where the reviewer is
    ready and the arbiter agrees but the drafting seat has not, does **not**
    converge.
15. An overruled finding stops blocking but does **not** by itself converge the
    round — the reviewing seat must still say ready.
16. A seat that did not run cannot be counted as agreeing.
17. An answer records whether the answering arbiter also authored the plan.
18. A disregarded observation is recorded with the seat's stated reason.
19. The arbiter may judge a question answerable from the plan, and that is
    recorded rather than treated as an answer to a new question.
20. **Mutation control:** removing the drafting seat's agreement from the
    convergence condition makes a test fail.

Do not delete, skip, or weaken any existing test. Where an existing test asserts
the removed required-section rule, replace it with one asserting the new
behaviour — that such a plan now reaches the reviewer — rather than deleting the
coverage.

## Out of scope

- The code gate in `loop run`. It is not touched.
- The verifier seats' review of a *diff*; this change is about plan review.
- STORM candidate generation and the FRESH pivot, which already work.
- Any new model, seat, or CLI.
