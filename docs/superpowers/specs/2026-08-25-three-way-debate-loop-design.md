# Three-Way Debate Loop

**Date:** 2026-08-25
**Status:** Design approved, pending implementation

## Summary

Replace uroboros's one-shot verify stage with a **debate loop** — an iterative
conversation between Cursor (reviewer), Claude (orchestrator), and Codex (executor)
where each actor can challenge, resist, and converge. This is the default pipeline
behavior, not an opt-in mode.

## Motivation

Today's pipeline is strictly one-way:
- Codex writes code (can ask Claude questions via DECISION.md)
- Gate runs tests
- Cursor reviews read-only, emits a verdict
- Done

The problems:
1. Cursor can't act on what it finds — it sees bugs but can't make Codex fix them.
2. Cursor can't write tests — its concerns are prose, not executable assertions.
3. Claude never reviews Cursor's output — the verdict is accepted at face value.
4. There's no back-and-forth — one pass per actor, then the run is over.

## Design

### Pipeline

```
isolate → execute → gate → DEBATE LOOP → report
```

The debate loop replaces the old verify stage. If Cursor finds no issues on the
first pass, the loop exits immediately (same behavior as today's one-shot verify).

### Full Flow

```
USER submits a query/task
    |
CLAUDE writes the plan (TASK.md)
    |
CODEX reads the plan and EITHER:
  (a) implements it, OR
  (b) resists via DECISION.md
      -> CLAUDE validates/reframes -> updated plan -> CODEX retries
    |
GATE runs (user's original tests)
  -> if fails: error fed back to CODEX, retry
  -> if passes: enter debate loop
    |
DEBATE LOOP:
  CURSOR reviews implementation:
    -> writes REVIEW.md (structured findings)
    -> writes test files under __uro_review/tests/
    -> if no findings: EXIT LOOP, done
    |
  CLAUDE reads REVIEW.md, validates each finding:
    -> if all findings invalid: overrule, EXIT LOOP
    -> if valid findings exist: writes FIX_PLAN.md
    |
  CODEX reads FIX_PLAN.md and EITHER:
    (a) implements the fixes, OR
    (b) resists via DECISION.md
        -> CLAUDE reframes -> updated FIX_PLAN.md -> CODEX retries
    |
  GATE runs (original tests + Cursor's accumulated tests)
    -> if fails: error fed back to CODEX, retry
    -> if passes: back to CURSOR for re-review
    |
  CIRCLING DETECTION:
    If same findings persist across 3 consecutive rounds:
      1. AMEND: Claude reframes with fundamentally different approach
      2. FRESH: New branch from pre-debate state, new plan entirely
      3. CONCLUDE: Declare remaining findings unresolved, report them
    |
  Loop continues until Cursor is satisfied or pivot exhausted
    |
REPORT
```

### Key Properties

- **No round cap.** The loop runs until natural convergence. There is no hidden
  limit on how many conversation rounds can occur.
- **Every actor can resist.** Cursor resists bad implementations (raises issues).
  Codex resists bad fix plans (DECISION.md). Claude arbitrates and reframes.
- **Claude is always the hub.** Star topology. Cursor never talks to Codex
  directly. Every concern flows through Claude for validation before forwarding.
- **Manual mode escalates to the human.** In `--mode manual`, every
  "Claude validates" step becomes "human validates". The human sees the debate
  ledger and decides.
- **Autonomous mode is fully automatic.** Claude handles all validation,
  fix planning, and pivot decisions.
- **Backwards compatible.** When Cursor's first review has no findings, the
  debate loop exits after one pass — identical to today's one-shot verify.

## File Protocols

### REVIEW.md (Cursor -> Claude)

Written by Cursor to `__uro_review/REVIEW.md`:

```markdown
## Finding F1
Severity: blocking
Category: correctness
Description: The PSI calculation doesn't handle empty bins — division by
zero when a bin has zero reference count.
Test: __uro_review/tests/test_review_f1.py

## Finding F2
Severity: suggestion
Category: edge-case
Description: No handling for NaN inputs in the reference series.
Test: __uro_review/tests/test_review_f2.py
```

Parsing rules mirror DECISION.md:
- Headings: `## F1`, `## F2`, etc.
- Fields: `Severity` (blocking/suggestion), `Category`, `Description`, `Test`
- A finding is valid only with a severity AND description.
- The `Test` field is REQUIRED for `blocking` findings and optional for
  `suggestion` findings. A blocking finding without a test is demoted to
  suggestion by the harness (concerns without executable proof are advisory).

Cursor also writes the referenced test files — real pytest files that the gate
will execute.

### FIX_PLAN.md (Claude -> Codex)

Written by Claude after validating REVIEW.md:

```markdown
## Validated Findings
- F1 (blocking): PSI empty bin handling — VALID, fix required
- F2 (suggestion): NaN inputs — VALID, fix required

## Fix Instructions
1. In drift_psi.py, add a guard for bins where reference_count == 0
2. Add NaN handling at the top of compute_psi()

## Cursor's Tests
Tests at __uro_review/tests/test_review_f1.py, test_review_f2.py
These tests must pass along with the original gate.
Do NOT modify or delete files under __uro_review/.
```

Piped to Codex as stdin, appended to the original TASK.md context.

### DECISION.md (Codex -> Claude) — unchanged

The existing protocol. Codex can write this to push back on ANY plan — original
or fix plan. The existing `detectChallenge` / `routeChallenges` mechanism handles
it without modification.

## Actor Permissions

| Actor | Read | Write | Execute |
|-------|------|-------|---------|
| Codex (executor) | Full worktree | Full worktree (workspace-write) | N/A |
| Cursor (reviewer) | Full worktree | `__uro_review/` only | N/A |
| Claude (orchestrator) | Full worktree | TASK.md, FIX_PLAN.md, harness artifacts | Gate commands |
| Gate | Full worktree | N/A | pytest on worktree |

### Cursor's scoped write

Cursor runs with write capability but constrained by its skill instructions to
only write under `__uro_review/`. The harness validates post-hoc: any file Cursor
wrote outside `__uro_review/` is reverted before proceeding.

### Codex protection of review files

Codex is instructed (in the fix plan) NOT to delete or modify `__uro_review/`
files. The harness validates post-hoc: if Cursor's test files are missing after
a Codex run, they are restored from a stash taken before the executor invocation.

## Circling Detection and Pivot

### Detection

Claude maintains a **debate ledger** — the list of finding IDs from each round.

A finding is "circling" when:
- Same finding ID appears in 3 consecutive rounds, OR
- Total finding count is not decreasing over 3 rounds

### Pivot escalation ladder

1. **Amend** — Claude rewrites FIX_PLAN.md with a fundamentally different
   approach to the stuck finding. Same worktree, same accumulated work.

2. **Fresh approach** — New branch from the pre-debate snapshot. Cursor's
   accumulated test files carry over (they define the problem, not the
   solution). Claude writes a new plan with a different implementation
   strategy. Codex starts fresh.

3. **Conclude with findings** — Remaining findings declared unresolved.
   Included in the report with full debate history. No infinite loop.

### Event reporting

Each debate action emits a structured event to `events.jsonl`:

```json
{"stage":"debate","type":"review","round":1,"findings":["F1","F2"]}
{"stage":"debate","type":"validate","round":1,"accepted":["F1","F2"],"rejected":[]}
{"stage":"debate","type":"fix_plan","round":1}
{"stage":"debate","type":"resist","round":1,"questions":["Q1"]}
{"stage":"debate","type":"reframe","round":1}
{"stage":"debate","type":"gate","round":1,"passed":true}
{"stage":"debate","type":"circling","round":3,"stuck":["F1"]}
{"stage":"debate","type":"pivot","strategy":"amend"}
{"stage":"debate","type":"converged","round":2,"resolved":["F1","F2"]}
```

The dashboard renders these as a conversation timeline per run.

## Superpowers Skill Integration

Every actor uses superpowers skills at its decision points. Full mapping:

| Skill | Codex | Cursor | Claude |
|-------|-------|--------|--------|
| brainstorming | Before implementation: approach selection | Before review: failure mode analysis | Before fix plans, pivots, validation |
| writing-plans | — | — | FIX_PLAN.md, pivot plans, reframed approaches |
| executing-plans | Implementing original + fix plans | Executing review strategy | Executing debate protocol |
| test-driven-development | Writing code to pass tests | **Writing review test cases** | Validating test designs |
| systematic-debugging | Diagnosing gate failures | Diagnosing persistent findings | Diagnosing why the loop is stuck |
| verification-before-completion | Verifying fix addresses all findings | Verifying findings are real, not false positives | Verifying convergence is genuine |
| requesting-code-review | — | Core job: reviewing Codex's code | Requesting Cursor re-review after fixes |
| receiving-code-review | Reading REVIEW.md, deciding to fix or resist | — | Reading reviews to validate |
| dispatching-parallel-agents | — | — | Parallel review angles (correctness/perf/edge-cases) |
| subagent-driven-development | — | — | The debate loop itself |
| using-git-worktrees | Handled by harness | — | Fresh approach pivot |
| finishing-a-development-branch | — | — | Finalize after convergence |
| writing-skills | — | — | Updating uro-review skill |
| using-superpowers | Bootstrap | Bootstrap | Bootstrap |

### Skill installation per actor

- **Codex**: Superpowers is registered through Codex's plugin registry and verified by an
  `installed, enabled` row from `codex plugin list`. `codex exec` receives no plugin-directory
  flag and uses the same `CODEX_HOME` as that registry.
- **Cursor**: The verifier receives a resolved superpowers directory only when it carries a valid
  `.cursor-plugin` manifest and readable skills. Resolution is highest-version within compatible
  candidates; it never falls back to a higher `.codex-plugin`-only directory.
- **Claude**: The orchestrator's plugin directory is verified independently through its valid
  `.claude-plugin` manifest and readable skills.

All three checks are required for `run`, `batch`, `plan`, and `queue`. The explicit
`URO_REQUIRE_SUPERPOWERS=0` bypass is recorded in run facts and called out in the report. Facts
retain each seat's evidence and version because registry and directory versions can differ.

## CLI Surface

No new commands. No new flags for debate — it is the default pipeline behavior.

Existing flags and their meaning in debate context:
- `--mode manual`: Human validates findings and decides fixes (debate escalates)
- `--mode autonomous`: Claude validates and plans fixes automatically
- `--gate-retries`: Applies to each gate invocation within the debate loop

## Integration with Batch/Campaign

The debate loop lives inside `run()`. Each unit in a batch/campaign runs its
own debate conversation independently. No changes to `campaign.js` or the
scheduler.

- Token budget applies across all debate rounds for all units
- The dashboard shows each unit's debate timeline as a sub-section
- Concurrent units debate independently

## New Source Files

| File | Purpose |
|------|---------|
| `src/debate.js` | Debate loop state machine, ledger, circling detection |
| `src/review.js` | REVIEW.md parser (mirrors decision.js) |
| `src/fix-plan.js` | FIX_PLAN.md generator (Claude's fix planning) |
| `cursor-plugin/skills/uro-review/SKILL.md` | Cursor's review + test-writing skill |
| `test/debate.test.js` | Unit tests for debate loop |
| `test/review.test.js` | Unit tests for REVIEW.md parsing |

## Modified Source Files

| File | Change |
|------|--------|
| `src/run.js` | Replace verify stage with debate loop call |
| `src/verifier.js` | Add write-capable review mode alongside read-only verify |
| `src/artifacts.js` | Add `__uro_review/` to harness artifact paths |
| `skills/uroboros/SKILL.md` | Add debate protocol section |

## Testing

1. **Unit tests** for REVIEW.md parsing (mirrors decision.js test patterns)
2. **Unit tests** for circling detection algorithm
3. **Unit tests** for debate loop state transitions
4. **Integration test**: deliberately-buggy implementation that Cursor catches
   and Codex fixes over 2 rounds, converging to green
5. **Resistance test**: Codex pushes back on a fix plan via DECISION.md,
   Claude reframes, Codex implements the alternative
6. **Circling test**: mock a stuck loop, verify amend → fresh → conclude
   escalation fires in order
7. **Backwards compatibility**: run without debate-triggering findings,
   verify identical behavior to today's one-shot verify
