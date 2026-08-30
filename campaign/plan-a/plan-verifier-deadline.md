# Stop killing the reviewer on a clock, and stop calling a killed review a finding

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

Extends the evidence-based deadline already shipped for the executor to the
verifier seat, and closes a hole in the `UNVERIFIED` work shipped the same day.

**Explicitly NOT implemented here:** the arbiter, the capability veto, Cursor's
scoped write, STORM planning, or the FRESH pivot. Each has its own plan. This is
a prerequisite for all of them: every one produces a large diff that the reviewer
must be able to finish reading.

## Context — measured, not assumed

A real run in this repository, reviewing a change across ten source files, ended:

```
outcome: timed-out
timeoutEvents: [{"stage":"verifier","pass":"correctness","timeoutMs":600000}]
correctness: ISSUES (source: none)  findings: 0 chars
```

**The executor was fine.** It had a two-hour budget and used what it needed. The
*reviewer* was killed at ten minutes, mid-review, with a `SIGKILL` on a flat
clock.

Two defects, one seat apart.

### Defect 1 — the verifier still has the bug the executor no longer has

The executor gained two-tier liveness supervision, an evidence-based deadline
that extends while output is flowing, partial-work preservation, and a six-hour
ceiling. **The verifier gained none of it.** It still gets a flat
`URO_VERIFIER_TIMEOUT_MS`, defaulting to ten minutes, and an unconditional kill —
whether it is thinking hard about a large diff or genuinely wedged.

A reviewer reading a ten-file change is not stalled. It is reading.

### Defect 2 — a killed review is reported as a finding

`src/verifier.js`:

```js
const launchFailed = r.timedOut || (exitCode !== 0 && !hasVerdictEvidence(r.stdout));
```

A timeout sets `launchFailed`, which takes a branch that **never reaches
`deriveVerdictFromEvidence`** — so the empty-evidence rule that turns a
content-free result into `UNVERIFIED` is bypassed entirely.

The result above is exactly that: zero findings, no verdict source, reported as
`ISSUES`. Which is the very confusion `UNVERIFIED` was introduced to end —
*"the reviewer found problems"* versus *"the reviewer never finished"* — reappearing
through the timeout path.

**Being killed is not a finding.**

## Required behavior

### 1. The verifier gets the executor's supervision

Apply the same two-tier model already implemented for the executor:

- **Liveness** — any byte on the verifier's stdout resets it. Silence past
  `URO_STALL_THRESHOLD_MS` means genuinely wedged and may kill.
- **Progress** — informational only, never kills.
- At the deadline, **consult liveness**: still emitting means extend and emit
  `verify/extended`; silent past the threshold means kill, recording the gap and
  the last observed event.
- A hard ceiling `URO_VERIFIER_MAX_MS` still kills regardless. Default it
  generously — a large diff is a long read — and validate it with
  `parseTimeoutMs`.

Reuse the existing watchdog. Do not write a second implementation.

`verifier.js` already requests `--output-format stream-json`, so the stream
exists; today it is only parsed at the end. Observe it as it arrives, exactly as
`executor.js` does with `onStdout`.

### 2. A timed-out verifier is `UNVERIFIED`

A verifier that timed out **with no parseable verdict** yields `UNVERIFIED`,
never `ISSUES`.

- If it timed out but a verdict marker was already parsed from the stream before
  the kill, keep that verdict — it said something before it died.
- If it timed out with substantive findings text but no marker, keep today's
  `ISSUES` fail-safe. It spoke, it just did not conclude.
- Only the genuinely content-free case becomes `UNVERIFIED`.
- The facts record `timedOut: true` alongside the verdict either way, so the
  report can say *the reviewer was killed after N minutes* rather than implying
  it reached a conclusion.

The existing rule stands unchanged: **`UNVERIFIED` is never approval**, and never
lands a change.

### 3. Declare the events

`verify/extended` must be declared in `EVENT_STAGES`, `EVENT_TYPES` and
`EVENT_PAIRS` **in this same change**. Undeclared pairs have been silently
swallowed four times in this repository.

## Invariants

- **A verifier that is still producing output is never killed on elapsed time.**
- The hard ceiling still applies; a genuinely wedged reviewer must still die.
- `UNVERIFIED` remains not-approval and cannot land a change.
- A parsed verdict is never discarded because of a timeout that followed it.
- No change to the two prompts, to `--mode plan`, or to `assertNoForbiddenFlags`.
- Both verifier passes get the same treatment; neither is special-cased.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

Use the controlled-clock and injected-timer pattern from
`stall-watchdog.test.js`, including its positive control. No test may depend on
real elapsed time.

1. Bytes arriving past the verifier deadline **extend** rather than kill, and
   emit `verify/extended`.
2. Silence past the liveness threshold kills, recording the gap and last event.
3. The hard ceiling kills a continuously chatty verifier.
4. A timeout with **no** parseable verdict and **no** findings text yields
   `UNVERIFIED`, not `ISSUES` — **the reported defect**.
5. A timeout **after** a verdict marker was parsed keeps that verdict.
6. A timeout with substantive findings but no marker keeps `ISSUES` — the
   existing fail-safe, as a narrowness control.
7. `UNVERIFIED` from a timeout does not produce a review-ready outcome.
8. Facts record `timedOut: true` in every timeout case.
9. Both passes are supervised — assert on correctness **and** intent.
10. `verify/extended` round-trips through `createEvent` without throwing.
11. **Positive control:** a verifier that finishes normally is unaffected —
    no extension, no kill, verdict unchanged.

Do not delete, skip, or weaken any existing test.

## Out of scope

- The executor's supervision, which already exists.
- Changing the default verifier timeout for the flat path; the deadline becomes
  evidence-based rather than longer.
- The arbiter, capability veto, scoped write, STORM, or FRESH.
