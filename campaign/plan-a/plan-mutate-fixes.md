# Prove the deleter deletes, and stop an interrupt looking like a result

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

`loop mutate` is applied to the working tree and passes 714/714. Both verifier
seats returned `ISSUES`, each finding a different defect. Both were confirmed by
hand before this plan was written.

## Defect 1 — an interrupt is recorded as a result

Reported by the correctness seat:

> *"`spawnCapture` resolves on abort with `{ aborted: true, code: non-zero }` (it
> does not reject). `runSelectedTests` sets `passed: result.code === 0` and
> ignores `aborted`."*

Confirmed: `aborted` appears in `src/mutate.js` only as `signal?.aborted` guards
in the loop — never on the **spawn result**.

Two consequences, and the second is the dangerous one:

- Abort during the **baseline** → reported as `baseline-failed`, *"Baseline tests
  are red."* They are not red. The operator pressed Ctrl-C.
- Abort during a **trial** → the non-zero code reads as a **kill**, meaning
  *"this line is tested."* So **interrupting a mutation run silently converts
  untested lines into tested ones**, and the run can still finish with exit 0.

A tool whose purpose is to detect false confidence must not manufacture it when
interrupted.

### Required behavior

- `runSelectedTests` must distinguish **aborted** from **failed**. An aborted
  spawn is neither a pass nor a fail; it is *no result*.
- An abort during the baseline reports the run as **interrupted**, never as
  `baseline-failed`.
- An abort during a trial makes that unit **unexamined**, never a kill and never
  a survivor. Unexamined units are already reported as such by the budget path;
  reuse it.
- An interrupted run exits with the conventional interrupt status, not 0.
- The working tree is still restored exactly, as the existing invariant requires.

## Defect 2 — the deletion operator itself is unproven

Reported by the intent seat:

> *"Discrimination and facts-case tests stub `adapters.runTrial`. Nothing asserts
> `applyStatementDeletion` … A no-op deleter keeps the suite green while real
> `loop mutate` would mis-report survivors — the same 'correct and incorrect
> produce identical results' class TASK.md calls out."*

Confirmed: `applyStatementDeletion` appears **twice in `src/mutate.js` and zero
times in `test/mutate.test.js`.**

The consequence is that the tool's central claim is untested. **A deleter that
deletes nothing would report every unit as a survivor**, because every trial
would run against unmodified code and pass — turning the entire report into noise
while the suite stayed green.

This is precisely the defect class `loop mutate` exists to catch, present in
`loop mutate` itself.

### Required behavior

- Assert `applyStatementDeletion` **directly**: given a source and a target
  statement, the returned text no longer executes that statement and carries the
  documented marker.
- Assert it **discriminates**: a different statement in the same file is left
  intact.
- Assert the **round trip** — the deletion is applied, then restored, and the
  source is byte-identical to the original.
- **Acceptance criterion:** replacing `applyStatementDeletion` with a no-op must
  make a test fail. That is checkable by running the mutation, and it is the
  definition of done.

## Defect 3 — the restore test has no positive control

Also from the intent seat:

> *"Byte-identity of the source after a thrown trial also holds if nothing was
> ever deleted in the workspace copy."*

The test proves the file is unchanged at the end. It does not prove anything ever
changed in the middle, so a deleter that never fired would satisfy it.

### Required behavior

- Before asserting restoration, assert the file **was** modified during the trial
  — the marker present, the statement gone.
- Then assert it is byte-identical afterwards.
- **Positive control:** a test that would fail if the deletion never happened.

## Invariants

- No change to grouping, subdivision, the survivor/kill asymmetry, or the
  advisory nature of survivors.
- The working tree is restored exactly, including on interruption or error.
- A survivor still does not fail the gate.
- Unexamined units are still reported as unexamined, never as clean.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

1. An aborted baseline reports **interrupted**, not `baseline-failed`.
2. An aborted trial marks its unit **unexamined** — assert it is neither a kill
   nor a survivor.
3. An interrupted run does not exit 0.
4. `runSelectedTests` distinguishes aborted from failed — assert on a spawn
   result carrying `aborted: true` with a non-zero code.
5. `applyStatementDeletion` removes the target statement and adds the marker.
6. It leaves other statements in the same file intact.
7. **Mutation control:** replacing it with a no-op makes a test fail. Name it in
   the test so the intent is legible.
8. The restore test asserts the file **was** modified mid-trial before asserting
   byte-identity afterwards.
9. **Positive control:** a deleter that never fires fails the restore test.
10. The working tree is byte-identical after an aborted run.
11. Everything else in `loop mutate` is unchanged — grouping, subdivision,
    budget, dry-run, events, and the advisory arbiter judgement.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Mutation operators beyond statement deletion.
- Making a survivor fail the gate.
- Any change to the queue, the seats, or the debate loop.
