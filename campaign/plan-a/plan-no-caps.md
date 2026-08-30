# Remove every elapsed-time cap. Silence is the only thing that kills.

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

No elapsed-time limit on any stage; a seat dies only when it goes silent

## Context

Every stage in this tool is bounded by a wall-clock number, and every one of
those numbers was invented rather than measured:

| Bound | Value | Origin |
|---|---|---|
| `DEFAULT_EXECUTOR_TIMEOUT_MS` | 30 min | baseline, 2026-08-15 |
| `DEFAULT_VERIFIER_TIMEOUT_MS` | 10 min | baseline, 2026-08-15 |
| `DEFAULT_GATE_TIMEOUT_MS` | 60 min | baseline, 2026-08-15 |
| `DEFAULT_EXECUTOR_MAX_MS` | 6 h | added this session |
| `DEFAULT_DEBATE_ROUNDS` | 2 | added this session |
| `loop plan --rounds` | operator-supplied | added this session |

Each has already caused a real failure. The 30-minute executor bound killed two
healthy waves in the field. The 10-minute verifier bound killed a reviewer
mid-read of a ten-file diff — and reported it as `ISSUES`, indistinguishable from
a real finding. The 2-round debate cap contradicts the design's stated **"No
round cap"**. `loop plan --rounds 3` ended its first real run at
`rounds-exhausted` with no plan written.

Elapsed time does not distinguish working from stuck. It never did. **A seat
that is producing output is alive, however long it has been running; a seat that
has produced nothing is stuck, however briefly.**

The executor already works this way — liveness on any stdout byte, progress
reported separately and never killing. This applies that model everywhere and
removes the clocks entirely.

## Required behavior

### 1. No stage has an elapsed-time limit

Remove, for the executor, the verifier, and the debate loop:

- `DEFAULT_EXECUTOR_TIMEOUT_MS`, `DEFAULT_VERIFIER_TIMEOUT_MS`,
  `DEFAULT_EXECUTOR_MAX_MS`, `DEFAULT_DEBATE_ROUNDS`, `MAX_DEBATE_ROUNDS`.
- The corresponding hard kills. Nothing dies because a clock advanced.

`URO_EXECUTOR_TIMEOUT_MS`, `URO_VERIFIER_TIMEOUT_MS`, `URO_DEBATE_ROUNDS` and
`--executor-timeout` / `--verifier-timeout` / `--rounds` remain as **optional
operator overrides**. Absent, there is no limit. Set, they are honoured — the
operator may bound their own run; the tool may not invent one.

The unprefixed-environment-variable warning must keep working for these names.

### 2. Silence is the only thing that kills

The single kill condition for an agent seat is **liveness**: no byte on stdout
for `URO_STALL_THRESHOLD_MS`, default **5 minutes**.

- Applies to the executor **and both verifier passes**. The verifier already
  requests `--output-format stream-json`; observe that stream as it arrives, as
  `executor.js` does, rather than parsing only at the end.
- **Progress** silence — no `item.completed` — remains informational and never
  kills, at either seat.
- On a liveness kill, record the gap, the last observed event, and the setting
  that governs it. Preserve partial work before killing, as the executor already
  does.
- A killed seat that produced no parseable verdict is **`UNVERIFIED`**, never
  `ISSUES`. Being killed is not a finding. This closes the timeout path that
  currently bypasses `deriveVerdictFromEvidence`.

### 3. The debate loop runs to convergence

No round cap. The loop ends on convergence, on the pivot ladder reaching
`CONCLUDE`, or on the operator's token budget — never on a count the tool chose.

`loop plan` likewise: `--rounds` becomes optional, and absent it plans until it
converges or the ladder concludes.

### 4. The gate keeps a bound, and here is why

**`DEFAULT_GATE_TIMEOUT_MS` stays.**

Liveness cannot be applied to the gate. A compiler or a test suite may legitimately
produce nothing for minutes while working hard; silence there means *computing*,
not *stuck*. Killing on it would break exactly the long, quiet builds the gate
exists to run.

And unlike an agent seat, a wedged gate command cannot be bounded by the token
budget, because it spends no tokens. Without any bound, a gate command waiting on
input would hang the run forever with nothing able to stop it.

So the gate keeps its clock. This is the one place where a cap is doing real work
rather than substituting for judgement, and it is recorded here as a deliberate
exception rather than an oversight.

## Invariants

- **No agent seat is ever killed for elapsed time.** Only for silence.
- Progress silence never kills, anywhere.
- Operator-supplied bounds are always honoured; tool-invented ones no longer
  exist.
- `UNVERIFIED` remains not-approval and cannot land a change.
- Partial work is preserved before any kill.
- The gate remains the only thing that can pass a change.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

Use the controlled-clock and injected-timer pattern from
`stall-watchdog.test.js`, including its positive control. No test may depend on
real elapsed time.

1. An executor emitting output for far longer than the former 30-minute default
   is **never killed** — the field failure, as a regression control.
2. A verifier emitting output for far longer than the former 10-minute default is
   never killed.
3. Silence past the liveness threshold kills, at the executor **and** at both
   verifier passes, recording the gap and last event.
4. Progress silence with bytes still flowing never kills, at either seat.
5. A verifier killed for silence with no parseable verdict yields `UNVERIFIED`,
   never `ISSUES`.
6. A verifier killed **after** a verdict marker was parsed keeps that verdict.
7. A debate producing findings indefinitely is not stopped by a round count;
   it ends on the pivot ladder or the token budget.
8. `URO_DEBATE_ROUNDS`, when set, still caps — operator bounds are honoured.
9. `--executor-timeout` and `--verifier-timeout`, when set, still apply.
10. With none set, no elapsed-time kill occurs at any agent seat.
11. The gate still honours `DEFAULT_GATE_TIMEOUT_MS` — the deliberate exception.
12. Partial work is preserved before a liveness kill.
13. **Positive control:** a normal run finishing quickly is unaffected — no
    extension, no kill, verdicts unchanged.

Do not delete, skip, or weaken any existing test.

## Out of scope

- The arbiter, capability veto, Cursor's scoped write, STORM planning, the FRESH
  pivot, and the superpowers wiring. Each has its own plan.
- Changing what the token budget does; it remains the operator's own bound.
