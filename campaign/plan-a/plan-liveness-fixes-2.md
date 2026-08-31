# Test the shape production actually produces

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

The previous repair fixed both production defects correctly. The intent seat
accepted the production changes and rejected the **assertions**, finding three
defects — two of them the same failure the previous round was written to
eliminate, one level deeper.

All three were confirmed by hand before this plan was written.

**No production behaviour is wrong.** This round repairs tests that pass whether
or not the code works.

## Defect 1 — the recording branch is tested on a shape production never emits

> *"Production flow: `createLivenessJudge` → `parseLivenessJudgement` →
> `{ invalidNextIntervalMs, … }` **without** `nextIntervalMs` → spawn's
> `else if (Object.hasOwn(judgement, 'invalidNextIntervalMs'))`. All
> recording/facts asserts inject `{ nextIntervalMs: 0 }`, which hits only the
> **first** spawn branch."*

**Counterfactual, run and confirmed:** disabling the `else if` branch in
`createLivenessDeadline` leaves **689 tests, 689 passing**, while production stops
recording the malformed interval into the facts.

`parseLivenessJudgement` strips the unusable value and stashes it under a
different key. The tests construct the pre-parse shape; production only ever
reaches the branch with the post-parse shape. **The branch production actually
takes has nothing depending on it.**

### Required behavior

- Assertions must exercise the **post-parse shape**: `invalidNextIntervalMs`
  present, `nextIntervalMs` absent — the object `parseLivenessJudgement`
  genuinely produces.
- Prefer driving through `createLivenessJudge` → `parseLivenessJudgement` so the
  shape is produced rather than hand-written, and cannot drift from production.
- **Acceptance criterion:** disabling the `else if` branch must make a test fail.
  That is checkable by running the counterfactual, and it is the definition of
  done for this defect.
- Keep the existing first-branch coverage; both branches must be exercised.

## Defect 2 — the `lastByteAt` assertion tests the harness against itself

> *"`deadlineHarness.byte()` does `lastByteAt = clock.now()`, then the test
> asserts `harness.lastByteAt === harness.clock.now()`. That would still pass if
> production stopped resetting `lastByteAt` on stdout."*

The test sets a value and then asserts the value it set. Production's reset — in
`src/executor.js` and `src/verifier.js`, on stdout arriving — is never involved.

### Required behavior

- Assert the reset **through the production path**: stdout arriving at the real
  observer must be what moves `lastByteAt`.
- **Acceptance criterion:** removing the reset from production must make a test
  fail.
- A harness that assigns the value it is about to assert is not coverage. If the
  production path cannot be driven directly, assert an observable consequence of
  it instead — never the harness's own assignment.

## Defect 3 — the packaging filter can mask a real omission

> *"`test/packaging.test.js` excludes any root **directory** matching
> `/-[A-Za-z0-9]{6}$/`. That fixes the flake but also drops legitimate shippable
> dirs with that suffix from `shippable`."*

The filter was added to stop concurrent `mkdtemp` fixtures failing the assertion.
It works, and it is broader than the problem: a genuine shippable directory whose
name happens to end that way would be silently exempt.

### Required behavior

- Narrow it so it cannot exempt a real entry. Match the **known fixture
  prefixes** the suite actually creates rather than any six-character suffix, or
  restrict the exemption to untracked directories, or both.
- **Positive control:** a directory with a six-character suffix that is *not* a
  test fixture must still fail the assertion when absent from `PAYLOAD`.
- The flake must stay fixed — concurrent `mkdtemp` fixtures still must not fail
  the test.

## Invariants

- **No production behaviour changes.** Every production defect from the previous
  round is already fixed correctly and must stay fixed.
- Existing passing assertions are strengthened, not deleted.
- The packaging guard still catches genuinely omitted shippable entries.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

1. The recording branch is exercised with the **post-parse** shape —
   `invalidNextIntervalMs` present, `nextIntervalMs` absent.
2. **Mutation control:** disabling the `else if` branch makes a test fail. Name it
   in the test so the intent is legible.
3. The first branch remains covered — both paths, not one swapped for the other.
4. `lastByteAt` is asserted through production's reset, not the harness's
   assignment.
5. **Mutation control:** removing production's `lastByteAt` reset makes a test
   fail.
6. A non-fixture directory ending in six alphanumerics still fails the packaging
   assertion when missing from `PAYLOAD`.
7. Concurrent `mkdtemp` fixtures still do not fail it — the flake stays fixed.
8. **Positive control:** the liveness behaviour itself is unchanged — working
   judgements are honoured, invalid intervals reuse the prior value, no-judge
   still kills.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Any production change to liveness judgement, spawn, or the report.
- Mutation testing as a capability; it has its own plan and would have caught all
  three of these mechanically.
