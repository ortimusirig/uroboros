# Stop killing a healthy executor on a clock

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

Two-tier liveness supervision, an evidence-based deadline, and partial-work
preservation before any kill

## Context — the defect

Two independent systems that never speak to each other:

| | Measures | On breach |
|---|---|---|
| `src/stall-watchdog.js` | silence since the last event — *is it stuck?* | emits `stalled`, optionally restarts |
| `src/spawn.js` timeout | elapsed wall-clock | **`SIGKILL`s the whole process tree** |

At the deadline `spawn.js` calls `killProcessTree` — `taskkill /t /f` on Windows,
`process.kill(-pid, 'SIGKILL')` on POSIX. `SIGKILL` cannot be caught, so nothing
is flushed and everything written mid-pass is discarded. The timeout asks the
watchdog nothing.

**A Codex streaming healthy output every four seconds dies identically to one
wedged for twenty-five minutes**, and the evidence of which it was dies with it.

Elapsed time is the wrong signal. Silence is the right one, and it is already
measured.

There is a second, sharper reason this matters. `createIncrementalReporter` in
`src/executor.js` only reports on `item.completed`, and `src/executor.js` itself
notes that *"healthy Codex turns often outlive the watchdog gap"* — which is why
the stall threshold is padded to ten minutes. A finer signal already arrives and
is discarded: `spawnCapture`'s `onStdout` receives **every chunk**, including
output that never becomes a completed item.

## Required behavior

### 1. Two-tier supervision

Split the single silence signal into two, both observed locally at zero token
cost:

| Tier | Trigger | Meaning | May kill? |
|---|---|---|---|
| **Liveness** | any byte on the child's stdout | the process is alive | **yes** |
| **Progress** | an `item.completed` event | it finished real work | **never** |

- **Liveness** governs `URO_STALL_THRESHOLD_MS`, whose shipped default changes
  from **10 minutes to 5 minutes**. Five minutes of total dead air is
  unambiguous.
- **Progress** gets a new `URO_PROGRESS_THRESHOLD_MS`, default **5 minutes**,
  and is **informational forever**. It must render what it knows — how long
  since progress, and the last observed action — and must never kill or restart.

This inversion is what makes five minutes safe: a thinking executor now proves it
is alive through raw bytes, so the completed-item threshold no longer has to be
padded to avoid false positives.

Both new thresholds validate exactly like the existing ones and reuse
`parseTimeoutMs`.

### 2. An evidence-based deadline

At the executor deadline, consult liveness instead of killing unconditionally:

- **Still emitting bytes** → emit an `executor/extended` event carrying the
  observed gap, extend the deadline by one further interval, and continue.
- **Silent past the liveness threshold** → kill, and record *why*: the gap
  length, the last observed event, and the name of the setting that controls it.

A hard ceiling `URO_EXECUTOR_MAX_MS`, default **6 hours**, still kills
regardless. A timeout that can never fire is not a timeout.

`executor/extended` **must be declared** in `EVENT_STAGES`/`EVENT_TYPES`/
`EVENT_PAIRS` in `src/events.js`, or `createEvent` will throw and `reportEvent`
will silently swallow it — the exact defect already fixed once for the
`decision` stage. If the conformance ratchet in `test/events.test.js` then
requires it, resolve that honestly with a substantive reason and an updated
count; do not weaken `assertEventConformance`.

### 3. Preserve partial work before any kill

Before **any** kill path — deadline, liveness breach, or hard ceiling — commit
whatever the executor has written to the isolated branch, so a timed-out run
reports how far it got instead of nothing.

- Best-effort and non-fatal: a failed commit must not change the outcome or mask
  the timeout.
- The resulting diff must still exclude harness artifacts, exactly as a normal
  pass does. Reuse the existing staging path; do not introduce a second one.
- Applies to the executor stage. The gate and verifier keep today's behaviour.

## Invariants

- **Do not weaken the ability to kill.** A genuinely wedged process must still
  die, at the liveness threshold and unconditionally at the hard ceiling.
- Progress silence must never kill or restart, in any configuration.
- `URO_STALL_POLICY` and `URO_STALL_RESTARTS` keep their current meanings and
  continue to apply to the liveness tier only.
- Do not change `DEFAULT_EXECUTOR_TIMEOUT_MS`, `DEFAULT_VERIFIER_TIMEOUT_MS`, or
  `DEFAULT_GATE_TIMEOUT_MS`.
- `spawnCapture` must still return every original byte it captured.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

Use the controlled-clock and injected-timer pattern already established in
`test/stall-watchdog.test.js`, including its positive control. No test may
depend on real elapsed time.

1. Bytes arriving past the deadline **extend** rather than kill, and emit
   `executor/extended`.
2. Silence past the liveness threshold **kills**, and the recorded reason carries
   the gap and the last observed event.
3. Progress silence with bytes still flowing **never kills** — assert the child
   was not killed — and does emit its informational event.
4. The hard ceiling kills even a continuously chatty process.
5. Partial work is committed and appears in the diff of a timed-out run.
6. A failed partial-work commit does not change the outcome or suppress the
   timeout.
7. `executor/extended` round-trips through `createEvent` without throwing.
8. **Positive control:** with supervision disabled or thresholds unreached,
   today's timeout behaviour is unchanged — a deadline with no liveness evidence
   still kills.
9. Harness artifacts are still excluded from a timed-out run's diff.

Do not delete, skip, or weaken any existing test.

## Out of scope

- The verifier and gate stages keep their current timeout behaviour.
- `detectCircling`, `shouldPivot`, or anything in the debate loop.
- Reporting or dashboard rendering of the new events beyond emitting them.
- Retry or restart policy changes beyond keeping today's semantics.
