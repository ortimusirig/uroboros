# Give Claude a seat, and remove the round cap it was standing in for

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

Implements the **Claude actor** throughout
`docs/superpowers/specs/2026-08-25-three-way-debate-loop-design.md` — the
"Claude validates each finding" step of §Full Flow, the "Claude arbitrates and
reframes" property, and the **"No round cap"** property of §Key Properties.

**Explicitly NOT implemented here:** Cursor's scoped write and the `uro-review`
skill (separate plan, in flight), and the FRESH pivot re-branching from a
pre-debate snapshot.

## Context — the defect

The spec names three actors. Two are real processes; the third is not.

`codex` and `agent` are spawned as child processes with their own models.
**`claude` is never spawned**, although the binary is installed and supports the
same headless shape the other two use:

```
codex exec --json ...
agent  -p <prompt> --output-format stream-json --mode plan ...
claude -p <prompt> --output-format stream-json ...     ← never invoked
```

Everywhere the design says "Claude decides", deterministic code stands in:

- `validateFindings` in `fix-plan.js` is `description non-empty ? accept : reject`.
  **Every reviewer complaint carrying any text is obeyed.** The overrule path is
  rendered by `buildFixPlan` and is unreachable.
- `createAutonomousDecisionResolver` **adopts the executor's own
  `Recommendation:` verbatim.** The executor decides its own questions.

Both were verified by reading the code. A live probe confirmed the surrounding
machinery is sound — an injected reviewer filing one blocking finding produced
two debate rounds, `debate/resist` twice, and a fix plan reaching the executor
carrying `F1` and its test path. **The conversation works; the arbiter is a
stub.**

`DEFAULT_DEBATE_ROUNDS = 2` was introduced by the same omission. The spec says
**"No round cap. The loop runs until natural convergence."** A fixed cap was
substituted because nothing could judge when to stop.

## Required behavior

### 1. Claude as a spawned seat

Add `src/arbiter.js` invoking the Claude CLI as the other seats are invoked:

- `claude -p <prompt> --output-format stream-json`, plus a read-only permission
  mode. **The arbiter never writes to the worktree.** It reads and returns
  judgements.
- Bounded by a new `URO_ARBITER_TIMEOUT_MS`, validated by `parseTimeoutMs`,
  defaulting to the verifier timeout.
- Model selectable via `--arbiter-model`; usage recorded per seat in the facts
  exactly as executor and verifier usage is.
- Injectable, so no test spawns a real binary.
- Parsing mirrors `verifier.js`: read the stream, extract the verdict, and
  **distinguish "no readable answer" from a real answer.** An unreadable
  arbiter response is `UNVERIFIED`, never silently treated as agreement.

### 2. It validates findings, and may overrule

`validateFindings` becomes the arbiter's job rather than a string check.

For each blocking finding, the arbiter is given the finding, the diff and the
plan, and answers **valid** or **invalid with a reason**.

- Valid findings become fix-plan work as today.
- Invalid findings go to the existing `rejected` list, which `buildFixPlan`
  already renders as `F<n> rejected (overruled)` — **making the unreachable path
  reachable.**
- If **every** finding is overruled, the loop exits as converged. The spec's
  "if all findings invalid: overrule, EXIT LOOP".
- If the arbiter is unavailable or returns `UNVERIFIED`, **fall back to today's
  behaviour: accept the finding.** Losing the arbiter must never silently
  discard a reviewer's objection.

### 3. It answers challenges

`createAutonomousDecisionResolver` consults the arbiter instead of copying the
executor's recommendation.

- The arbiter is given the question, its options, the executor's recommendation,
  and the plan, and answers on the merits. It **may** adopt the recommendation —
  but as a judgement, not a default.
- `answeredBy: 'planner'` and the existing `decision/resolved` and
  `decision/assumed` events, bounds, and `escalation: 'operator-absent'`
  recording are unchanged.
- If the arbiter is unavailable, **halt with `needs-decision`** rather than
  falling back to adopting the executor's own answer. A missing judge means the
  operator decides.

### 4. Capability veto — each seat is authoritative about itself

Before implementation begins, each seat is asked, about **its own** part of the
plan: *"Does this plan require anything you cannot do? Answer only about
yourself."*

- A seat answering that it cannot do something **fails the plan**. This is not a
  finding: it does not go through validation, is not demoted for lacking a test,
  and **the arbiter cannot overrule it.** A seat is the sole authority on its own
  capabilities.
- The objection is recorded with the seat's stated reason, and the plan is
  redrafted.

This exists because both halves of a shipped change were refuted by the seats
that were never asked: the executor knew it had no `--plugin-dir` flag, and the
reviewer would have known a `.codex-plugin` directory is not loadable by it.

### 5. Remove the round cap

`DEFAULT_DEBATE_ROUNDS` and `MAX_DEBATE_ROUNDS` are removed. The loop runs until
**natural convergence**, per the spec.

The stop conditions become the ones the design intends:

- convergence — no blocking findings survive validation;
- circling — `detectCircling` fires and `shouldPivot` escalates
  `AMEND → FRESH → CONCLUDE`, with `CONCLUDE` ending the loop;
- the **token budget**, which becomes the real backstop and must be honoured
  before each round;
- `URO_DEBATE_ROUNDS` remains as an **optional operator override** — absent, the
  loop is uncapped.

Uncapping is only safe because the arbiter can now conclude. Removing the cap
without it would leave two seats disagreeing forever with nothing able to stop
them.

### 6. Events and documentation

Declare `arbiter/start`, `arbiter/finish`, `arbiter/overruled`, and
`capability/vetoed` in `EVENT_STAGES`, `EVENT_TYPES` and `EVENT_PAIRS` **in this
same change**. Undeclared pairs have been silently swallowed three times in this
repository.

Add `doctor` checks for the Claude CLI's presence and sign-in, matching the
existing Codex and Cursor checks. Update `skills/uroboros/SKILL.md` and the CLI
usage text.

## Invariants

- **The arbiter never writes to the worktree.** Read-only, always.
- **The gate remains the only thing that can pass a change.** The arbiter judges
  findings and questions; it cannot pass a failing gate.
- A capability veto is unoverrulable, including by the arbiter.
- An unavailable arbiter degrades safely: findings are accepted, challenges halt.
  It never silently discards an objection.
- Existing outcomes, exit codes and event semantics are unchanged.
- Zero external dependencies. ESM style matching the rest of the codebase.

## Test requirements

Use injected seams; no test may spawn a real binary.

1. The arbiter marking a finding invalid puts it in `rejected`, and
   `buildFixPlan` renders it as overruled.
2. **All** findings overruled exits the loop as converged, without re-invoking
   the executor.
3. A valid finding still drives a fix round — the existing behaviour, as a
   regression control.
4. An unavailable arbiter accepts findings (today's behaviour); assert the
   reviewer's objection is not lost.
5. The arbiter answers a `DECISION.md` question on the merits, and **may reject
   the executor's own recommendation** — assert a case where it answers
   differently.
6. An unavailable arbiter halts with `needs-decision` rather than adopting the
   executor's recommendation.
7. A capability veto from any seat fails the plan, is recorded with its reason,
   and **cannot be overruled by the arbiter**.
8. With no `URO_DEBATE_ROUNDS`, a debate that keeps producing findings runs past
   two rounds — **the uncapping regression control**.
9. Circling still fires and the pivot ladder still terminates the loop.
10. The token budget stops the loop when exceeded.
11. `URO_DEBATE_ROUNDS`, when set, still caps.
12. Every new `arbiter/*` and `capability/*` pair round-trips through
    `createEvent` without throwing.
13. An unreadable arbiter response is `UNVERIFIED`, never agreement.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Cursor's scoped write and the `uro-review` skill.
- The FRESH pivot re-branching from a pre-debate snapshot.
- Any change to how the gate or the verifier verdicts work.
