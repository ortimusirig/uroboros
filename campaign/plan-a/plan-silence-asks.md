# Silence starts a conversation, it does not end a process

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

A silent seat is asked about, not killed: liveness becomes a judged conversation

## Context — measured, an hour ago

The no-caps change landed and worked: elapsed time no longer kills anything, and
silence does. The very next run was killed by it:

```
reason  : "liveness"
gapMs   : 300004                      exactly five minutes
setting : URO_STALL_THRESHOLD_MS
lastEvent: agent_message —
  "The implementer is still in its RED→GREEN cycle. I've finished the
   controller-side preparation, so I'm waiting for its committed report
   before packaging the diff for review."
```

**The executor was not wedged. It had delegated to a subagent and was waiting.**
It said so, in plain words, immediately before going quiet — and was killed
anyway, losing twenty minutes of work.

Silence does not distinguish *waiting* from *dead*, any more than elapsed time
distinguished *slow* from *stuck*. Replacing one deterministic rule with another
moved the failure; it did not remove it.

And this will now happen constantly. Superpowers, wired in the same day, contains
`subagent-driven-development` and `dispatching-parallel-agents` — skills that
actively encourage the executor to delegate. The system was made more likely to
delegate and more likely to punish delegation, in one afternoon.

**A human read that last message and knew within seconds that the run was fine.**
That judgement is what must be automated — not a larger number.

## Required behavior

### 1. Silence triggers a question, not a kill

When a seat goes silent past `URO_STALL_THRESHOLD_MS`, the harness does **not**
kill it. It **asks**.

A judge — the arbiter seat when available, otherwise a fresh read-only instance
of an available seat — is given the evidence and asked one question:

> *Is this seat still working, or is it stuck?*

The evidence handed to it:

- **the last events**, with timestamps, and the gap so far;
- **the last agent message**, verbatim — which in the case above stated plainly
  that it was waiting on a subagent;
- **the process tree**: whether the seat has live descendants, and what they are.
  A seat with a busy child is waiting; a seat with none and nothing to say is
  not. The harness already builds this tree in `killProcessTree`; it must consult
  it before killing rather than only when killing;
- **recent worktree activity**: whether any file changed during the silence.

The judge answers **working** or **stuck**, with its reasoning.

- **working** → the seat is left alone, the gap timer resets, and
  `executor/extended` is emitted carrying the reasoning. It may be asked again
  after another interval; being asked twice is not evidence of death.
- **stuck** → kill, exactly as today, recording the gap, the last event, and the
  judge's reasoning.

The reasoning is recorded in the run facts either way. **A seat is never killed
without a stated reason a person can read.**

### 2. The judge is asked, not consulted deterministically

There is no channel to interject into a running `codex exec`; it reads stdin once
and streams out. So the judge is **not** the stuck process — it is a separate,
read-only invocation looking at the evidence from outside.

This is deliberate and worth stating: **the seat that cannot speak is spoken
about, by someone who can see what it left behind.** The evidence above is
exactly what a person would look at, and it was sufficient for one an hour ago.

### 3. Degrade honestly when no judge is available

If no judge can be reached, fall back to **today's behaviour: kill on silence**,
and record that the kill was unjudged.

Killing an idle seat is recoverable — partial work is preserved and the operator
sees the run. Leaving a genuinely wedged process alive forever is not. So the
fallback errs toward the kill, and says that it did so without judgement.

### 4. Events

Emit `liveness/asked`, `liveness/working`, and `liveness/stuck`.

**Declare every new stage and type in `EVENT_STAGES`, `EVENT_TYPES` and
`EVENT_PAIRS` in this same change.** Undeclared pairs have been silently
swallowed four times in this repository.

## Invariants

- **No seat is killed for silence without being asked about first**, unless no
  judge is available.
- A judged decision, in either direction, always records its reasoning.
- The judge is read-only and never writes to the worktree.
- Asking costs a small, bounded amount; it must not itself be able to hang the
  run.
- Partial work is still preserved before any kill.
- The gate keeps its clock — silence there means computing, as already recorded.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

Use the controlled-clock and injected-timer pattern from
`stall-watchdog.test.js`, including its positive control. No test may spawn a
real binary.

1. Silence past the threshold **asks** rather than killing — assert the judge was
   invoked and the process was not killed.
2. A judge answering **working** leaves the seat alive, resets the gap, and emits
   `executor/extended` carrying the reasoning.
3. A judge answering **stuck** kills, recording gap, last event, and reasoning.
4. **The reported case:** a last agent message stating the seat is waiting on a
   subagent, with a live descendant present, is judged **working** — the twenty
   minutes that were lost.
5. Silence with **no** descendants and no recent worktree activity is judged
   **stuck**.
6. A seat judged working twice in succession is not killed for having been asked
   twice.
7. No judge available falls back to killing, and the facts record the kill as
   unjudged.
8. The judge is given the process tree, the last agent message, and recent
   worktree activity — assert each reaches its input.
9. A judge that itself hangs does not hang the run.
10. Every `liveness/*` pair round-trips through `createEvent` without throwing.
11. **Positive control:** a seat producing output normally is never asked about
    and never killed.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Interjecting into a running `codex exec`. No such channel exists; the
  experimental `app-server` and `exec-server` modes are not adopted here.
- The gate's clock.
- The arbiter itself, the capability veto, Cursor's scoped write, STORM planning,
  or the FRESH pivot. Each has its own plan.
