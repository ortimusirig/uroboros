# Non-convergence report — G2 (the non-convergence report)

> **Hand-authored.** This report describes a debate that ended before the engine
> could write reports of its own — G2 is the goal that builds the writer. It is
> written to the shape `spec.md` requires, and stands as the reference the
> implementation must match. Every quotation below is verbatim from the run
> record; nothing is paraphrased or inferred.

## Terminal

| | |
|---|---|
| Run | `decompose-2026-09-03T16-05-02-562Z-1062dd22` |
| Tier | goal (tier-2: goal → task units) |
| Reason | **`pivot-conclude`** |
| Converged | **no** |
| Rounds | 4 of 8 allowed |
| Storms | 2 (round 1, and round 4 after a fresh pivot) |
| Capability vetoes | none |
| Seat outages | none — all three seats answered every time they were asked |
| Task units written | **none.** Constitution rule 9, first sentence, held. |

## Unsettled objections

These are the findings live in the **closing round**. Nobody resolved them; the
conversation ended with them standing. This section is the report's spine.

### Codex — closing stance: **disagree** (stance readable)

| ID | Sev | Objection |
|---|---|---|
| S1 | P0 | T5 is not a self-contained runnable increment: making `writeNonConverged` mandatory while only updating conversation-test fixtures leaves the production callers in `src/decompose.js` and `src/plan.js` without the hook, so T5's full-suite gate will fail on existing non-converged tests. |
| S2 | P0 | T5 marks `recordWritten: true` solely because a hook returned a non-empty path; its own proposed in-memory placeholder proves a nonexistent report can be reported as written, violating "trust no completion signal" and "never silently absent." |
| S3 | P0 | T5's unrestricted spread of the hook result lets a mechanical writer overwrite canonical fields such as `converged`, `reason`, `plan`, or histories. |
| S4 | P0 | T11's protection requirements contradict the repository implementation: adding `NON_CONVERGENCE_REPORT.md` to `HARNESS_ARTIFACT_PATTERNS` causes `restoreWorktreeSnapshot` to filter it out of restoration at `src/worktree-snapshot.js:119-122`, while executor protection snapshots only `__uro_review`. |
| S5 | P1 | T7's independent outage test requires the complete launch-failure message, but T7 does not depend on T2, so its specified gate can run with the current 200-character truncation still active. |
| S6 | P1 | T3 places every historically recurring finding under `## Unsettled objections`, including its required example that disappeared before the closing round. Recurrence proves repetition, not that the finding remained unresolved. |

### Cursor — closing stance: **disagree** (stance readable)

| ID | Sev | Objection |
|---|---|---|
| S3 | P0 | T5's mandatory `writeNonConverged` plus gate `node --test` is still not a self-contained increment: `test/plan.test.js` (`storm-exhausted` ~276, `arbiter-unavailable` ~296, `rounds-exhausted` ~435) and `test/decompose.test.js` (silent proposer ~107) call production strategies that today supply only `writeConverged`. Landing T5 alone makes those non-converged terminals throw and fails constitution rule 6. |
| S10 | P1 | T5 must state that the existing unconditional `reportEvent(..., 'plan', 'finish', ...)` at `src/conversation.js:381-387` is branched — not left in place beside the new non-converged emit — so a successful non-converged terminal emits exactly one `plan/finish`. |
| S11 | P1 | Add `T2` to `dependsOn` for T7 (and symmetrically T8/T9), or make T3/T4 depend on T2: otherwise a legal parallel landing can ship production reports while `seatLaunchFailure` still `.slice(0, 200)` at `src/conversation.js:66`. |
| S12 | P1 | Align T9 test 4's asserted label `discarded-by-fresh-pivot` with T3's exact render wording (`discarded by a fresh pivot`) so the executor is not forced to invent a third string. |

**Cross-vendor confirmation.** Codex S1 and cursor S3 are the same objection,
found independently by two different vendors' models against the same plan: the
task that activates the mandatory hook breaks the suite because the production
call sites are wired by later tasks. That is corroboration, not seat noise — and
it is the objection that ended the debate.

## The recurring thread

The pivot judge concluded on the strength of this pattern. Recorded here with
the caveat the closing round itself raised (codex S6, below).

| Seat + ID | Rounds | Present at close |
|---|---|---|
| codex-S1 | 1, 2, 3, 4 | yes |
| codex-S2 | 1, 2, 3, 4 | yes |
| codex-S3 | 1, 2, 3, 4 | yes |
| codex-S4 | 1, 2, 3, 4 | yes |
| codex-S5 | 1, 2, 3, 4 | yes |
| codex-S6 | 1, 3, 4 | yes |
| codex-S7 | 1, 3 | no |
| cursor-S1 | 1, 3 | no |
| cursor-S2 | 1, 3 | no |
| cursor-S3 | 1, 4 | yes |

**A trap this table proves, for the implementation to avoid.** The IDs above
recur, but the *texts behind them do not*. `codex-S1` reads:

- round 1 — "T2's writer explicitly throws when the directory is absent"
- round 2 — "T1 loses the last successfully parsed plan when `PIVOT_FRESH` occurs"
- round 3 — "T3 is not independently landable"
- round 4 — "T5 is not a self-contained runnable increment"

Rounds 3 and 4 are genuinely the same objection, renumbered as the plan grew a
task. Rounds 1 and 2 are different objections that happened to land in the same
slot. **Seats renumber their findings every round**, so `seat + id` recurrence
is partly coincidence. A report that renders this table without saying so tells
the reader something untrue. Codex S6 (unsettled, above) makes the same point
from the other direction: recurrence proves repetition, not that a finding
remained unresolved.

## The judge's assessments, verbatim

### Round 3 — pivot: `fresh`

> codex-S1..S5 have recurred unresolved across all three rounds while cursor's
> findings have rotated and largely resolved (S6/S7 dropped, S8/S9 resolved after
> round 2), so continued amendment on the same footing has already been tried for
> three rounds without closing the core codex objections; a fresh pivot is
> warranted rather than a fourth amend cycle or concluding over live, unresolved
> substantive findings.

### Round 4 — pivot: `conclude` (the terminal decision)

> The plan resolves the recurring codex-S1..S5 thread substantively rather than
> restating it: it grafts a single-capability T11 (execution-visibility) justified
> by constitution rule 9's binding 'visible during execution' text, keeps T10 as
> the minimal independently-testable pointer beneath it, corrects a verified
> citation error in codex's own evidence (events.js:488-491 vs claimed 540-543),
> and the resulting 11-task decomposition has consistent dependencies, gates,
> tests, invariants, out-of-scope boundaries, and a documented Assumptions section
> covering the T10/T11 split rationale. This is the concrete output of the round-4
> fresh pivot already chosen in ATTEMPTED; a further amend cycle would relitigate
> a now-addressed objection rather than surface new substance.

### Round 4 — closing agreement judgement

> Both seats stated AGREE: no, which alone blocks convergence. On the merits their
> core objection is also sound: T5 makes writeNonConverged mandatory and gates on
> the full suite ('node --test'), but no task before T7/T8/T9 supplies that hook to
> runDecomposeGoal/runDecomposeProject/runPlan — landing T5 alone breaks existing
> non-converged tests in test/decompose.test.js and test/plan.test.js, violating
> the tier-2 law that every task is a runnable, self-contained increment. Both
> seats found this independently (codex S1, cursor S3), which is strong
> corroboration rather than seat noise.

**Note the tension, preserved deliberately.** The pivot judge called the plan
substantively resolved; the agreement judge, on the same round, called its core
objection sound and unresolved. Both are correct, and they answer different
questions — the pivot judge asks whether *continuing the conversation* will
produce new substance, the agreement judge asks whether *the seats agreed*. This
report exists because the second answer is the one that governs, and the first
one would otherwise be lost.

## What the plan was

**Not recoverable from the run record.** `finish()` in `src/conversation.js:362`
returns `storm`, `roundHistory`, `pivotHistory`, `capabilityVetoes`,
`seatOutages`, and `tokens` — but not the proposal. The plan text reaches the
pivot judge as an arbiter-request field and is never retained.

From the findings that cite it, the discarded plan was an **11-task
decomposition** (T1–T11) with dependencies, per-task gates, an Assumptions
section, and a T10/T11 split separating a minimal provenance pointer from an
execution-visibility capability. Its content is otherwise gone.

**This contradicts `spec.md`'s claim** that "nothing new needs to be measured;
what is missing is a writer." The seats caught the error during the debate —
round 2 codex-S1 warned that a fresh pivot at the final round would leave the
plan null, and round 3 cursor-S2 noted the proposed T1 exists precisely to expose
`plan` on `finish()`. The spec was wrong; the debate corrected it. **The
implementation must retain the plan before any report can satisfy requirement 2.**

## Bounds this report declares

Per constitution rule 3, self-declared:

- Finding text is rendered **complete** — no truncation. The longest rendered
  finding is codex S4 at 431 characters.
- The recurrence table covers **all 10** seat+id pairs that appeared in more than
  one round. Findings appearing in exactly one round are not listed; there were
  16 such.
- Round 1's questions (1 from each seat) and round 2's are **not rendered** —
  they were answered by the next round's proposal and are absent from the closing
  round. This is an omission, and it is declared here rather than hidden.
- The final plan is **absent**, for the engine reason given above, not by choice.

## For whoever executes this goal

Constitution rule 9 requires this report to travel with the work. When task
units for G2 are authored by hand, each one carries a pointer here. Four
objections above are P0 and unresolved — **codex S1/S2/S3/S4 and cursor S3** —
and they are about the shape of the task decomposition itself, not about the
feature. Any hand-authored unit that reintroduces "mandatory hook before wired
call sites" has walked into the objection two vendors independently raised and
nobody answered.

Two findings bear on this report's own design and should be treated as
requirements when the writer is built: **codex S6** (distinguish closing
objections from historical recurrence) and the ID-reuse trap documented in *The
recurring thread* above.

## Provenance

- Run record: `decompose-2026-09-03T16-05-02-562Z-1062dd22`, 2026-09-03T16:05:02Z → 17:30:57Z
- Goal spec: `uro-project/goals/G2-non-convergence-report/spec.md`
- Governing law: `uro-project/constitution.md` rule 9
- Tokens: 26,283,429 input (24,260,728 cached) / 445,651 output / 88,970 reasoning
