---
name: uroboros
description: Use when planning, running, supervising, diagnosing, or publishing isolated Uroboros work with Claude and Codex, including queues and campaigns.
---

# uroboros

## Governing law

This is skill law for the planner seat on every invocation, every wave, and every fix. It is
not per-run content: never restate it in `TASK.md`, and no plan can waive it. A plan that appears
to authorize skipping or combining a step is itself the defect.

1. **Plan** — Claude authors plans and decompositions. Codex reviews the current artifact.
   Claude answers or revises, then Codex responds to the actual previous arguments. Retain full
   delivered messages, evidence and dissent. Both seats receive the same explicit versioned
   shared-context snapshot, required evidence and selected attributed recall. Approval binds the
   current goal, plan, context and evidence configuration; a digest identifies bytes, not truth.
2. **Choose authority by mode** — All workflows default to `--mode manual`: the human settles
   unresolved disputes in both phases. With `--mode autonomous`, Codex makes final planning
   decisions and Claude makes final execution decisions. TTY presence does not change authority.
   A clean evidenced artifact still uses the phase reviewer's sign-off in manual mode; the human
   settles authenticated missing decisions and unresolved disputes, not every review.
   Planning `approved: true, converged: false` means approval with retained dissent, not consensus.
   Execution uses `converged: null` when review approved the current diff but mutual agreement
   was not explicitly recorded. Ordinary corrections are not dissent; explicit rebuttals and
   upheld objections are retained as dissent, and every delivered reply remains in the record.
3. **Build** — Codex implements in isolation. Claude does not implement.
4. **Collect evidence** — The harness records true exit codes and full command output. Every
   substantive factual claim identifies resolvable evidence. Delivery, inspection receipt,
   semantic assessment, issue disposition and approval are distinct records; none implies the next.
   Never infer PASS from stdout or a pipeline's final status. Preserve protected reviewer tests.
5. **Review and reconcile** — Claude reviews correctness, regressions, security, edge cases,
   tests, intent, scope and invariants. Codex corrects or rebuts findings; Claude explicitly
   resolves, withdraws or upholds each finding with reasons. Omission is not closure. New
   reviewer tests run through the harness and their output reaches both agents. Questions remain
   available during final review and reviewer depth is discretionary. A sufficient approval in the
   already-running response needs no separate redundant final-review call. `decide` settles named
   issues; only `approve` signs off the whole current artifact/context.
6. **Handle unfinished work** — Preserve human questions and technical pauses as different saved
   checkpoints. Autonomous decisions belong to the phase reviewer. Replanning in both modes keeps
   useful code, evidence and history while Claude authors and Codex reviews the replacement.
   Silence, quota/auth failures, stale evidence, unreadable replies, uncertain effects and exhausted
   bounds never approve, fabricate agreement or authorize blind replay.
7. **Land and publish** — Current approved work follows existing landing checks. Queue landings
   receive Claude's first-hand review and remain local commits. Publishing is a separate action.

Monitor continuously and intervene only when a run is stuck: **stalled** means no events beyond
the stall threshold; **circling** means events still arrive but the same files are rewritten with
no gate progress. Slow is not stuck.

There is no default dialogue-round, provider-call or elapsed-conversation ceiling. Candidate
breadth, proposal/correction cycles, challenge limits, campaign rounds, token budgets, gate retries
and operational timeouts are explicit separate controls; ordinary Q&A consumes none of those cycles.

For operator-facing detail, read [`docs/guides/coworker-dialogue.md`](../../docs/guides/coworker-dialogue.md).

## Coworker dialogue with superpowers

Claude is the hub of the debate protocol and uses these exact skills at its decision points:

- Before fix plans, pivots, or validation, run `superpowers:brainstorming`.
- When writing `FIX_PLAN.md`, pivot plans, or reframed approaches, run
  `superpowers:writing-plans`.
- To execute the debate protocol, run `superpowers:executing-plans`.
- To validate test designs, run `superpowers:test-driven-development`.
- To diagnose why the loop is stuck, run `superpowers:systematic-debugging`.
- To verify that convergence is genuine, run `superpowers:verification-before-completion`.
- When reading reviews to validate them, run `superpowers:receiving-code-review`.
- After fixes, run `superpowers:requesting-code-review` to request Claude re-review.

A plan written for this loop must run `superpowers:writing-plans`' spec-coverage self-review.
It must name the current design it implements and enumerate intentionally omitted sections.

## Planner briefing

### Campaign shapes

Choose on one axis: **how do these plans relate to each other?**

| Name | Chosen when | Command | Engine shape |
|---|---|---|---|
| **Single** | one plan | `run` | — |
| **Parallel** | plans are unrelated; keep all | `batch` | `task-set` |
| **Graph** | one plan consumes another's result | `batch --depends-on` | `task-set` with parents |
| **Candidates** | competing approaches to one goal | `batch --perspective` | `candidate-set` |
| **Rounds** | candidates are refined over 2–3 rounds | `+ --rounds` | `iterative-candidate-set` |

The engine emits exactly `task-set`, `candidate-set`, and `iterative-candidate-set`. Dependency
edges do not create another `campaignShape`: Parallel and Graph both emit `task-set`, with Graph
also carrying parents.

Recognize one derived kind that the planner never chooses: **Merge**. Any unit with more than
one parent is auto-promoted to Merge and gains its own worktree and `TASK.md`, a derived
test-count floor, a required interaction test, and a conflict ledger.

### Declaring a Graph

Prefer a declared campaign file for Graph work because it keeps the topology, unit identities,
and campaign limits together:

    node bin/loop.js batch --campaign <campaign.json> [--port PORT] [--open] [--no-dashboard] [--quiet]

The file declares `target`, `gate`, optional campaign settings, and a `units` array whose entries
name `id`, `task`, and optional `dependsOn`. Paths resolve from the campaign file's directory.
For a simple Graph, keep the flag form: give every task a `--unit-id`, then repeat
`--depends-on CHILD=PARENT` for each edge.

### Engine behavior that changes planning

- **A subdirectory target does not narrow scope.** For a target inside a Git repository,
  isolation resolves through Git to the enclosing repository and creates a full-checkout
  worktree. Executor cwd, gate cwd, and `CHANGES.diff` are therefore repository-root scoped.
  Express the intended blast radius in the plan prose.
- **A leaf unit is not committed by the campaign.** A unit result is committed only when the
  unit has at least one declared child and exits zero. A leaf branch remains at its base commit;
  its changed work stays in the worktree, and for a successful changed leaf `CHANGES.diff` is
  the authoritative artifact.
- **One failed parent skips a fan-in immediately.** The fan-in child is marked skipped as soon
  as any parent fails; the scheduler does not wait for the other parents, which continue running.
- **`no-op` is scheduler success, not proof of work.** An empty diff skips the review,
  exits zero, releases dependents, and counts as a successful alternative. Positive evidence of
  implementation is a non-empty diff together with its recorded command evidence.
- **Waiting costs no slot.** A waiting dependent does not hold a concurrency slot. The Graph
  topology, rather than `--concurrency`, is usually the real parallelism bound.
- **Only three commands are genuinely read-only:** `status`, `dashboard`, and `help`.
  `doctor --deep` launches the real Codex and Claude binaries and spends tokens; `publish`
  pushes a branch and creates or updates a pull request. `doctor` also performs disposable
  scratch writes even without `--deep`.
- **Claude reviews execution read-only.** It judges findings, corrections and rebuttals, pivots,
  and queue landings. Missing review leaves objections open and the run unfinished.
- **The loop STAGES the executor's edits.** A bare `git diff` in the run worktree is empty;
  read the work with `git diff --cached --binary`.
- **Goal acceptance closes a decomposed goal; nothing mechanical does.** `loop queue
  --accept-goal <spec.md>` runs only once every unit in the queue file shows landed;
  Claude then reads the goal spec and the aggregate landed diff first-hand and judges
  whether the project now delivers the goal's capability. A landed unit missing its
  recorded commit, or a queue log that cannot be read, refuses the judgement rather than
  approve a partial trail — silence is never consent here either.
- **Approval requires current evidence.** Planning approval records the artifact digest,
  decision-maker, basis and reason. Queue goal units must match current goal, plan and gate
  before implementation and landing. Agreement is reported separately.
- **Publishing is per unit, evidence-presence-gated, and parent-first for a Graph.** `publish`
  requires a review report in the run record, but does not require a clean report or a
  successful outcome. Runs with no report (no-op, executor/evidence timeouts, reviewer
  failures) lack a delivery path. A child pull request uses its parent's branch as its base,
  so publish the parent branch first.
- **The execution scratch root is environment-only and flat.** `run` and `batch` take it from
`URO_SCRATCH_ROOT` (or the platform default), not a run flag. Unit worktrees live under the
  unit id, so two campaigns that reuse a unit id collide even when they target different
  repositories.
- **Normal run records persist outside their worktrees.** Completed runs copy every produced
  harness artifact to `URO_ARTIFACT_ROOT` (default `<scratchRoot>/artifacts`) and append a compact
  `index.jsonl` entry. Unit worktrees still remain until the operator explicitly runs `prune`;
  nothing prunes automatically at the end of a run or campaign.
- **Agent seats have no elapsed deadline by default.** Executor and verifier elapsed limits
  exist only when the operator sets their timeout flags or environment variables. Silence past
  the first `URO_STALL_THRESHOLD_MS` interval asks a separate read-only liveness judge; a working
  judgement chooses the next interval, while a stuck or unavailable judgement kills the seat.
  The gate retains its default timeout because a quiet build may be healthy and cannot spend
  through a token budget. Isolation and campaign Git invocations pass no timeout. Standalone
  `doctor` probes and `publish` commands use their own bounded command timeouts.
  The arbiter uses `URO_ARBITER_TIMEOUT_MS`/`--arbiter-timeout` and otherwise inherits the
  verifier timeout.
  Under an enforced token budget, an in-flight writer with unknown usage denies a concurrent paid
  liveness judge; the harness does not invent a zero, estimate or reservation.
- **Ordinary seats share bounded phase/project context, not campaign topology.** Both receive the
  same versioned current context and selected recall. The Codex and Claude reviewer are not
  told about sibling units, the dependency Graph, or the campaign. A perspective value reaches
  no seat; its presence only infers a candidate set. Derived Merge is the exception: its
  generated `TASK.md` names ordered parents and merge requirements, but still does not describe
  the whole campaign.
- **Gate retry context is executor-only.** The failure detail is passed only through the next
  executor stdin; it is never written into `TASK.md`, so the intent verifier judges the pristine
  plan (or the generated Merge task), not retry instructions.

The repository lock around worktree administration is in-process only. That fact describes its
scope but proves nothing about cross-process safety. In the measured experiment, eight concurrent
`git worktree add` processes all succeeded and `git fsck` remained clean. `batch`
is preferred because it schedules, budgets, and records one campaign. The actual cross-process
hazard is reuse of a unit id in the flat scratch root.

## Invoking the commands

For a released version, install with `/plugin marketplace add ortimusirig/uroboros` followed by
`/plugin install uroboros@uroboros`. Registering an absolute clone path is development-only;
`node install.mjs` validates/prepares a checkout and does not mutate installed plugin state.
Local validation is not a live-provider, marketplace-update, publication or release claim.
The plugin registers these fifteen namespaced slash
commands while the direct Node CLI remains available:

- `/uroboros:run`
- `/uroboros:resume`
- `/uroboros:mutate`
- `/uroboros:plan`
- `/uroboros:decompose`
- `/uroboros:queue`
- `/uroboros:batch`
- `/uroboros:status`
- `/uroboros:dashboard`
- `/uroboros:publish`
- `/uroboros:prune`
- `/uroboros:doctor`
- `/uroboros:setup`
- `/uroboros:init`
- `/uroboros:help`

Each slash command is a controller prompt that runs the corresponding `node bin/loop.js`
command. It is not a shell alias. The command controller must use the child process's true exit
code, never stdout text or the exit status of a pipe. The `run` and `batch` prompts explicitly
load this skill so invoking them cannot bypass the governing law.

The direct CLI surface is:

    node bin/loop.js run ...
    node bin/loop.js resume --run <run-directory> --decision-file <answers.json>
    node bin/loop.js resume --run <run-directory> --continue
    node bin/loop.js mutate ...
    node bin/loop.js plan ...
    node bin/loop.js decompose ...
    node bin/loop.js queue ...
    node bin/loop.js batch ...
    node bin/loop.js status ...
    node bin/loop.js dashboard ...
    node bin/loop.js publish ...
    node bin/loop.js prune ...
    node bin/loop.js doctor ...
    node bin/loop.js setup ...
    node bin/loop.js init ...
    node bin/loop.js help

For one plan:

    node bin/loop.js run --task <plan-file-or-prose> --target <folder> --gate <gate.json> [--gate-retries M] [--mode manual|autonomous] [--claude-model MODEL] [--codex-model MODEL] [--codex-effort EFFORT] [--arbiter-timeout MS] [--artifact-root DIRECTORY] [--mutate] [--port PORT] [--open] [--no-dashboard] [--quiet]

To measure which added production statements no selected test depends on:

    node bin/loop.js mutate --target <folder> [--base REF] [--tests COMMAND] [--dry-run]

Mutation survivors are measurements for arbiter judgement, not a widened gate verdict. A dry
run lists semantic units and their selected tests without executing tests or agent seats.
On a native run, requested analysis occurs after successful required checks and before the next
discretionary Claude review. Identical completed analysis input can reuse its receipt; genuine
code/test/policy change can repeat optional spend. It does not require a separate final-review call.

To debate a goal into a mechanically checked plan and gate without modifying the target:

    node bin/loop.js plan --goal <prose-or-file> --target <folder> --out <folder> [--rounds N] [--mode manual|autonomous] [--claude-model MODEL] [--codex-model MODEL] [--codex-effort EFFORT] [--dry-run]

To debate one goal into the loop-ready task units it converges to, or a project into the goals
that make it up:

    node bin/loop.js decompose (--goal <spec.md> | --project <file-or-prose> --out <dir>) --target <folder> [--rounds N] [--map-budget CHARS] [--mode manual|autonomous] [--claude-model MODEL] [--codex-model MODEL] [--codex-effort EFFORT]

`--project` debates a project into the MVP-first goals that make it up, written under
`--out` as a `goals/goals.json` manifest plus one `spec.md` per goal; it emits no
`gate.json` of its own. Only `--goal` mode's task units carry a `gate.json`, and its
commands are recorded evidence only: the harness runs them once per round and no exit
code passes or fails the change.

For an ordered queue whose approved units should land in the current clean Git worktree:

    node bin/loop.js queue --file <queue.json> [--mode manual|autonomous] [--max-runs N] [--rounds N] [--token-budget TOKENS] [--dry-run]

Queue units inherit mode and provider options into both planning and execution. Current review
approval and existing landing checks are required. Pending manual work stops with its checkpoint;
the queue does not retry or skip it. The queue commits locally and never pushes.

For flag-declared Parallel, Candidates, Rounds, or a simple Graph:

    node bin/loop.js batch --task <plan-1> --task <plan-2> --target <folder> --gate <gate.json> [--mode manual|autonomous] [--claude-model MODEL] [--codex-model MODEL] [--codex-effort EFFORT] [--arbiter-timeout MS] [--concurrency N] [--token-budget TOKENS] [--rounds 1|2|3] [--round N ...] [--unit-kind candidate|node|merge] [--unit-id ID ...] [--perspective NAME ...] [--depends-on CHILD=PARENT ...] [--port PORT] [--open] [--no-dashboard] [--quiet]

Candidates share one base, reject dependencies, and retain each attributed result without
choosing a winner. Rounds use two or three caller-authored candidate sets, the same campaign
base, and one token budget. The engine does not call a planner model.

For a new project, `init` creates starter `plan.md` and `gate.json` files without overwriting
either. Use `doctor` for prerequisites and opt into real write/read probes with `doctor --deep`.
Before a long program, `loop doctor --deep` spends tokens on a real Codex write and Claude read
using the defaults: Claude `sonnet`, Codex `gpt-6-astra`, Codex effort `high`. Plain doctor checks
sign-in and installation but does not prove model execution. Cursor is not required.
Use `--claude-model`, `--codex-model`, and `--codex-effort` across all workflows. Retained aliases
are `--arbiter-model`, `--executor-model`, and `--executor-effort`; equal aliases are accepted,
conflicting values rejected. `--planner-model` and `--verifier-model` are obsolete and rejected.
Campaign JSON uses `mode`, `claudeModel`, `codexModel`, and `codexEffort`.

Use `status` or the read-only `dashboard` to observe a run, `publish` only after planner review,
`prune --dry-run` to inspect scratch retention, and `help` to print the command surface.

- **Gate config** (`gate.json`): a JSON array of `{ "bin": "...", "args": ["..."] }`;
  pass/fail is by the command's true exit code only.
- Codex writes inside a Git-isolated copy. `run` leaves the source working tree untouched;
  `queue` is the explicit exception that applies and commits fully approved diffs.
- Claude reviews the non-empty current diff in read-only plan permission mode, then responds
  explicitly to Codex corrections and rebuttals. Usage records real provider and role;
  historical Cursor reports retain their original provenance.
- Output is `uro-runfacts.json`, `uro-report.md`, `events.jsonl`, and, for changed work,
  `CHANGES.diff` in the isolated directory and the per-run durable artifact directory.
- Outcomes include `review-ready`, `no-op`, `gate-failed`, `verifier-failed`, `timed-out`, and
  Merge-only `conflicting-intent`; campaigns also roll up `campaign-failed` and
  `budget-exhausted`.

## Writing the task

Before invoking the loop, check the plan:

- **Does any instruction quietly narrow the product?** A hint can read as a restriction and
  silently remove behavior that should remain.
- **Can the test setup erase the signal?** If a fixture makes correct and incorrect
  implementations produce the same result, the assertion proves nothing. Pair every “X must be
  absent” assertion with a positive control proving the check could have seen X.
- **Does any test depend on where it runs?** The gate runs in a full isolated checkout at a
  scratch path. Avoid tests derived from `process.cwd()` or the checkout location.
- **Does the plan declare a dashboard title?** Add a `Title: <short summary>` line directly after
  the `# Task` heading. The dashboard displays it in place of an inferred title; when it is absent,
  the dashboard falls back to a less reliable heuristic.
- **Are invariants explicit?** State what must remain true, not only the implementation steps.
  The intent verifier reads `TASK.md`, so written invariants become checkable.
- **Is out of scope explicit?** State what must not change so the diff stays reviewable.

## Supervising a run

Immediately after starting `run` or `batch`, tell the human the printed dashboard URL and call it
a read-only view. Do not leave the URL only in captured stderr. `--open` opens it locally; use
`--no-dashboard` or `URO_NO_DASHBOARD=1` only when the operator does not want dashboard startup
or announcement.

Keep watching the event stream or dashboard. On roughly a 30-minute cadence, also read
`loop status <run-directory>`:

- Events arrive and files or gates advance: slow, not stuck. Leave it.
- No events, but still below the stall threshold: probably thinking. Leave it.
- No events beyond the threshold: stalled. Intervene.
- Events arrive while the same files are rewritten without gate progress: circling. Intervene.

This monitoring is planner behavior; the package does not schedule it or contact a human.

## Iterating

For a saved manual decision, use the direct CLI:

    node bin/loop.js resume --run <run-directory> --decision-file <answers.json>

For an eligible saved technical pause with no human question, use:

    node bin/loop.js resume --run <run-directory> --continue

The two routes are mutually exclusive. Technical continuation reconciles the validated current
checkpoint; it is not a human answer, approval, mode/limit override, new run, generic “continue
anyway,” or retry permission. Human-pending, stale/corrupt, exhausted/incomplete-accounting and
uncertain external/writer/Git effects remain refused or paused. A consumed receipt alone does not
promise exit zero.

Read `uro-checkpoint.json` in that run's isolated workspace (or its durable artifact directory).
For standalone planning or decomposition, the checkpoint is in the reported output directory.
Create the answer file in an external directory, outside both the target source tree and the
execution workspace, and pass its absolute path. For a Git target, keep it outside the whole
repository even if the selected target is a subfolder. A durable artifact directory is suitable
only when it is outside both trees. An answer file created inside a hashed tree changes that
tree's identity and is rejected with a placement diagnostic before model use. Move only the
new answer file outside and resolve remaining drift; preserve other files and never bypass
source identity validation with arbitrary exclusions.
Copy its current `runId`, top-level `artifactDigest`, and every `pending.questions[].id` into
the answer file. This decision digest also binds the exact pending questions and revision;
it is distinct from the plan/diff approval digest. The JSON shape is:

```json
{
  "schemaVersion": 1,
  "runId": "run-1",
  "artifactDigest": "copy-the-current-checkpoint-artifactDigest",
  "answers": [{ "id": "Q1", "answer": "Use the existing schema." }]
}
```

Supply one nonblank answer for each pending ID, with no duplicate or unknown IDs. Preserve the
human's exact answer. Planning accepts `approve`, `revise`, or `stop`, optionally followed by
`: explanation`. For an execution dispute, `Accept Codex rebuttal` (optionally `: explanation`)
settles only that named issue on unchanged code and evidence. `Require a correction`,
`Clarify requirements`, and other prose are correction context, not blanket approval. Both
agents receive the human ruling; actual execution review and unrelated issues still matter.

For a recorded execution-pivot question, copy an exact option: `correction`, `fresh plan`, or
`stop`, optionally followed by `: explanation`. `stop` is terminal without another model call
or landing. `correction` and other prose are targeted correction context. `fresh plan` means
a genuinely revised Claude-authored/Codex-reviewed plan over the saved workspace; it preserves
current code, diff, history and protected evidence, with no reset to the pre-debate base.
Implementation waits for current plan approval. If this planning debate raises another manual
question, read the new checkpoint and resume that saved proposal with the same command; do not
redraft candidates or repeat completed execution. The retained-work rule applies in autonomous
mode too, with Codex retaining final planning authority.

Resume continues the saved phase and existing workspace. The saved manual mode is immutable:
there is no resume `--mode` flag. Re-running the original task creates new work and is not resume.
An identical applied answer returns its recorded result without model calls, another landing,
or queue advancement. A stale digest/run ID or changed workspace, target, plan, gate or evidence
is rejected before model use: inspect the latest checkpoint and resolve its current questions;
do not reuse the old answer against a newly phrased question. An accepted but interrupted
decision with no completed phase is refused rather than replayed. Recorded completed queue
phases recover their verified commit/log transition without repeating implementation.

The recorded workspace must still exist and validate. A missing/corrupt workspace is an error;
preserve the checkpoint and investigate recovery of that same workspace. Durable artifacts do
not authorize creating a substitute workspace or restarting the task. An existing resume lock
requires checking the owning invocation; never clear a lock while a resume may still be active.
Pending workspaces are retained by ordinary pruning. Queued manual work resumes its saved unit
and cursor with the same queue file; do not trim or edit that file before resuming.

Each `loop run` retains Codex implementation, Claude review, evidence, full delivered messages,
mode, authority and dissent. Continue corrections in that conversation; preserve pending manual
checkpoints instead of starting a replacement run that discards the dispute.
