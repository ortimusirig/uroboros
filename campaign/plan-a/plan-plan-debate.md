# Debate the plan, not just the code

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

`loop plan` — turn a goal into an agreed plan through the same debate the code
already gets, and let a queue unit carry a goal

## Context

Every plan this repository has run was written by hand. `loop run` consumes a
`plan.md` and a `gate.json`; nothing produces them. `campaign.js` has a
`plannerSynthesis` seam and **no production caller supplies it** — the same
shape `decisionResolver` had before it was wired.

That leaves the weakest link unadjudicated. A run's output is defended by an
exit-code gate and two independent verifier seats. Its *input* is defended by
nothing. Today's evidence: a plan whose gate covered six files passed, and the
change then broke ten tests on main. The plan was the defect, and no seat ever
looked at it.

The debate loop already built — `src/debate.js`, `src/review.js`,
`src/fix-plan.js` and the driver in `run.js` — is not specific to code. It
debates an artifact until findings stop recurring. A plan is an artifact.

## Required behavior

### 1. `loop plan`

```
loop plan --goal <prose-or-file> --target <directory> --out <directory>
          [--rounds <n>] [--planner-model <model>] [--dry-run]
```

Produces `<out>/plan.md` and `<out>/gate.json`, then exits. It writes nothing to
the target.

The loop, per round:

1. **Draft.** The executor seat drafts or revises the plan **in a read-only
   sandbox** so it can explore the target for real evidence but cannot modify it.
2. **Plan gate** — see §2. A plan that fails it is never shown to the reviewer;
   the failure becomes the next round's input.
3. **Review.** The verifier seat reviews the plan and emits findings in the
   existing `REVIEW.md` format, so `parseReview` handles them unchanged. A
   `blocking` finding must name a test, exactly as for code.
4. **Arbitrate.** Blocking findings become the next round's work through
   `buildFixPlan`. Suggestions never drive another round.
5. **Record and check.** The round's finding ids go into a `DebateLedger`;
   `detectCircling` and `shouldPivot` apply unchanged.

Convergence is no blocking findings **and** a passing plan gate. On
`--rounds` exhaustion, or `PIVOT_CONCLUDE`, it stops and reports honestly
without writing a plan it does not believe in.

**Reuse `debate.js`, `review.js` and `fix-plan.js` as they are.** Do not fork
them, do not copy their logic, do not modify them.

### 2. The plan gate — mechanical, not an opinion

The gate is what makes this more than two models agreeing. Every check is
objectively decidable:

| Check | Fails when |
|---|---|
| **The proposed `gate.json` runs** | spawning its commands in the target does not exit 0 |
| **Cited paths exist** | the plan cites `src/foo.js` and no such file exists in the target |
| **Cited line references exist** | it cites `run.js:428` and that file has fewer than 428 lines |
| **Named test files exist** | `gate.json` names `test/imaginary.test.js` |
| **Required sections present** | any of Title, Required behavior, Invariants, Test requirements, Out of scope is missing |
| **No unpaired absence assertion** | a test requirement asserts something is absent with no positive control alongside |

Report every failure with the specific offending citation or command, so the
next round can act on it rather than guess.

The `gate.json` execution check uses the existing gate machinery and the gate
timeout. It is run **against the target**, read-only in effect because a gate
command that mutates the target is the operator's own problem, not this
feature's.

Hallucinated evidence and unrunnable gates are exactly how a bad plan does
damage, and both are detectable. That is the whole justification for calling
this a gate.

### 3. A queue unit may carry a goal

`loop queue` gains support for a unit shaped:

```json
{ "name": "x", "goal": "prose or a path", "out": "campaign/generated/x" }
```

Such a unit runs `loop plan` first; on convergence it runs `loop run` with the
produced plan and gate, and lands it under the **unchanged** existing rule —
gate passed and both seats `NO_BLOCKERS`.

- A unit carries **either** `task`+`gate` **or** `goal`+`out`, never both.
  Reject a unit carrying both, or neither, before starting anything.
- If plan-debate fails to converge, the queue **stops** on that unit and
  implementation never starts. A plan nobody agreed on is not run.
- `--dry-run` validates goal units too: `out` must be writable and not already
  contain a `plan.md` that would be overwritten.
- The queue log line for a goal unit records plan rounds, whether the plan
  converged, and the implementation outcome separately.

### 4. Events

Emit `plan/start`, `plan/round`, `plan/gate`, `plan/converged`, `plan/finish`.

**Declare the `plan` stage and every new type in `EVENT_STAGES`, `EVENT_TYPES`
and `EVENT_PAIRS` in this same change.** An undeclared stage makes `createEvent`
throw and `reportEvent` swallow it — a defect already fixed three times in this
repository. Resolve the conformance ratchet honestly; do not weaken
`assertEventConformance`.

### 5. Documentation, in this same change

The repository's own tests require every command to be documented. Add
`commands/plan.md` in the shape of the existing command files, name `plan` as a
whole token in `skills/uroboros/SKILL.md`, and list it in `src/cli-help.js`.

## Invariants

- **`loop plan` never writes to the target.** The drafting seat runs read-only;
  output goes only to `--out`.
- **The plan gate is mechanical.** No check may be a model's judgement.
- A plan that does not converge is **not written**. Reporting honestly beats
  emitting something nobody agreed on.
- The existing landing rule is untouched: implementation still lands only when
  the code gate passed and both seats returned `NO_BLOCKERS`.
- `debate.js`, `review.js` and `fix-plan.js` are consumed, not modified.
- `loop run` is unchanged. This composes it.
- Zero external dependencies. ESM style matching the rest of the codebase.
- No push, ever.

## Test requirements

Use injected seams; no test may spawn a real agent or a real gate command.

1. A goal converging in one round writes `plan.md` and `gate.json` to `--out`
   and emits `plan/converged`.
2. A first draft failing the plan gate does **not** reach the reviewer, and the
   failure text appears in the next round's input.
3. Each mechanical check fails the gate independently: an unrunnable
   `gate.json`; a cited path that does not exist; a cited line beyond the file's
   length; a named test file that does not exist; a missing required section; an
   absence assertion with no positive control.
4. **Positive control for the gate:** a well-formed plan passes every check,
   proving the checks are not failing everything.
5. Blocking findings drive another round; suggestions alone do not.
6. `detectCircling` firing across plan rounds takes the pivot path.
7. `--rounds` exhaustion **writes no plan** and reports why.
8. A queue unit with `goal` runs plan then implementation; a unit whose plan
   fails to converge **never starts implementation** — assert the run launcher
   was not called.
9. A queue unit carrying both `task` and `goal`, or neither, is rejected before
   anything starts.
10. `--dry-run` on a goal unit validates `out` and starts nothing.
11. Every `plan/*` pair round-trips through `createEvent` without throwing.
12. `plan` appears in `commands/`, in `SKILL.md` as a whole token, and in the
    CLI usage text.
13. **Positive control:** `loop run` behaviour is unchanged — an existing
    task+gate unit still runs exactly as before.

Do not delete, skip, or weaken any existing test.

## Out of scope

- STORM multi-perspective plan generation. One drafting seat per round here;
  candidate generation stays a campaign concern.
- Changing how implementation, the code gate, or the verifier seats work.
- Writing the goal itself. A goal is the operator's input.
- Pushing or publishing.
