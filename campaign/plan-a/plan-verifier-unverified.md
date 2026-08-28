# Distinguish "the review did not run" from "the review found issues"

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

Report an unparseable verifier verdict as `UNVERIFIED`, never as `ISSUES`

## Context — the defect

When the verifier process runs but emits nothing the verdict parser can read,
`src/verifier.js` falls back to `ISSUES`. That fail-safe is correct in spirit —
assume the worst — but it is **indistinguishable from a real finding**:

```
verdict      : ISSUES  (source: plan)
exit         : 0   launchFailed: false
findings     : (empty)
```

An operator, a report reader, or a caller reading only the verdict line
concludes *"the reviewer found problems"* when in truth **no review happened at
all**. A failure that disguises itself as a finding is the most misleading shape
a failure can take, and it silently undermines every verdict the loop produces.

This is a known class, not a one-off. `buildCursorArgs` in `src/verifier.js`
already carries a comment noting that without `--trust` the agent *"exits 1 with
no output and every review defaults to fail-safe ISSUES."* Same end state,
different cause.

The review seats are where this loop earns its cost. A seat that can silently
no-op while reporting a plausible verdict is the highest-severity defect in the
harness.

## Required behavior

### 1. A new verdict value: `UNVERIFIED`

Add `UNVERIFIED` as a distinct verdict, meaning **the review did not produce a
readable verdict**. It is not a finding and must never be presented as one.

A verdict is `UNVERIFIED` when **all** of the following hold:

- no verdict marker was parsed from the stream (the current fail-safe path), and
- the collected findings/evidence text is empty or whitespace-only.

If a verdict marker *was* parsed, behaviour is unchanged. If no marker was parsed
but substantive findings text exists, keep today's fail-safe `ISSUES` — the
reviewer said something, it just did not end with a marker. Only the
nothing-was-produced case becomes `UNVERIFIED`.

Preserve `verdictSource` exactly as it is recorded today. It is provenance, not a
health signal, and other code reads it.

### 2. `UNVERIFIED` must not read as success

- It is **not** a passing verdict. A run whose merged verdict is `UNVERIFIED`
  must not be reported as review-ready.
- Introduce or reuse an outcome that names it honestly, so `uro-runfacts.json`
  and `uro-report.md` say the review did not run rather than implying it did.
- `uro-report.md` must state plainly that the seat produced no readable verdict,
  and which seat it was.

### 3. Verifier liveness probe before the executor spends tokens

Add a cheap, token-free probe that the verifier binary can actually be launched,
and run it during preflight — **before** the executor is dispatched.

- Probe means "can this binary be executed and does it exit sanely", e.g. a
  version/status invocation. It must not call a model or spend agent tokens.
- On failure the run stops immediately with a clear message naming the binary and
  what was tried. Failing after the executor has spent hundreds of thousands of
  tokens is the waste this prevents.
- The probe must be skippable/injectable so tests never shell out to a real
  binary.

## Invariants

- **Never report `NO_BLOCKERS` when no verdict was parsed.** Fail-safe stays
  fail-safe; this task only stops it lying about *why*.
- Do not change the meaning of a genuinely parsed `ISSUES` or `NO_BLOCKERS`.
- Do not change `verdictSource` semantics or values.
- The verifier remains read-only. No new writes to the worktree.
- Zero external dependencies. ESM style matching the rest of the codebase.
- Do not weaken or delete existing verifier tests.

## Test requirements

Add to `test/verifier.test.js` (and `test/verifier-evidence.test.js` where
evidence handling is involved):

1. A stream with **no verdict marker and no findings text** yields `UNVERIFIED`,
   not `ISSUES`.
2. A stream with **no verdict marker but non-empty findings text** still yields
   `ISSUES` — the existing fail-safe. This is the control that proves the new
   branch is narrow and did not swallow the old behaviour.
3. A stream containing a real `NO_BLOCKERS` marker still yields `NO_BLOCKERS`,
   and one containing a real `ISSUES` marker still yields `ISSUES`.
4. `UNVERIFIED` never produces a review-ready outcome — assert at the level where
   the outcome is decided, not only where the verdict is parsed.
5. The liveness probe: a failing probe stops the run **before** the executor is
   invoked. Prove it with a spy executor that records whether it was called, and
   assert it was not. A passing probe leaves behaviour unchanged.
6. Whitespace-only findings text counts as empty for the `UNVERIFIED` decision.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Making the verifier runnable standalone over an arbitrary commit. Useful, but a
  separate task.
- Diagnosing *why* the Cursor agent emits nothing in some environments (TTY,
  auth context, PATH). This task makes the failure legible; it does not fix the
  cause.
- Any change to the executor, the gate, isolation, or the dashboard.
- Retry or restart logic for a failed verifier.
