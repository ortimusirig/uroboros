# Plan queue — worked by the planner (Claude), not by hand

State lives here so the queue survives a context break. Update the status column
when a run lands.

| # | Plan | Gate | Status |
|---|---|---|---|
| 1 | `campaign/plan-a/plan-events-vocabulary.md` | `gate-events-vocabulary.json` | ✅ shipped `f728c9f` |
| 2 | `campaign/plan-a/plan-verifier-unverified.md` | `gate-verifier-unverified.json` | ✅ shipped `80520e5` |
| 3 | `campaign/plan-a/plan-env-and-timeout-flags.md` | `gate-env-and-timeout-flags.json` | ✅ shipped `c4dca95` |
| 4 | `campaign/plan-a/plan-executor-preamble.md` | `gate-executor-preamble.json` | ✅ shipped `3782df5` |
| 5 | `campaign/plan-a/plan-evidence-based-deadline.md` | `gate-evidence-based-deadline.json` | ✅ shipped `17137d1` |
| 6 |  `campaign/debate/plan-debate.md` | `gate-debate.json` | ✅ shipped (see below for the first attempt) |
| 7 | `campaign/debate/plan-review.md` | `gate-review.json` | ✅ shipped |
| 8 | `campaign/debate/plan-fix-plan.md` | `gate-fix-plan.json` | ✅ shipped |
| 9 | arbitration + `run.js` debate integration (§8) | `gate-arbitration.json` | ✅ shipped |
| 10 | durable artifacts (§2) | `gate-durable-artifacts.json` | ✅ shipped |
| 11 | liveness as conversation + 2 repair rounds | `gate-liveness-*.json` | ✅ shipped |
| 12 | `loop mutate` + 2 repair rounds | `gate-mutation-gate.json` | ✅ shipped `13f5ebb` |

### Current queue — `campaign/queue-from-unit2.json`

| # | Plan | Gate | Status |
|---|---|---|---|
| 1 | `plan-a/plan-superpowers-all-seats.md` | `gate-superpowers-all-seats.json` | 🔄 running |
| 2 | `plan-a/plan-cursor-scoped-write.md` | `gate-cursor-scoped-write.json` | ⏳ queued |
| 3 | `plan-a/plan-claude-seat.md` | `gate-claude-seat.json` | ⏳ queued |
| 4 | `plan-a/plan-fresh-storm-pivot.md` | `gate-fresh-storm-pivot.json` | ⏳ queued |
| 5 | `plan-a/plan-board-filters.md` | `gate-board-filters.json` | ⏳ queued |

**Install-time work already done for unit 1** (a run never installs):
`codex plugin add superpowers@openai-curated` → installed, enabled.
`agent plugin marketplace add https://github.com/obra/superpowers-marketplace.git`
→ added, but Cursor has no non-interactive install, so its route is
`--plugin-dir` at a directory carrying `.cursor-plugin`. See the measured
section at the end of `plan-superpowers-all-seats.md`.

## Loop the planner runs

```
take next queued plan
  → launch as a TRACKED background run (so completion wakes the planner)
  → on wake, read uro-runfacts.json:
      review-ready    → verify tests on main, apply diff, commit, mark shipped, take next
      needs-decision  → STOP. surface the questions. authority-kind is the operator's.
      gate-failed     → STOP. surface the failing command and its output tail.
      no-op           → STOP. check noOpReason; an approval request means the plan needs work.
      timed-out       → STOP. report the gap and the last observed action.
```

**Launch tracked, never detached.** A `nohup … &` inside a shell call returns
immediately, so the harness does not track the run and the planner is never woken
when it finishes. That is what left this queue idle for ~13 hours between runs 5
and 6 while the work itself was complete. Runs must be started as background
tasks the harness owns.

## Open blocker — run 6

First attempt returned `needs-decision`. Codex wrote a well-formed `DECISION.md`:

> **Q1** · Kind: authority
> May the workspace permissions be repaired or the harness rerun so the current
> process can create `src/debate.js`?

**The premise is false.** The worktree `src/` directory is writable — verified by
touching a probe file in it after the run ended. Codex misread a transient write
failure as an ACL problem.

Answer: nothing needs repairing; retry. Since `authority` questions halt by
design and no `decisionResolver` is wired (§8), the retry is a fresh run.

Worth recording that the machinery worked even though the question was wrong:
Codex used the `DECISION.md` protocol for the first time — it only knew the
protocol exists because §3 shipped hours earlier — and the
`decision/challenged` event reached `events.jsonl`, which §4 made possible.
Before today that event was silently discarded.
