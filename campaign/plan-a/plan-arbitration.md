# Answer the executor's question instead of halting on it

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

Wire a `decisionResolver` so `--mode autonomous` resolves a challenge and
continues, with `authority` questions escalating only on evidence

## Context

`src/run.js` accepts a `decisionResolver` and refuses the answer-and-continue
path without one:

```js
if (mode !== 'autonomous'
    || typeof decisionResolver !== 'function'
    || challengeRound >= maxChallengeRounds) {
  decision = { questions: challenge.questions, mode, challengeRound };
  break;
}
```

Every production caller — `bin/loop.js`, `campaign.js`, `setup.js` — omits it.
The only supplier in the repository is `test/run.test.js`. So the
answer-and-continue path is **unreachable outside the test suite**, and every
challenge halts the run.

This is not hypothetical. A run in this repository halted with `needs-decision`
after the executor asked, correctly formatted, whether workspace permissions
could be repaired. The premise was false — the directory was writable — and the
retry succeeded unchanged. Nothing was available to answer it.

## Required behavior

### 1. A resolver, supplied by `bin/loop.js`

`bin/loop.js` supplies a `decisionResolver` when `--mode autonomous` is set. It
receives `{ questions, plan, task }` and returns `{ answers }`, where each answer
carries at least the question `id` and the resolved text. Returning no answers
means unresolved.

Resolution draws only on material already in the run: the operator's plan, the
task text, and the executor's own stated options and recommendation. **It must
not call a model or spend agent tokens** — this task wires the seam, it does not
introduce a new model seat. Where the executor supplied a `Recommendation:` and
the question is not `authority`, adopting that recommendation is a reasonable
resolution; where it did not, the question is unresolved.

The resolver is injectable so tests never depend on its internals.

### 2. `authority` questions escalate on evidence, not on a timer

An `authority` question is one the executor itself classified as needing the
operator's say-so. Halting is right when the operator is present and useless when
they are not: the run stops, nobody is watching, and the work sits.

**No hidden timeout, and no configurable wait.** Instead the harness gathers
evidence of presence and records a decision over it:

- whether a TTY is attached — `interaction-signals.js` already exports
  `WAIT_NOT_ACKNOWLEDGED` for exactly the no-TTY case, with one consumer today;
- how the run was invoked, interactively or not.

With evidence of an operator present, an `authority` question **halts**, as now.
With no TTY and therefore no operator to wait for, the resolver may answer it —
and must record that it did, with the evidence and its stated reasoning.

A configurable "authority wait" duration is an explicit **non-goal**: a number
invites tuning until it reaches zero, at which point authority questions are
silently autonomous.

### 3. Record who decided

- `decision/resolved` carries `answeredBy: 'user' | 'planner'`.
- A question answered in the operator's absence emits the new
  **`decision/assumed`**, carrying the questions, the answers, the presence
  evidence, and the reasoning. Run facts flag it with
  `escalation: 'operator-absent'`.
- `uro-report.md` **leads** with that fact when present. An operator returning to
  a finished run must read *"this was decided without you, and here is why we
  concluded you were away"* before they read the diff.

**Declare `decision/assumed` in `EVENT_STAGES`/`EVENT_TYPES`/`EVENT_PAIRS` in the
same change.** An undeclared pair makes `createEvent` throw and `reportEvent`
swallow it — the defect already fixed twice here, for `decision/*` and
`executor/extended`. Resolve the conformance ratchet honestly if it fires; do not
weaken `assertEventConformance`.

## Invariants

- **`--mode manual` is unchanged.** It halts with `needs-decision` and reports the
  questions. It is the default and stays the default.
- `challengeRounds` (default 2) still bounds the exchange. On exhaustion the run
  halts with `needs-decision` and reports the unresolved questions; it never
  silently proceeds.
- A resolver returning no answers is treated as no resolution: halt, do not
  re-run.
- `DECISION.md` is still removed before the executor re-runs.
- The resolver never writes to the worktree except through the existing
  `planWithDecision` rewrite of `TASK.md`.
- Nothing resolved in the operator's absence can escape the isolated worktree —
  the safety of this feature rests entirely on that, so no change may weaken it.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

Use injected seams as the existing `run.test.js` tests do; no test may spawn a
real agent.

1. `--mode manual` with a challenge halts with `needs-decision` and emits
   `decision/challenged`. **Regression control.**
2. `--mode autonomous` with a resolvable technical question answers it, rewrites
   `TASK.md`, re-runs the executor, and emits `decision/resolved` with
   `answeredBy: 'planner'`.
3. An `authority` question **with** evidence of a present operator halts.
4. An `authority` question with **no TTY** produces `decision/assumed` carrying
   evidence and reasoning, and sets `escalation: 'operator-absent'` in the facts.
5. A run resolved by `decision/assumed` leads its report with that fact, ahead of
   the diff.
6. `challengeRounds` exhaustion halts rather than looping.
7. A resolver returning no answers halts and does not re-run the executor.
8. `decision/assumed` round-trips through `createEvent` without throwing.
9. **Positive control:** a run with no challenge is unchanged in every mode.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Any model call inside the resolver.
- STORM regeneration after `needs-pivot`.
- The transcript UI's rendering of these events beyond what already exists.
- Durable run artifacts.
