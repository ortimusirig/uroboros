# A runner that works the queue without a human

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

`loop queue` — run a list of plans in sequence, land the safe ones, and stop on
anything else

## Context

`loop run` executes exactly one pass and exits. Nothing works a list. In practice
a human has been the scheduler: start a run, wait, read the result, apply it,
start the next. That human is not always present, and finished runs have sat
uncollected for hours while the work itself was complete.

The gap is not agent capability. It is that no component owns the loop between
runs.

## Required behavior

### 1. A queue file

`loop queue --file <path>` reads a JSON list of units:

```json
[
  { "task": "campaign/plan-a/plan-x.md", "gate": "campaign/plan-a/gate-x.json" },
  { "task": "campaign/plan-a/plan-y.md", "gate": "campaign/plan-a/gate-y.json" }
]
```

Each unit may also carry an optional `name`. Units run **in order**, one at a
time. No concurrency: each unit's result may change the base the next one builds
on.

### 2. What happens after each run

Read the completed run's `uro-runfacts.json` and decide:

| Condition | Action |
|---|---|
| `outcome === 'review-ready'` **and** gate passed **and** both verifier verdicts are `NO_BLOCKERS` | **land it**: apply `CHANGES.diff` to the target, commit with a message naming the unit and the run id, continue to the next unit |
| `outcome === 'review-ready'` but either seat reported `ISSUES` or `UNVERIFIED` | **stop the queue.** Do not apply. Record why |
| any other outcome — `needs-decision`, `needs-pivot`, `gate-failed`, `executor-failed`, `no-op`, `timed-out`, `conflicting-intent` | **stop the queue.** Record the outcome and, for `needs-decision`, the questions |

**A seat that reported issues is never overridden.** This is the whole reason the
seats exist: a run in this repository reported `review-ready` while both seats
reported `ISSUES` on a real logic bug. A runner that trusted `outcome` alone
would have committed it.

`UNVERIFIED` counts as not-approved, never as approval.

### 3. Mode passthrough — the planner drives it autonomously

`loop queue --mode <manual|autonomous>` passes the mode straight through to each
`loop run`. Default **manual**, matching `loop run`.

With `--mode autonomous` the resolver shipped in §8 answers an executor challenge
and the run continues instead of halting. **This is the intended way to drive the
queue unattended.**

One interaction must be handled explicitly. A daemon run has **no TTY**, so
`interaction-signals.js` reports the operator as absent, and an `authority`
question may therefore be answered by the resolver and recorded as
`decision/assumed` with `escalation: 'operator-absent'`. That is the designed
behaviour — halting for an operator who is not there is useless — but it must
never be quiet:

- A unit resolved through `decision/assumed` is **landed normally if the gate
  passed and both seats approved**, exactly like any other unit. The escalation
  changes nothing about the safety rules.
- Its `queue-log.jsonl` line carries `escalation: 'operator-absent'` and the
  questions that were answered.
- The final summary **lists every such unit separately, above the totals**, so
  the first thing the operator reads on returning is which decisions were taken
  in their absence and what they were.

### 4. Limits the operator sets

- `--max-runs <n>` — stop after n units regardless of remaining queue.
- `--token-budget <n>` — before starting a unit, stop if total input+output
  tokens consumed so far in this queue would be likely to exceed the budget;
  always stop once it has been exceeded. Never abandon a run already in flight.
- `--dry-run` — print the units in order with their resolved task and gate paths,
  validate that every file exists, and **spend nothing**. No run is started.

Defaults: no `--max-runs` and no `--token-budget` means unbounded, so both must
be stated explicitly to bound a session. `--dry-run` is always safe.

### 5. Applying safely

- Apply with a dry-run check first; refuse and stop the queue if the diff does
  not apply cleanly.
- Refuse to start if the target working tree is dirty, so a failed apply never
  mixes with uncommitted work.
- Commit only the paths the diff touched.
- Never push. Publishing stays an explicit operator action.

### 6. A readable trail

Write `queue-log.jsonl` beside the queue file: one line per unit with its name,
run id, outcome, both verdicts, tokens, duration, and whether it was landed or
stopped on. Print a final summary: units landed, unit stopped on and why, total
tokens.

## Invariants

- **The gate remains the only thing that can pass a change**, and both seats must
  approve before anything is committed. The runner adds no new authority.
- Stopping is the default response to anything unexpected. The runner never
  retries, never skips a failing unit, and never continues past a stop.
- The runner spends no tokens of its own: it starts runs and reads their facts.
- Nothing is pushed, ever.
- Zero external dependencies. ESM style matching the rest of the codebase.
- The run path itself is untouched: this composes `loop run`, it does not
  reimplement it.

## Test requirements

Use injected seams so no test starts a real run.

1. Three units, all `review-ready` with both seats `NO_BLOCKERS`: all three land,
   in order, and the summary reports three landed.
2. Unit 2 returns `review-ready` with correctness `ISSUES`: unit 1 landed, **unit
   2 is not applied**, unit 3 never starts, and the stop reason names the seat.
3. Unit 2 returns `UNVERIFIED` from a seat: same — not applied, queue stops.
4. Unit 2 returns `needs-decision`: queue stops and the recorded reason carries
   the questions.
5. Unit 2 returns `gate-failed`: queue stops; no apply attempted.
6. `--max-runs 1` runs one unit and stops with two remaining.
7. `--token-budget` stops before starting a unit that would exceed it, and never
   interrupts a run already started.
8. `--dry-run` starts nothing, spends nothing, and reports every unit; a missing
   task or gate file is reported as an error.
9. A diff that does not apply cleanly stops the queue and leaves the target
   unchanged.
10. A dirty target working tree is refused before any unit starts.
11. `queue-log.jsonl` gains exactly one line per attempted unit.
12. `--mode autonomous` is passed through to every unit; the default is manual.
13. A unit resolved through `decision/assumed` is landed when the gate passed and
    both seats approved, its log line carries `escalation: 'operator-absent'` and
    the questions, and the summary lists it separately above the totals.
14. **Positive control:** a queue whose first unit stops proves later units never
    started — assert the run launcher was called exactly once.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Concurrency. Units run strictly one at a time.
- Retrying, skipping, or repairing a failed unit.
- Writing or amending plans.
- Pushing, publishing, or any GitHub interaction.
- Scheduling by time of day. This runs a queue and exits; a timer is the
  operator's own tooling.
