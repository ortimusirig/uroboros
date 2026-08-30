# Prove the green means something: mutation coverage as a gate capability

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

`loop mutate` — disable what a change added and report what nothing notices

## Context — measured today, twice

Two changes this session passed the full suite and both verifier seats while
containing code that **no test depended on**.

The second was caught by a reviewer that supplied a falsification recipe:

> *"Counterfactual: remove `decide(decision)` from `createLivenessDeadline` → all
> new tests stay green while production `facts.livenessChecks` stays empty."*

Run by hand, it reproduced exactly: three `decide(decision)` calls commented out,
**685 tests, 685 passing**. The production path that records liveness decisions
into the run facts was unreachable from any test, and the suite was green either
way.

The earlier case was the same shape: a test asserting a durable `CHANGES.diff`
was *absent* after a no-op run, which an implementation that never archived
anything would also satisfy.

**Line coverage cannot see this.** The mutated lines were executed. They were
simply never depended upon. Coverage answers *"did this run?"*; the question that
matters is *"would anyone notice if it stopped?"*

This is mutation testing, a technique from the late 1970s. Its known and fatal
cost is exhaustiveness — the reason it stayed academic for decades — and the
known industrial answer is to scope it to the diff and surface a handful of
results at review time. That is what this builds, in the narrowest useful form.

## Required behavior

### 1. `loop mutate`

```
loop mutate --target <dir> [--base <ref>] [--tests <cmd>] [--dry-run]
```

Establishes a baseline, then reports which parts of the change nothing tests.

- **Baseline first.** Run the tests unmutated. If they are not green, stop and
  say so — mutation results are meaningless against a red suite.
- **Scope: production lines the diff added.** Not pre-existing code, not test
  files, not comments, blank lines or imports. Mutating a test proves nothing,
  and pre-existing code is not this change's responsibility.
- **One operator: statement deletion.** Disable the statement and see whether
  anything fails. The cheapest operator, and the one that catches the class both
  of today's defects belong to. Other operators are out of scope.
- Restore after every trial. The working tree must be byte-identical afterwards,
  **including when the run is interrupted**.

### 2. Grouping is chosen by judgement, not by a constant

Lines are not mutated one at a time, and groups are not a fixed size.

The planner is given the diff and chooses **semantically coherent units** — a
function, a branch, a block — because a surviving unit must name something a
person can act on:

```
arbitrary chunk survives  →  "lines 269-273 are untested"     unusable
semantic unit survives    →  "recordLivenessDecision() is     actionable
                              untested"
```

If no judge is available, fall back to grouping by enclosing function, and record
that the grouping was unjudged. Never fall back to a fixed chunk size; that is
the arbitrary constant this whole approach exists to avoid.

### 3. Survivors are definitive; kills are provisional

The asymmetry governs the search and must not be flattened:

| Result | Meaning | Action |
|---|---|---|
| **group survives** | **every line in it is untested** | definitive — report the unit, stop |
| **group killed** | at least one line is tested; the others are unknown | **subdivide** and retest the halves |

Killed groups are subdivided along semantic boundaries where they exist. A killed
group is **never** reported as "tested" without subdivision — grouping can mask
an interaction where two lines each matter individually but a test passes with
both removed. Survivors are trustworthy; kills only narrow.

Subdivision stops when a unit is a single statement, or when the operator's
budget is reached — and an exhausted budget is **reported as unexamined**, never
as clean.

### 4. Cost is bounded by the change, not the repository

- Only tests touching the changed modules run per trial, not the whole suite.
- Trials run concurrently up to a small limit.
- `--dry-run` lists the units it would mutate and the tests it would run for
  each, and **executes nothing**.
- The run reports units examined, survivors, kills, and anything left unexamined.

### 5. The verdict is evidence; the decision is judged

`loop mutate` **reports**. It does not decide whether a survivor is acceptable.

A survivor may be perfectly fine — a log line, a defensive guard, a field nothing
consumes yet. Distinguishing those from a real gap requires reading the code, so
each survivor is presented to the arbiter with its unit, its diff context, and
the tests that were run, and the arbiter judges **gap** or **acceptable, with
reasoning**.

Both the measurement and the judgement are recorded. The measurement is
un-arguable; the judgement is stated and can be disagreed with.

### 6. Wiring into the loop

`loop mutate` is usable alone. It is also runnable after a passing gate, so a run
can report survivors alongside its verdict.

**Do not make a survivor fail the gate in this change.** The gate's meaning —
your commands, your exit codes — must not be quietly widened. Surfacing survivors
to the arbiter and the report is the whole of this task; whether they can block a
change is a separate decision.

### 7. Events and documentation

Emit `mutate/start`, `mutate/unit`, `mutate/survivor`, `mutate/finish`.

**Declare every new stage and type in `EVENT_STAGES`, `EVENT_TYPES` and
`EVENT_PAIRS` in this same change.** Undeclared pairs have been silently
swallowed four times in this repository.

Add `commands/mutate.md`, name `mutate` in `skills/uroboros/SKILL.md` as a whole
token, and list it in the CLI usage text — the repository's own tests require it.

## Invariants

- **The working tree is restored exactly**, including on interruption or error.
- A red baseline stops the run; results against a red suite are meaningless.
- Test files, comments and pre-existing code are never mutated.
- A killed group is never reported as tested without subdivision.
- An exhausted budget is reported as unexamined, never as clean.
- **The gate's meaning is unchanged.** A survivor does not fail it here.
- Zero external dependencies — no mutation framework is adopted.
- ESM style matching the rest of the codebase.

## Test requirements

Use injected seams; no test may spawn a real agent.

1. A line that **no test depends on** is reported as a survivor.
2. A line that **is** depended upon is killed and not reported — the control
   proving the technique discriminates.
3. **The reported case:** a facts-writing line reachable only through a stubbed
   caller survives; assert it is named.
4. A killed group is **subdivided**, not reported as tested.
5. A surviving group reports **every** line in it, without subdivision.
6. Grouping follows semantic units when a judge is available; with none, it falls
   back to enclosing function and records the grouping as unjudged.
7. Grouping **never** falls back to a fixed chunk size.
8. A red baseline stops the run and says so.
9. Test files, comments, blank lines and imports are not mutated.
10. Pre-existing lines are not mutated — only what the diff added.
11. The working tree is byte-identical afterwards, **including after a thrown
    error mid-run**.
12. `--dry-run` executes nothing and lists the units and their tests.
13. An exhausted budget reports unexamined units.
14. A survivor is presented to the arbiter and the judgement is recorded
    alongside the measurement.
15. A survivor does **not** fail the gate — the unchanged-meaning control.
16. Every `mutate/*` pair round-trips through `createEvent` without throwing.
17. `mutate` appears in `commands/`, in `SKILL.md`, and in the usage text.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Mutation operators beyond statement deletion.
- Mutating pre-existing code, or whole-repository mutation.
- Adopting an external mutation framework.
- Making a survivor fail the gate.
- Equivalent-mutant detection, which is undecidable in general; the arbiter's
  judgement on each survivor is the practical substitute.
