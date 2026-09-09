# Usage

See [Coworker dialogue](coworker-dialogue.md) for shared context, evidence and inspection
semantics, reviewer/human authority, retained-work replanning, and safe recovery.

[Bundled workflow profiles](workflow-profiles.md) explains the BMAD and Spec Kit adaptations
delivered by native planning, direct execution, queue/campaign children and goal acceptance.
There is no workflow-selection flag or toolkit install. Saved resume retains its captured
version; historical work stays unbound. Added guidance costs prompt tokens in existing calls,
without adding mandatory review rounds. A supplied `run --task` keeps its direct execution path.

## Updating an existing installation

For an existing installation, run these in a terminal:

```sh
claude plugin marketplace update uroboros
claude plugin update uroboros@uroboros
```

Then restart Claude Code (or run `/reload-plugins` in the active session). For a
non-user installation, pass the matching `--scope` to the plugin update command.
Explicit plugin versions control update detection; changed commits with an unchanged
version can be skipped. See [Claude Code version management](https://code.claude.com/docs/en/plugins-reference#version-management).
These are documented update instructions, not a claim that a live update was tested.


## Sequential queues

`loop queue --file <path>` reads a JSON list whose units contain either
`{ task, gate, name? }` or `{ goal, out, name? }`, and runs them one at a time against the
current working directory. Paths in the list are resolved relative to the queue file. A goal
unit runs `loop plan` first and starts implementation only after approval bound to the current goal, plan bytes, and parsed gate.
This `goal` unit kind still works but is legacy: prefer `loop decompose --goal` to convert
a goal spec into task units directly, then queue those. On large repositories, use `loop decompose --goal` instead of goal units: the measured record on a ~1,700-file tree is 0-for-7 for goal-sized runs and 5-for-6 landed for decomposed task units.
Run `loop queue --file queue.json --dry-run` before an unattended session to validate every
input and goal output path without launching an agent.

Manual disputes save a durable checkpoint. Use [manual resume](#manual-resume) to continue
the existing phase and workspace. Re-running a stopped task creates a new run.

The default mode is `manual`. `--mode autonomous` is passed to both planning and execution. A unit lands only after actual Claude review and a current execution approval (including a scoped manual human ruling)
(outcome `review-ready`) AND Claude, reading the final diff first-hand at landing time,
records its approval. Any other outcome, a refusal, or an unreachable final review stops
the queue with the judgement in `queue-log.jsonl`; nothing is retried or skipped.

Use `--max-runs <n>` to bound the number of attempted units and `--token-budget <n>`
to bound observed input-plus-output tokens. After the first unit, the runner forecasts
the next unit from the observed average cost and stops before that forecast would cross
the budget. A run already in flight always finishes and an approved result is landed
before the budget stop takes effect.

**Recalibrate `--token-budget` after the metering fix (`c09a558`).** Earlier meters
under-counted seat spend badly; every seat now reports honestly, and a real unit costs
millions of tokens, not thousands (5–12M per unit observed on a large repository). A
budget calibrated in the broken-meter era will trip after the first unit.

The target must be a clean Git worktree before execution. Approved diffs are checked
with a non-mutating Git apply first, applied and committed only for their touched paths,
and never pushed. `queue-log.jsonl` beside the queue file receives one JSON line per
attempted unit. The final summary reports landed units, the stop reason, total tokens,
and—above the totals—the recorded decisions and authority. When the
log is inside the target worktree, its exact untracked path is exempted from the clean-tree
check so a later unit or invocation does not self-block; tracked changes to that path are
still treated as dirty. Queued-goal resume also permits exact generated plan, gate and checkpoint
paths backed by validated saved provenance, including earlier approved goals. Unrelated files
and source changes remain rejected. Keep the queue definition tracked or outside the target worktree.

Pass `--accept-goal <spec.md>` to close a decomposed goal once every unit named in the
queue file shows landed in the log. Claude then reads the goal spec, the constitution
when present, the aggregate diff of everything the goal landed, and the log itself, and
judges whether the project now delivers that goal's capability. A refusal or an
unreachable judgement stops the queue with kind `goal-acceptance`; landed commits are
never rolled back. Landed rows in `queue-log.jsonl` now carry the commit SHA each unit
landed as, and the acceptance judgement's own usage is metered into the queue's totals
and its own log row. `--accept-goal` resolves relative to the current working directory,
unlike the queue file's own `task`/`gate`/`goal`/`out` paths, which resolve relative to
the queue file.

A queue stopped by a manual decision resumes through `loop resume` with the original queue
file and its saved cursor. For a separate new queue invocation after a limit stop, trim the queue file
down to the units that have not yet landed, then re-invoke `loop queue --accept-goal`.
`queue-log.jsonl` already carries the landed rows and their commit SHAs, and the
acceptance base spans every invocation, so a trimmed queue file never narrows what
Claude reviews at the end. After a REFUSED acceptance specifically, append fix
task-units to that same queue file (same log) and re-run. Re-running an untrimmed queue
file re-executes units that already landed against a worktree where their diff is
already applied, and typically fails with "applied diff touched no paths".

## Manual resume

```sh
node bin/loop.js resume --run <run-directory> --decision-file <answers.json>
```

Use the execution workspace or its durable artifact directory; standalone planning and
decomposition use their reported output directory. Read `uro-checkpoint.json` and copy
its current top-level `runId`, `artifactDigest` and all `pending.questions[].id` values:

Create the answer file **outside both the target source tree and execution workspace**.
For a target inside a Git repository, this means outside the entire repository, not merely
outside the selected subfolder. Use an external directory and pass its absolute path to
`--decision-file`. A durable artifact directory is suitable only if it is outside both trees.
Creating `answers.json` in either hashed tree changes its identity; resume reports a placement
error before model use. Move only that newly created answer file outside, preserve other
artifacts, and resolve any remaining drift instead of exempting source files from validation.

```json
{"schemaVersion":1,"runId":"run-1","artifactDigest":"copy-current-checkpoint-digest","answers":[{"id":"Q1","answer":"Use the existing schema."}]}
```

Every pending ID needs exactly one nonblank answer. Unknown, duplicate, missing and stale
answers are rejected before model use. The decision digest covers the questions and revision;
the approval digest separately identifies the reviewed artifact. Planning dispositions are
`approve`, `revise`, and `stop`; append `: explanation` when needed. For an execution dispute,
`Accept Codex rebuttal` settles that named issue on unchanged code/evidence. Other text is
delivered as correction context and does not automatically approve anything. Human rulings
reach both agents; a human approval retains actual Claude review evidence and unrelated issues.

A saved execution-pivot question records the exact options `correction`, `fresh plan`, and
`stop` (optionally append `: explanation`). `stop` is terminal without another model call or
landing. `correction` and other prose remain targeted work in the saved workspace. `fresh plan`
asks Claude to author a genuinely revised plan and Codex to review it over the **existing code**;
it does not reset to the pre-debate base or discard code/history/protected evidence. Implementation
continues only after current plan approval. If planning raises another manual question, answer
the new checkpoint using the same resume command; the saved proposal resumes without redrafting
candidates or replaying execution. The same retained-work replanning rule applies in autonomous mode.

The saved manual mode cannot be changed. Completed answer replay returns its recorded result
without another implementation, commit or queue advance. A completed queue phase can recover
its verified commit/log transition. An interrupted accepted decision with no completed result
is refused rather than guessed or re-executed. An existing resume lock requires inspecting
the owning invocation before recovery; never clear one while that invocation may still run.
Changed target/code/evidence or missing/corrupt workspaces fail actionably. Preserve the saved
objects and inspect the problem; the file archive is not permission to create a replacement
workspace. Pending workspaces survive ordinary pruning. Keep queued work's queue file unchanged.

### Technical continuation

For an eligible saved technical pause with no human question:

```sh
node bin/loop.js resume --run <run-directory> --continue
```

`--continue` and `--decision-file` are mutually exclusive. The technical route validates the
saved schema, pause, current workspace, identities, journal and resource allowance. It keeps the
saved mode and limits and is not a human answer, approval, generic override or permission to
retry an uncertain external/writer effect. Human-pending, stale/corrupt and exhausted/incomplete
accounting states remain refused or paused. A consumed receipt does not itself promise exit 0.

The dashboard is read-only: use its saved run path with the command above. Resumed reports,
review/evidence directories and checkpoints refresh in the durable run directory; the initial
artifact index entry is retained once and checkpoint history records decision transitions.

```
node bin/loop.js resume --run <run-directory> --decision-file <answers.json>
node bin/loop.js resume --run <run-directory> --continue
node bin/loop.js run --task <plan-file-or-prose> --target <folder> --gate <gate.json> [--gate-retries M] [--pivot-candidates N] [--mode manual|autonomous] [--claude-model MODEL] [--codex-model MODEL] [--codex-effort EFFORT] [--arbiter-timeout MS] [--artifact-root DIRECTORY] [--mutate] [--port PORT] [--open] [--no-dashboard] [--quiet]
node bin/loop.js mutate --target <folder> [--base REF] [--tests COMMAND] [--dry-run]
node bin/loop.js plan --goal <prose-or-file> --target <folder> --out <folder> [--rounds N] [--candidates N] [--pivot-candidates N] [--mode manual|autonomous] [--claude-model MODEL] [--codex-model MODEL] [--codex-effort EFFORT] [--dry-run]
node bin/loop.js decompose (--goal <spec.md> | --project <file-or-prose> --out <dir>) --target <folder> [--rounds N] [--map-budget CHARS] [--mode manual|autonomous] [--claude-model MODEL] [--codex-model MODEL] [--codex-effort EFFORT]
node bin/loop.js queue --file <queue.json> [--accept-goal <spec.md>] [--mode <manual|autonomous>] [--max-runs N] [--rounds N] [--token-budget TOKENS] [--dry-run]
node bin/loop.js batch --task <plan-1> --task <plan-2> --target <folder> --gate <gate.json> [--gate-retries M] [--pivot-candidates N] [--mode manual|autonomous] [--claude-model MODEL] [--codex-model MODEL] [--codex-effort EFFORT] [--arbiter-timeout MS] [--artifact-root DIRECTORY] [--concurrency N] [--token-budget TOKENS] [--rounds N] [--round N ...] [--unit-kind KIND] [--unit-id ID ...] [--perspective NAME ...] [--depends-on CHILD=PARENT ...] [--port PORT] [--open] [--no-dashboard] [--quiet]
node bin/loop.js batch --campaign <campaign.json> [--arbiter-timeout MS] [--artifact-root DIRECTORY] [--port PORT] [--open] [--no-dashboard] [--quiet]
node bin/loop.js status <run-or-campaign-directory>
node bin/loop.js dashboard [<run-directory>] [--scratch-root <directory>] [--port <port>]
node bin/loop.js publish <completed-run-directory>
node bin/loop.js prune [--keep N] [--older-than DAYS] [--dry-run] [--scratch-root DIRECTORY] [--artifact-root DIRECTORY]
node bin/loop.js doctor [--deep] [--scratch-root <directory>] [--repository <directory>]
node bin/loop.js doctor --fix [--scratch-root <directory>] [--repository <directory>]
node bin/loop.js setup [--scratch-root <directory>]
node bin/loop.js init <directory>
node bin/loop.js help
```

The corresponding plugin commands are `/uroboros:run`, `/uroboros:resume`, `/uroboros:mutate`, `/uroboros:plan`,
`/uroboros:decompose`, `/uroboros:queue`, `/uroboros:batch`, `/uroboros:status`,
`/uroboros:dashboard`, `/uroboros:publish`, `/uroboros:prune`, `/uroboros:doctor`,
`/uroboros:setup`, `/uroboros:init`, and `/uroboros:help`. Normal installation uses
`/plugin marketplace add ortimusirig/uroboros` and `/plugin install uroboros@uroboros`.
Registering an absolute clone path is local-development setup only; `node install.mjs` validates
and prepares a checkout, but does not mutate installed plugin state.

`loop plan` uses Claude as author and Codex as independent read-only reviewer. Both receive the
same explicit shared-context snapshot with required evidence and selected attributed recall.
Agreement and approval are separate: manual
mode preserves unresolved disagreement for human authority; autonomous mode lets Codex
approve the exact current artifacts with recorded rationale while dissent remains visible.
Queues verify that approval still matches the current goal, exact plan bytes, and parsed gate
before execution and landing. `approved: true` can coexist with `converged: false`.

Initial planning defaults to one candidate. Explicit alternative exploration selects among the
plans that drafted successfully; no mechanical gate judges a plan, the seats do. A fresh/replan
uses retained code, evidence and history and currently defaults to three candidates; configure
that count with `--pivot-candidates` (1–5).

`loop decompose` runs the same two-agent planning conversation one level up or down the decomposition
spine. `--goal <spec.md> --target <folder>` debates one goal spec directly into the
loop-ready task units (`plan.md`/`gate.json` pairs plus a `queue.json`) it converges to,
written beside the goal spec under a `tasks/` directory — this mode is live. Only this
mode's task units carry a `gate.json`; its commands are recorded evidence only, exactly
like `loop plan`'s: the harness runs them once per round and no exit code passes or fails
the change. `--project <file-or-prose> --out <dir> --target <folder>` debates a project
directly into the MVP-first, dependency-ordered goals that make it up, written under
`--out` as a `goals/goals.json` manifest plus one `spec.md` per goal — this mode is live
too, and emits no `gate.json` of its own; decompose each resulting goal with `--goal` to
reach its task units. In both modes, `--map-budget` bounds the characters spent on the
repo map handed to the seats (default 12000); values below the builder-derived
`MINIMUM_MAP_BUDGET` floor (currently 951 characters) are rejected with guidance to raise it.

Before a long program, run `loop doctor --deep`. Plain `doctor` checks local sign-in
without model calls. `--deep` spends tokens on an isolated Codex write probe and a Claude
read probe using the default models. No Cursor installation or account is required.

A fresh `--out` written inside `--target` leaves its plan/gate/queue files untracked, so
commit them (or keep `--out` outside the target) before `loop queue`, which requires a
clean tree.

`--help` and `-h` remain aliases for `help`.

`loop mutate` first runs the tests that statically touch changed production modules. It then
deletes added statements in semantic units inside temporary worktrees, subdivides every killed
multi-statement unit, and reports survivors for arbiter judgement. `--tests` replaces the test
launcher; use `{tests}` when that launcher should receive the statically selected paths.
`--dry-run` executes neither tests nor judging seats. Mutation survivors are evidence like any
other command output.
Add `--mutate` to request native advisory analysis after successful required checks and before
the next discretionary Claude review. Exact unchanged analysis input reuses its completed receipt;
a genuine code/test/policy change can repeat the optional spend. Disposable trial source is not
current live code. The evidence does not mechanically decide the run or require another final call.

`init` never overwrites `plan.md` or `gate.json`. It detects a `package.json` test script;
otherwise it emits a valid, runnable placeholder command list with an explicit comment telling
you to replace it. `doctor` runs Node, Git, PATH, local Codex/Claude sign-in, scratch-safety,
scratch-writability, Codex registry and Claude `.claude-plugin` checks
by default without spending agent tokens. Both superpowers checks are required. The Codex
write and Claude read probes spend real agent tokens, so they are marked `SKIP` until `--deep` is supplied.
Every probe uses and cleans its own disposable scratch directory; neither the target nor a run
directory is modified.

| Option | Required | Default | Range |
|---|---|---|---|
| `--task` | yes | — | plan file path or inline prose |
| `--target` | yes | — | folder to work on, git repo or not |
| `--gate` | yes | — | path to gate config |
| `--gate-retries` | no | 2 | 0–3 |
| `--pivot-candidates` | no | 3 | 1–5 fresh-plan candidates |
| `--corrects` | no | none | records that this run's plan corrects the named prior run; display only |
| `--mode` | no | `manual` | `manual` or `autonomous`; all run, plan, decompose, queue, and batch paths |
| `--claude-model` | no | `sonnet` | Claude author in planning; reviewer in execution |
| `--codex-model` | no | `gpt-6-astra` | Codex reviewer in planning; writer in execution |
| `--codex-effort` | no | `high` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` |
| `--arbiter-timeout` | no | verifier timeout | per-judgement Claude elapsed timeout in milliseconds |
| `--artifact-root` | no | `<scratchRoot>/artifacts` | durable per-run records and `index.jsonl` |
| `--quiet` | no | false | suppress stderr event summaries; `events.jsonl` is still written |

Legacy `--executor-model`, `--executor-effort`, and `--arbiter-model` remain aliases for
`--codex-model`, `--codex-effort`, and `--claude-model`. Equal duplicate values are accepted;
conflicting values are rejected. `--planner-model` and `--verifier-model` are rejected with
migration guidance, including their camelCase campaign-file fields. Campaign files use
`mode`, `claudeModel`, `codexModel`, and `codexEffort`. Decomposition's goal/project
selector is separate from its `interactionMode`.

`batch` accepts one or more repeated `--task` options. The target, gate, retry, and model
options have exactly the same meaning they do for `run`; every task gets its own isolated
worktree, evidence commands, Claude execution review, run facts, and `events.jsonl`. The reviewer
may ask, inspect or rebut until current approval, a decision/pause, or an explicit limit; there is
neither a one-call ceiling nor a mandatory separate final call.

`prune` is the only scratch-retention command. It keeps the 20 most recent completed run
directories by default. `--keep N` changes that count; `--older-than DAYS` adds an age rule,
and a run is removed only when both rules permit it. `--dry-run` lists candidates without
deleting them. The configured artifact root is always excluded, so durable records outlive
their disposable worktrees.

| Batch option | Default | Range / meaning |
|---|---:|---|
| `--concurrency` | 2 | 1–16 simultaneously in-flight units |
| `--token-budget` | 12,500,000 | positive campaign-wide token count |
| `--rounds` | 1 | maximum candidate-refinement rounds, from 1–3 |
| `--round` | 1 | round for each `--task`; when used, give once per `--task` |
| `--unit-kind` | `candidate` | `candidate`, `node`, or `merge`; give once for every task or once per `--task` |
| `--unit-id` | generated | stable unit ID; when used, give once per `--task` |
| `--perspective` | none | declares Candidates; give one distinct label per `--task` |
| `--depends-on` | none | `CHILD=PARENT`; repeat for edges and repeat the same child for fan-in |
| `--campaign` | none | JSON declaration for a Graph or another campaign; mutually exclusive with campaign-shaping flags |

The budget counts input plus output tokens. Cached input and reasoning output are already
subsets of those values and are not counted twice. Dispatch stops after completed run facts
push the campaign over budget; units already in flight are allowed to finish.

Candidates is a homogeneous candidate batch. Declare it with one `--perspective` per task (or by
explicitly passing `unitKind: 'candidate'` through the programmatic API). Every candidate must
have a distinct, non-empty perspective, all candidates use the same base, and dependency edges
are rejected before execution. A bare batch without perspectives retains the original
independent-task behavior for compatibility.

Rounds is opt-in with `--rounds 2` or `--rounds 3`. Attribute predeclared CLI
plans with one `--round` per task; perspectives must be distinct within a round, but may recur
in a later round. The programmatic `runCampaign` API can instead accept `maxRounds` plus a
`nextRound` callback, which receives the completed round and its attributed reviews before it
returns the next caller-authored task set. Returning no next round, or returning true from
`shouldStop`, records `caller-requested`. The tool never generates candidates itself.

Every round isolates its alternatives from the same campaign base. A later round learns from
earlier findings but does not inherit an earlier candidate's branch. The token budget covers
the whole campaign: reaching it prevents another round and further dispatch, while units
already in flight finish. Iteration stops with `budget-exhausted`, `max-rounds-reached`, or
`caller-requested`; the aggregate retains every completed round either way.

The [committed campaign design spec](../superpowers/specs/2026-08-15-v3-orchestrated-campaigns-design.md) uses historical labels: Mode A maps to Candidates/Rounds, and Mode B maps to Graph.

For a Graph, prefer `batch --campaign <campaign.json>` so topology and unit identities are one
declaration. The JSON object contains `target`, `gate`, optional campaign settings, and `units`;
each unit declares `id`, a task-file path in `task`, and optional `dependsOn`. Relative paths are
resolved from the campaign file's directory. Set optional `pivotCandidates` from 1–5 to control
FRESH re-planning for every unit. For a small Graph, the equivalent flag form remains
available: give each task a `--unit-id` and repeat `--depends-on CHILD=PARENT` for every edge.

Dependencies are a declared DAG topology: roots fan out up to the concurrency limit, while a
dependent waits without occupying a slot. After a successful predecessor finishes, its staged
result is committed on that unit's result branch and the dependent isolates from that branch.
`no-op` is also successful and releases dependents; its result branch simply still names its
base commit. A failed, `timed-out`, or `verifier-failed` predecessor does not release
broken work: its dependents are marked `skipped`, and that skip cascades transitively. Unrelated
roots continue normally. Unknown parents, self-dependencies, duplicate edges, and cycles are
rejected before any executor launches.

Giving one child several parents makes it a merge unit. Parent order is canonicalized by graph
declaration order; the merge starts from the first parent's result branch and brings every other
parent into the merge unit's own worktree. A clean merge continues through the normal executor,
evidence commands, diff, and the review pass. A text conflict is handed to the executor with every
conflicting path named in `TASK.md`; each resolution and its reason must be recorded in
`uro-merge-resolutions.json`, then reaches both run facts and the report. Genuine intent conflicts stop
as `conflicting-intent` for human direction. Merge gates add a derived test-count floor of the sum
of parent counts minus their shared baseline counts, and the merge intent requires a new
interaction/seam test. Counts come from recognized test-runner summaries emitted by the gate;
when a gate emits no count, the deterministic fallback counts tracked test files in each Git tree.

The repository lock around worktree administration is in-process only; that scope proves nothing
about cross-process safety. In the measured experiment, eight concurrent `git worktree add`
processes all succeeded and `git fsck` stayed clean. Prefer `batch` because it
schedules, budgets, and records one campaign. The real cross-process hazard is reusing a unit id:
the execution scratch root is flat, so unit ids collide even across different repositories.

`gate.json` is a JSON array of commands the harness runs once per round as evidence. Full
stdout/stderr per command land in `__uro_evidence/` inside the worktree, exit codes are
recorded in `facts.evidence`, and **no exit code passes or fails the change** — the seats
judge what a non-zero exit means:

```json
[
  { "bin": "npm", "args": ["test"] },
  { "bin": "npx", "args": ["tsc", "--noEmit"] }
]
```

An existing `--task` file is read regardless of extension. A missing path-like value
(including a separator, a leading `.`/`~`, or any whitespace-free token) is a preflight
error; multi-word inline prose is used verbatim.

## Outcomes and exit codes

| Outcome | Meaning | Exit |
|---|---|---|
| `review-ready` | current execution approval with actual Claude review: blocking findings closed, diff produced | 0 |
| `no-op` | executor changed nothing | 0 |
| `verifier-failed` | the reviewer failed to launch, timed out, or wrote no report | 4 |
| `timed-out` | the final executor, evidence, or reviewer stage exceeded its deadline | 5 |
| `campaign-failed` | at least one dispatched batch unit failed | 6 |
| `budget-exhausted` | a batch exceeded its token budget | 7 |
| `conflicting-intent` | a merge found incompatible parent intents and needs human direction | 8 |
| `needs-decision` | the executor raised a decision that could not be resolved in-run | 9 |
| `executor-failed` | the executor exited non-zero without producing a diff | 10 |
| `needs-pivot` | blocking findings exhausted the debate or require a new approach | 11 |
| — | preflight or argument failure | 2 |
| — | unexpected fatal error, or an unrecognised outcome | 3 |

An unrecognised outcome exits 3 rather than 0, so an outcome added later cannot silently
become a success.

## Iterating

Native planning/execution uses issue dialogue over the current artifact and shared-context
identity. Questions, answers and rebuttals are neutral conversation unless a validated explicit
action establishes a stance; they do not consume proposal/correction cycles or mutate bytes.
Material context or artifact change invalidates old approval. Execution records `converged: null`
when mutual agreement was not recorded, and skipped/unreadable review invents no participation.

Claude authors retained-work replans in both modes and Codex reviews the replacement before
remaining implementation continues. Useful code, checks, evidence and attributed history remain;
an uncertain effect is paused, not blindly replayed. Dialogue has no default round, provider-call
or elapsed ceiling. `URO_DEBATE_ROUNDS`, challenge limits, candidates, campaign rounds, token
budgets, gate retries and operational timeouts are explicit independent controls.

## Optional flat event view with Logdy

[Logdy](https://logdy.dev/) is an optional, local operator tool: a single Apache-2.0 Go
binary with an embedded web UI. The loop does not install, launch, import, or require it.

After the `isolate/finish` stderr line shows the isolated directory, run this from the
package directory (replace `<runId>` with the active run ID):

```powershell
logdy follow "C:/uro/w/<runId>/w/events.jsonl" --full-read --config "docs/optional-tools/logdy-run-events.json" --no-analytics --no-updates
```

For the aggregate planner/lifecycle stream, follow
`C:/uro/w/<campaignId>/campaign-events.jsonl` with the same options.

For a custom `URO_SCRATCH_ROOT`, substitute that root before `/<runId>/w/events.jsonl`.
`--full-read` loads events already written and `follow` keeps reading appended lines. The
checked-in config exposes the event envelope, campaign identity, perspective, decision,
reasoning, and scope as sortable table columns. It remains useful for filtering and drill-down;
the observability audit concludes that an interleaved flat table is not an adequate primary
current-state view for many concurrent units.

Native execution does not synthesize all historical `diff/*`, `debate/*`, or `decision/*` event
pairs. Constructor/schema controls are compatibility checks, not proof of native emission. Native
dialogue state/journal plus actual executor/check/reviewer/report events are separate inputs.

Do **not** use `loop run ... | logdy`: stdout is the machine-readable run-facts contract,
not the event stream. Logdy must follow the isolated `events.jsonl` file.

## Offline Obsidian run journal

Run-note generation is a separate offline command. It is never called by `loop run`, reads
only completed scratch artifacts, and writes only under this package's `docs/runs/` folder.

Generate one note by passing either the isolated `w` directory, its parent run directory,
or the facts file itself:

```powershell
node bin/generate-run-journal.js "C:/uro/w/<runId>/w"
node bin/generate-run-journal.js "C:/uro/w/<runId>/w/uro-runfacts.json"
```

Regenerate every run discoverable below a scratch root:

```powershell
node bin/generate-run-journal.js --all "C:/uro/w"
```

The output is deterministic for the same `uro-runfacts.json` and optional `events.jsonl`. This
offline report journal is distinct from the versioned project notebook/recall store; neither is
hidden cross-project model memory.
See [`docs/runs/README.md`](../runs/README.md) for the stable frontmatter schema and an
embedded Obsidian Bases campaign table.

## Configuration

- **Superpowers prerequisite:** Codex must report `superpowers@openai-curated` as
  `installed, enabled`; Claude must resolve a compatible manifest with readable skills.
  Set `URO_SUPERPOWERS_DIR` to the directory-based plugin used by Claude when cache
  discovery is insufficient. Set `URO_REQUIRE_SUPERPOWERS=0` only for a deliberate degraded run;
  run facts retain per-seat evidence and versions, and the report states the bypass.
- **Scratch root** defaults to `C:/uro/w` on Windows and `~/.uro/w` elsewhere. Override with
  `URO_SCRATCH_ROOT`.
- The scratch root must **not** sit under `AppData` or `OneDrive`. This is enforced, not
  advisory — AppData is MSIX-redirected under a packaged host, and OneDrive syncs mid-write
  and lengthens paths past Windows limits.
- Model defaults are pinned at their launch boundaries in `src/executor.js` and
  `src/verifier.js`; reports import those same defaults rather than duplicating them.
- **Executor elapsed timeout:** none by default. Set `URO_EXECUTOR_TIMEOUT_MS` or pass
  `--executor-timeout` to impose an operator-owned millisecond limit.
- **Verifier elapsed timeout:** none by default. Set `URO_VERIFIER_TIMEOUT_MS` or pass
  `--verifier-timeout` to impose an operator-owned millisecond limit on each Claude review pass.
- **Arbiter elapsed timeout:** inherits the verifier timeout by default. Set
  `URO_ARBITER_TIMEOUT_MS` or pass `--arbiter-timeout` to bound each read-only Claude judgement.
- **Gate timeout:** 60 minutes per command by default (chosen to accommodate slow test
  suites); override with `URO_GATE_TIMEOUT_MS`.
  All timeout overrides are positive integer millisecond values.
- **Liveness check:** the first check occurs after fifteen minutes without a stdout byte at the
  executor or either verifier pass; override that first positive millisecond interval with
  `URO_STALL_THRESHOLD_MS`. Silence asks a separate read-only judge using recent events, the
  last agent message, live process descendants, and worktree activity. A working judgement
  chooses the next check interval; a stuck judgement kills the seat. If no judge is available,
  the seat is killed and the facts identify the decision as unjudged. There is no hard elapsed
  ceiling.
  Under an enforced token allowance, an in-flight writer with unknown usage denies a concurrent
  paid liveness judge; unknown usage is not estimated as zero or reserved speculatively.
- **Progress gap:** five minutes since the last completed item; override with
  `URO_PROGRESS_THRESHOLD_MS`. Progress silence is informational and never kills or restarts
  while stdout bytes continue to prove liveness.
- **Stall policy:** `URO_STALL_POLICY=report` records a stuck executor without a relaunch. Set
  `URO_STALL_POLICY=restart` to relaunch that executor with a stall notice appended to the
  original plan. Verifier passes are never rewritten into findings after a kill.
  Native uncertain writer effects pause without blind replay; restart wording applies only where
  the saved legacy controller positively establishes replay safety.
- **Stall restart bound:** one restart by default; set `URO_STALL_RESTARTS` to `0`-`3`.
  Stall restarts and gate retries have separate limits and counters in the run facts.
- **Dialogue:** no default dialogue round, provider-call, or elapsed ceiling. Set
  `URO_DEBATE_ROUNDS` to an explicit positive proposal-cycle cap where supported; `loop plan
  --rounds` is also explicit. Neither option counts ordinary Q&A or campaign rounds.
- **Terminal heartbeat:** pass `--quiet` to suppress event summaries on stderr without
  disabling the isolated `events.jsonl` stream.

## Chunking wave goals

Large goals should be decomposed BEFORE the loop runs: the `uroboros-chunk` skill (skills/uroboros-chunk/SKILL.md) runs in the calling session, cuts the goal into small units from reasoning (never size rules), verifies declared structure (acyclic dependencies, disjoint parallel files) as report-back advisories, executes each unit's evidence commands so they are provably runnable today, and emits the queue/campaign file. The loop core is unchanged; it simply receives smaller units.

Use [outcome-based goal and task sizing](task-sizing.md) to reason about those boundaries,
challenge missing or unnecessary work, and preserve completed evidence when remaining work must be
replanned. The questions are planning prompts, not numerical limits or automated acceptance rules.
