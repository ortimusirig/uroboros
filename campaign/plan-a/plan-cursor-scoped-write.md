# Let the reviewer write the tests it demands

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

Implements **§Cursor's scoped write**, **§Codex protection of review files**, and
the `cursor-plugin/skills/uro-review/SKILL.md` row of the New Source Files table
in `docs/superpowers/specs/2026-08-25-three-way-debate-loop-design.md`.

**Explicitly NOT implemented here:** a Claude seat, finding validation with real
judgement, the "no round cap" property, and the FRESH pivot re-branching from a
pre-debate snapshot.

## Context — the defect

The spec requires the reviewer to write executable proof:

> *"Cursor also writes the referenced test files — real tests that the gate will
> execute."*

The reading half exists: `review.js` parses `REVIEW.md` and collects test files,
`fix-plan.js` renders them and tells the executor not to touch them, and the
demotion rule already downgrades a blocking finding that names no test.

**The writing half does not exist, and cannot.** `verifier.js` passes
`--mode plan`, which the Cursor CLI documents as *"read-only/planning (analyze,
propose plans, no edits)"*. The reviewer is asked for a test file it is
physically unable to create.

So today a blocking finding names an assertion, and **the executor whose work is
being challenged writes that assertion itself.**

There is also a shipped bug. `review.js` collects only `.py` files:

```js
else if (entry.isFile() && entry.name.endsWith('.py')) files.push(path);
```

In this repository every test is `.js`, so `testFiles` is permanently empty. The
collection half does not work even where it exists.

## Constraint discovered

The Cursor CLI offers no scoped-write mode. `--mode` accepts only `plan` and
`ask`, both read-only; `--sandbox` accepts only `enabled` and `disabled`, with no
path scoping. Write capability therefore requires **omitting `--mode`**, and the
scoping must be a skill instruction plus post-hoc enforcement by the harness —
exactly as the spec describes.

## Required behavior

### 1. A separate, write-capable review pass

Add a review invocation distinct from the two verdict passes.

- **The correctness and intent passes are unchanged.** They keep `--mode plan`,
  stay read-only, and remain the only source of `NO_BLOCKERS` / `ISSUES`.
  **The seat that issues a verdict never has write access.**
- The new review pass omits `--mode`, runs with `--sandbox enabled`, and is
  prompted by the `uro-review` skill to produce `__uro_review/REVIEW.md` and its
  referenced test files.
- `--force`, `--yolo`, `-f` and `--approve-mcps` stay forbidden;
  `assertNoForbiddenFlags` still runs over the final argument list.
- The pass is bounded by the existing verifier timeout.

### 2. Post-hoc scoping — the enforcement, not the prompt

Before the review pass, capture the worktree state. Afterwards:

- **Every path outside `__uro_review/` is restored to its captured state.** Use
  git, so the restoration is exact for tracked files and removes untracked ones.
- Files under `__uro_review/` are kept.
- If anything outside was modified, emit an event naming the paths and record it
  in the run facts. A reviewer editing the implementation is itself a finding the
  operator must see — silently reverting it would hide a seat exceeding its role.
- Restoration runs even when the review pass fails or times out.

### 3. Protect the review files from the executor

The executor is already told not to modify `__uro_review/`. Enforce it:

- Snapshot `__uro_review/` before each executor invocation.
- Afterwards, restore any file the executor deleted or modified there, and record
  that it happened.

### 4. The gate runs the accumulated tests

Once review test files exist, the gate runs **the operator's original commands
plus the reviewer's accumulated tests**.

- The operator's commands run first and their failure is reported as today.
- Reviewer tests accumulate across rounds; they are not reset between rounds.
- A reviewer test that fails is a gate failure like any other, feeding back to
  the executor.

**Stated risk:** this gives the reviewer a veto. A wrong or unsatisfiable test
blocks the change. The existing mitigations are the demotion rule, circling
detection, and the executor's ability to resist through `DECISION.md`. This is a
deliberate transfer of power to the reviewer, recorded here so it is not
discovered later.

### 5. `uro-review` skill

Create `cursor-plugin/skills/uro-review/SKILL.md` instructing the reviewer to:

- write findings to `__uro_review/REVIEW.md` in the documented block format
  (`## F1`, `Severity`, `Category`, `Description`, `Test`);
- write each referenced test under `__uro_review/tests/`, in the **target
  repository's own test language and framework**, runnable by its gate;
- **write nothing outside `__uro_review/`**, stating plainly that anything else
  is reverted and reported;
- name the superpowers skills it uses at its decision points, exactly:
  `superpowers:brainstorming`, `superpowers:test-driven-development`,
  `superpowers:systematic-debugging`,
  `superpowers:verification-before-completion`,
  `superpowers:requesting-code-review`, `superpowers:using-superpowers`.

### 6. Fix the language bug

`review.js` must collect the target's real test files, not only `.py`. Accept the
common test extensions rather than one hardcoded language, and cover a `.js` case
in the tests so this cannot regress.

### 7. `__uro_review/` is a harness artifact

Add `__uro_review/` to `src/artifacts.js` so reviewer files are excluded from
`CHANGES.diff` exactly as `TASK.md` and `events.jsonl` are. Reviewer tests must
never appear as executor output.

## Invariants

- **The verdict passes stay read-only.** No change to `--mode plan` on
  correctness or intent.
- Write capability exists only during the review pass, and only its
  `__uro_review/` output survives.
- A reviewer that writes outside its directory is **reverted and reported**,
  never silently corrected.
- The gate remains the only thing that can pass a change.
- `assertNoForbiddenFlags` still guards every verifier argument list.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

Use injected seams; no test may spawn a real agent.

1. The review pass omits `--mode plan`; the correctness and intent passes still
   include it. **Positive control:** assert both, so a change to either is caught.
2. A review pass that writes outside `__uro_review/` has those paths restored,
   and the event and facts name them.
3. A review pass that writes only under `__uro_review/` keeps every file.
4. Restoration happens even when the review pass throws or times out.
5. An executor run that deletes a reviewer test file has it restored, and the
   restoration is recorded.
6. The gate runs the operator's commands **and** the accumulated reviewer tests.
7. A failing reviewer test fails the gate and feeds back to the executor.
8. Reviewer tests accumulate across rounds rather than resetting.
9. `review.js` collects `.js` test files — the bug case — and still collects
   `.py`.
10. `__uro_review/` is excluded from `CHANGES.diff`.
11. `uro-review/SKILL.md` names its six superpowers skills exactly, as whole
    tokens, and states the write restriction.
12. `assertNoForbiddenFlags` still rejects `--force` in the review pass's
    arguments.

Do not delete, skip, or weaken any existing test.

## Out of scope

- A Claude seat, or validating findings with judgement.
- The no-round-cap property and the FRESH pivot.
- Any change to how verdicts are parsed or reported.
