# Uroboros: Claude ↔ Codex ↔ Cursor — The Three-Way Debate Loop

> Final flow document. Copy to `C:\Users\SGIRI\Documents\Obsidian-ai\Claude-Codex-Cursor-Loop\`

---

## What is Uroboros?

A **zero-dependency Node.js CLI** that orchestrates three AI agents in a structured pipeline:

| Agent | Role | Model | Mode |
|-------|------|-------|------|
| **Claude** (Claude Code) | Orchestrator — plans, validates, arbitrates | claude-opus-4 | Hub of the star topology |
| **Codex** (OpenAI Codex CLI) | Executor — writes code, can resist plans | gpt-5.6-sol | `workspace-write` (full repo access) |
| **Cursor** (Cursor IDE agent) | Reviewer — reviews code, writes tests, challenges | cursor-grok-4.5-high | `--mode plan` (read-only + scoped writes) |

**Key constraint**: Star topology. Cursor never talks to Codex directly. Every message flows through Claude.

---

## The Pipeline (Before Debate)

```
USER
  │
  ├── query/task + optional test files (gate)
  │
  ▼
┌──────────────────────────────────────────────┐
│                  UROBOROS                      │
│                                               │
│  1. ISOLATE   — git worktree for isolation    │
│  2. EXECUTE   — Codex writes code             │
│  3. GATE      — run user's tests              │
│  4. VERIFY    — Cursor reviews (ONE SHOT)     │
│  5. REPORT    — markdown summary              │
└──────────────────────────────────────────────┘
```

**Problem**: Steps 1-5 are strictly **one-way**. Cursor sees bugs but can't make Codex fix them. There's no back-and-forth. One pass per actor, done.

---

## The Pipeline (With Debate Loop)

```
USER
  │
  ├── query/task + optional test files (gate)
  │
  ▼
┌──────────────────────────────────────────────────────────┐
│                       UROBOROS                            │
│                                                          │
│  1. ISOLATE    — git worktree for isolation               │
│  2. EXECUTE    — Codex implements (or resists via         │
│                  DECISION.md → Claude reframes)           │
│  3. GATE       — run user's original tests                │
│  4. DEBATE LOOP ◄────────────────────────────────┐       │
│     │                                             │       │
│     ├─ CURSOR reviews → REVIEW.md + test files    │       │
│     │   └─ no findings? → EXIT LOOP               │       │
│     │                                             │       │
│     ├─ CLAUDE validates findings                  │       │
│     │   └─ all invalid? → overrule, EXIT LOOP     │       │
│     │                                             │       │
│     ├─ CLAUDE writes FIX_PLAN.md                  │       │
│     │                                             │       │
│     ├─ CODEX implements fixes (or resists via     │       │
│     │   DECISION.md → Claude reframes)            │       │
│     │                                             │       │
│     ├─ GATE runs (original + Cursor's tests)      │       │
│     │   └─ fails? → error back to Codex           │       │
│     │                                             │       │
│     └─ CIRCLING? ─────────────────────────────────┘       │
│          └─ yes → PIVOT (amend → fresh → conclude)        │
│                                                          │
│  5. REPORT     — full debate history + verdict            │
└──────────────────────────────────────────────────────────┘
```

**The debate loop IS the verify stage.** Not a separate mode. Not opt-in. If Cursor has nothing to say, it exits after one pass (identical to today).

---

## Detailed Flow: Every Step

### Step 0: User Submits

```
uro run --task plan.md --target ./myproject --gate gate.json
```

- `--task`: markdown plan describing what to build
- `--target`: the repo/directory to work in
- `--gate`: JSON array of test commands that must pass
- `--mode manual|autonomous`: who arbitrates the debate

### Step 1: Isolate

```
main repo ──git worktree──► scratch/<runId>/w/
```

A fresh git worktree is created. All work happens in isolation. The main repo is never touched. On completion, changes can be merged back.

### Step 2: Execute (Codex)

```
         ┌──────────────┐
TASK.md ─┤    CODEX      ├─► code changes in worktree
  stdin  │  gpt-5.6-sol  │   OR
         │ workspace-write│   DECISION.md (resistance)
         └──────────────┘
```

Codex reads the plan via stdin and writes code. It can:
- **(a) Implement** — writes files, tests pass, move on
- **(b) Resist** — writes `DECISION.md` with structured questions

**DECISION.md format** (Codex → Claude):
```markdown
## Q1
Kind: clarify
Question: Should the parser handle Windows line endings?
Options: a) Yes, normalize CRLF. b) No, assume Unix.
Recommendation: a
```

When Codex resists:
- **Autonomous mode**: Claude reads DECISION.md, answers each question, feeds updated plan back to Codex. Max 2 challenge rounds.
- **Manual mode**: Human answers the questions.

### Step 3: Gate

```
┌──────────────────────┐
│ node --test test/*.js │  ← user's original tests
│ pytest tests/         │
│ npm run lint          │
└──────────────────────┘
         │
    exit 0? ──yes──► enter debate
         │
    exit 1? ──► error fed to Codex, retry (up to --gate-retries)
```

The gate is the user's test suite. It's the objective truth. It runs before and during every debate round.

### Step 4: Debate Loop

This is where the three-way conversation happens.

#### Round N, Phase 1: Cursor Reviews

```
         ┌───────────────────┐
worktree ┤     CURSOR          ├──► __uro_review/REVIEW.md
  + diff │ cursor-grok-4.5-high│    __uro_review/tests/*.py
         │   read-only + scoped│
         └───────────────────┘
```

Cursor reads the implementation and the diff. It writes:

**REVIEW.md** — structured findings:
```markdown
## F1
Severity: blocking
Category: correctness
Description: detectCircling early-returns false on strictly
  decreasing counts before checking stuck findings.
Test: __uro_review/tests/test_circling_stuck.py

## F2
Severity: suggestion
Category: edge-case
Description: No handling for non-consecutive round numbers.
Test: __uro_review/tests/test_nonconsecutive.py
```

**Parsing rules**:
- `Severity`: `blocking` or `suggestion`
- A valid finding needs severity + description
- `blocking` without a `Test` → demoted to `suggestion` (concerns without executable proof are advisory)
- Cursor also writes real test files that the gate can execute

**If no findings**: EXIT LOOP. Verdict: NO_BLOCKERS. Same as today's one-shot verify.

#### Round N, Phase 2: Claude Validates

```
         ┌──────────────────┐
REVIEW.md┤     CLAUDE         │
  + code │  orchestrator      ├──► accept/reject each finding
  + tests│                    │    write FIX_PLAN.md
         └──────────────────┘
```

Claude reads REVIEW.md and validates each finding against the code:
- **Accept**: Finding is real, fix required
- **Reject**: False positive, overruled with reason

If ALL findings rejected → EXIT LOOP. Verdict: NO_BLOCKERS (Claude overruled).

Otherwise, Claude writes **FIX_PLAN.md**:
```markdown
# Fix Plan

## Original Task
<the original TASK.md content>

## Validated Findings
- **F1** (blocking): detectCircling doesn't honor OR condition
- **F2** (suggestion): rejected — non-consecutive rounds are handled by stuckFindings

## Cursor's Tests
Do NOT modify or delete files under __uro_review/.
- `__uro_review/tests/test_circling_stuck.py`
```

#### Round N, Phase 3: Codex Fixes (or Resists)

```
              ┌──────────────┐
FIX_PLAN.md ──┤    CODEX      ├──► fixed code in worktree
  + TASK.md   │  gpt-5.6-sol  │   OR
    stdin     │ workspace-write│   DECISION.md (resistance)
              └──────────────┘
```

Codex reads the fix plan and either:
- **(a) Implements the fixes** — modifies code to address findings
- **(b) Resists** — writes DECISION.md explaining why the finding is wrong or the fix is inappropriate

When Codex resists a fix plan:
- Claude reads the resistance, re-evaluates
- May side with Codex (drop the finding) or reframe the approach
- Updated FIX_PLAN.md sent back to Codex

**Codex MUST NOT** delete or modify files under `__uro_review/`. The harness validates this and restores from stash if violated.

#### Round N, Phase 4: Gate (Expanded)

```
┌────────────────────────────────┐
│ original tests                  │  ← user's gate
│ + __uro_review/tests/*.py       │  ← Cursor's accumulated tests
└────────────────────────────────┘
```

Both the original gate AND Cursor's tests must pass. The test suite grows with each round — Cursor's tests are ADDITIVE.

#### Round N, Phase 5: Circling Detection

```
         ┌──────────────────────┐
Debate   │  CIRCLING DETECTOR    │
Ledger   │                       │──► circling? → PIVOT
(all     │  stuckFindings()      │    not circling? → back to Cursor
rounds)  │  detectCircling()     │
         └──────────────────────┘
```

The **DebateLedger** tracks finding IDs per round. Circling is detected when:
- **A finding appears in all of the last 3 consecutive rounds** (stuck), OR
- **Total finding count is NOT decreasing** over the last 3 rounds

These are OR conditions — stuck alone triggers circling even if counts decrease.

**Pivot escalation ladder** (`shouldPivot`):

| Pivot # | Strategy | What happens |
|---------|----------|--------------|
| 0 | **AMEND** | Claude rewrites FIX_PLAN.md with a fundamentally different approach. Same worktree. |
| 1 | **FRESH** | New branch from pre-debate snapshot. Cursor's tests carry over. Claude writes new plan. Codex starts over. |
| ≥2 | **CONCLUDE** | Remaining findings declared unresolved. Full history in report. Loop ends. |

---

## The Two Modes

### Autonomous Mode (`--mode autonomous`)

```
Claude makes ALL decisions:
  - Answers Codex's DECISION.md questions
  - Validates Cursor's findings
  - Writes fix plans
  - Decides pivots
  - Ends when converged
```

Fully automatic. The loop runs until Cursor is satisfied or pivots are exhausted.

### Manual Mode (`--mode manual`)

```
Human makes KEY decisions:
  - Answers Codex's DECISION.md questions
  - Validates Cursor's findings (accept/reject)
  - Approves fix plans
  - Decides pivot strategy
  - Can override any actor
```

The debate is surfaced as a readable conversation. The human sees every actor's position and decides.

---

## File Protocol Summary

| File | Writer | Reader | Purpose |
|------|--------|--------|---------|
| `TASK.md` | Claude | Codex | Original implementation plan |
| `DECISION.md` | Codex | Claude/Human | Resistance / pushback questions |
| `__uro_review/REVIEW.md` | Cursor | Claude | Structured findings from review |
| `__uro_review/tests/*.py` | Cursor | Gate | Executable test cases for findings |
| `FIX_PLAN.md` | Claude | Codex | Validated findings + fix instructions |

All communication is through **files in the worktree** — no direct agent-to-agent API calls.

---

## Actor Permissions

| Actor | Read | Write | Execute |
|-------|------|-------|---------|
| **Codex** | Full worktree | Full worktree | — |
| **Cursor** | Full worktree | `__uro_review/` only | — |
| **Claude** | Full worktree | `TASK.md`, `FIX_PLAN.md`, harness artifacts | Gate commands |
| **Gate** | Full worktree | — | Test commands |

Cursor's writes outside `__uro_review/` are reverted. Codex's deletions of `__uro_review/` files are restored from stash.

---

## Circling Detection: The Math

```javascript
class DebateLedger {
  record(round, findingIds)     // track what Cursor found
  stuckFindings()               // IDs in ALL of last 3 rounds
  resolvedFindings()            // IDs that disappeared
  allFindings()                 // every ID ever seen
}

detectCircling(ledger):
  if < 3 rounds → false
  if last round empty → false (converged!)
  if stuckFindings.size > 0 → true (stuck = circling)
  if counts NOT strictly decreasing → true
  else → false (making progress)

shouldPivot(pivotCount):
  0 → AMEND
  1 → FRESH
  ≥2 → CONCLUDE
```

---

## Superpowers Skill Integration

Every actor uses **superpowers** skills at its decision points:

| Skill | Codex | Cursor | Claude |
|-------|-------|--------|--------|
| **brainstorming** | Approach selection | Failure mode analysis | Fix plans, pivots, validation |
| **writing-plans** | — | — | FIX_PLAN.md, pivot plans |
| **test-driven-development** | Writing code to pass tests | **Writing review test cases** | Validating test designs |
| **systematic-debugging** | Gate failures | Persistent findings | Why the loop is stuck |
| **verification-before-completion** | Fix addresses all findings | Findings are real | Convergence is genuine |
| **requesting-code-review** | — | Core job | Requesting re-review |
| **receiving-code-review** | Reading REVIEW.md | — | Reading reviews |
| **using-git-worktrees** | Handled by harness | — | FRESH pivot |

---

## Implementation Status (2026-08-25)

### Foundation Modules (COMPLETE — built through Arm B campaign)

| Module | Tests | Gate | Verify | Status |
|--------|-------|------|--------|--------|
| `src/review.js` | 10/10 | passed | NO_BLOCKERS | Done |
| `src/fix-plan.js` | 10/10 | passed | NO_BLOCKERS | Done |
| `src/debate.js` | 18/18 | passed | NO_BLOCKERS | Done (2nd run after Cursor caught spec-vs-test gap) |

### What Each Module Does

**`src/review.js`** — REVIEW.md parser
- `parseReview(content)` → array of `{id, severity, category, description, test}` or null
- `detectReview({dir})` → `{reviewed, findings, testFiles}` by scanning `__uro_review/`
- `REVIEW_DIR` constant = `'__uro_review'`
- Demotes `blocking` without a test to `suggestion`

**`src/fix-plan.js`** — FIX_PLAN.md generator
- `validateFindings(findings)` → `{accepted: string[], rejected: string[]}`
- `buildFixPlan({findings, accepted, rejected, originalTask})` → markdown string
- Returns `''` when nothing to fix (accepted is empty)

**`src/debate.js`** — Debate loop state machine
- `DebateLedger` class — tracks findings per round
- `detectCircling(ledger)` — OR of stuck findings and non-decreasing counts
- `shouldPivot(pivotCount)` — escalation ladder: AMEND → FRESH → CONCLUDE
- Uses `Symbol` for shared private method (accessible to `detectCircling` but not enumerable)

### Still Needed

- [ ] Wire debate loop into `src/run.js` (replace verify stage)
- [ ] Add write-capable review mode to `src/verifier.js`
- [ ] Update `cursor-plugin/skills/uro-review/SKILL.md` for test writing
- [ ] Add `__uro_review/` to `src/artifacts.js`
- [ ] Integration tests (deliberately-buggy impl → multi-round convergence)
- [ ] Resistance test (Codex pushes back via DECISION.md mid-debate)
- [ ] Circling test (mock stuck loop → amend → fresh → conclude)

---

## The Meta-Story: Cursor Caught a Real Bug

During the implementation campaign, **Cursor proved the debate loop works before the loop itself existed**:

1. I wrote tests for `detectCircling` where the case `3→2→1 with F1 stuck` expected `false`
2. Codex implemented to pass my test — early-returning `false` on strictly decreasing counts
3. Cursor reviewed and flagged: "the spec says OR — stuck finding alone should trigger circling, but the early return skips the stuck-findings check"
4. I fixed the test to match the spec (expect `true` for that case)
5. Codex re-implemented correctly — checking stuck findings FIRST, before the count trend
6. Cursor verified: NO_BLOCKERS

**This is the exact scenario the three-way debate loop is designed for** — Cursor catches something the test author missed, Claude validates, Codex fixes. It happened naturally even in the one-shot pipeline.

---

## Architecture Diagram

```
                    ┌─────────────────────────┐
                    │         USER             │
                    │  (query + tests + mode)  │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │         CLAUDE            │
                    │    (orchestrator hub)     │
                    │                           │
                    │  • Plans (TASK.md)         │
                    │  • Validates findings      │
                    │  • Writes FIX_PLAN.md      │
                    │  • Answers DECISION.md     │
                    │  • Detects circling        │
                    │  • Decides pivots          │
                    │  • Runs gate               │
                    └──────┬──────────┬─────────┘
                           │          │
              TASK.md /    │          │    REVIEW.md /
              FIX_PLAN.md  │          │    test files
              DECISION.md  │          │
                           │          │
                ┌──────────▼──┐  ┌───▼───────────┐
                │    CODEX     │  │    CURSOR      │
                │  (executor)  │  │  (reviewer)    │
                │              │  │                 │
                │ • Implements │  │ • Reviews code  │
                │ • Fixes      │  │ • Writes tests  │
                │ • Resists    │  │ • Challenges    │
                └──────────────┘  └─────────────────┘
                        │                  │
                        │     ┌────────┐   │
                        └────►│  GATE  │◄──┘
                              │ (tests)│
                              └────────┘
```

**Star topology**: Cursor and Codex never communicate directly. All flows through Claude.

---

## Quick Reference: CLI Commands

```bash
# Single run (debate is the default verify)
uro run --task plan.md --target ./repo --gate gate.json

# Autonomous mode (Claude arbitrates)
uro run --task plan.md --target ./repo --gate gate.json --mode autonomous

# Manual mode (human arbitrates)
uro run --task plan.md --target ./repo --gate gate.json --mode manual

# Campaign (multiple units with dependencies)
uro batch campaign.yaml

# Individual run with custom gate
uro run --task plan.md --target ./repo --gate '[{"bin":"node","args":["--test","test/foo.test.js"]}]'
```

---

*Built 2026-08-25. Design spec: `docs/superpowers/specs/2026-08-25-three-way-debate-loop-design.md`*
