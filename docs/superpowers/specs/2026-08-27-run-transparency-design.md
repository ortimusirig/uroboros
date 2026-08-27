# Run Transparency

**Date:** 2026-08-27
**Status:** Draft, pending review

## Summary

Six changes that share one root cause: **uroboros knows more than it tells you.**
Every issue below is the same shape — the harness has the information, and
discards, buries, or silently ignores it.

1. Env vars it recognises but drops (`§1`)
2. Run artifacts it produces but does not keep (`§2`)
3. A debate channel it built but never taught the executor (`§3`)
4. Decision events it emits into a vocabulary that rejects them (`§4`)
5. A liveness signal it measures but never consults before killing (`§5`)
6. A health verdict it computes but prints last (`§6`)

Plus the view that makes the result legible: a **live single-run transcript**
(`§7`), and the push-back, arbitration, and STORM pivot that make the debate a
conversation rather than a monologue (`§8`).

Origin: `FINDINGS-2026-08-27-performance.md`, written from two live runs against a
~1,670-file repo, plus source verification of every claim.

**This spec is infrastructure for the three-way debate loop**, which is already
specced (`2026-08-25-three-way-debate-loop-design.md`), already has pre-written
tests (`test/debate.test.js`, `test/review.test.js`, `test/fix-plan.test.js`) and
Codex-ready plans (`campaign/debate/plan-*.md`), and is waiting only on
implementation of `src/debate.js`, `src/review.js`, and `src/fix-plan.js`.

Each item below is a precondition for that loop working or being observable:

| Section | What breaks in the debate loop without it |
|---|---|
| §4 | `debate` / `resist` are undeclared — every debate event is silently swallowed |
| §5 | `detectCircling` needs 3 completed rounds; a 30-minute wall-clock kill destroys the debate first |
| §7 | A three-way argument is invisible without a transcript to read it in |
| §3 | The Codex arm of the debate *is* `DECISION.md`, which it has never been told exists |
| §8 | "Claude arbitrates" has no wiring, and `PIVOT_FRESH` has no meaning |

## Motivation

Users report "uroboros is slow." Measurement says otherwise. The two runs that
produced the findings show a harness that is *quiet*, not slow — and quiet
failure reads as slowness.

The leading example: a user sets `EXECUTOR_TIMEOUT_MS`, uroboros ignores the name
without a word, keeps its 30-minute default, and force-kills a healthy executor
twice. Thirty minutes of work discarded, twice, with no message connecting the
kill to the setting the user thought they had changed.

None of this is an architecture problem. §2 of the findings measured a 97% input
cache ratio across three sequential full-model passes; that is the cost of the
three-seat design and is out of scope here. The scope of this spec is: **say what
you know.**

---

## §1 — Recognised environment variables are silently ignored

### Problem

`src/env-compat.js:21` reads only `URO_<SUFFIX>` and the deprecated `CCC_<SUFFIX>`
alias. A bare `EXECUTOR_TIMEOUT_MS` — the name a user would guess, and the name
that survives a copy-paste out of shell history — returns `undefined` with no
warning. `src/timeouts.js` then silently applies
`DEFAULT_EXECUTOR_TIMEOUT_MS` (30 minutes).

`ALIASED` is an explicit list of the nine variables a user is *meant* to set. The
code knows the name is meaningful and ignores it anyway.

Compounding it: `src/args.js` has **no timeout flags at all**. Environment
variables are the only control surface for stage timeouts, and that surface fails
silently.

### Design

In `readEnv`, before returning `undefined`, warn once per suffix when the
unprefixed name is set:

```js
if (env?.[suffix] !== undefined && !warned.has(suffix)) {
  warned.add(suffix);
  warn(`${suffix} is set but ignored — did you mean URO_${suffix}?`);
}
```

The `warned` Set and `resetDeprecationWarnings()` already exist for exactly this
pattern.

The check applies to every suffix in `ALIASED`, not just timeouts.

**Additionally**, add CLI flags so the env var is not the only path:
`--executor-timeout`, `--verifier-timeout`, `--gate-timeout`, each taking
milliseconds and overriding the environment.

### Testing

- A bare `EXECUTOR_TIMEOUT_MS` warns once and still returns the fallback
- A second read of the same suffix does not warn again
- `resetDeprecationWarnings()` re-arms the warning
- `URO_` set alongside the bare name warns nothing and returns the `URO_` value
- Each new CLI flag overrides the corresponding env var

**Non-goal:** honouring the unprefixed name. Warning is the fix; silently
accepting both would entrench the ambiguity.

---

## §2 — Run artifacts do not survive the worktree

### Problem

Every artifact a run produces is written *inside* the disposable worktree at
`<scratchRoot>/<runId>/w/`: `TASK.md`, `events.jsonl`, `uro-report.md`,
`uro-runfacts.json`, `CHANGES.diff`.

The findings doc attributes their loss to uroboros cleaning up after itself. That
is **not** what happens — `isolation.js` builds a `cleanup:` closure at `:378` and
`:402`, but nothing in `src/` or `bin/` ever calls it. Only
`test/isolation.test.js` does. Run worktrees are removed by external housekeeping,
not by uroboros.

The real defect stands regardless: there is no durable, discoverable copy of any
artifact outside a scratch tree the tool does not own. `bin/generate-run-journal.js`
exists and writes `docs/runs/<runId>.md`, but it is manual, offline, opt-in, and
reads *from the worktree* — so it only helps if you remember to run it before the
directory disappears.

Consequence: wall-clock timing for a completed run cannot be reconstructed an hour
later. No performance claim about uroboros can be measured or refuted.

### Design

After `writeReport` completes in `run.js`, copy the harness artifacts to a durable
per-run directory outside the disposable worktree:

```
<artifactRoot>/<runId>/
  TASK.md
  events.jsonl
  uro-report.md
  uro-runfacts.json
  CHANGES.diff        (when a diff was produced)
  DECISION.md         (when the run ended needs-decision)
```

- `artifactRoot` defaults to `<scratchRoot>/artifacts`, overridable via
  `URO_ARTIFACT_ROOT` and `--artifact-root`.
- The file list is derived from `HARNESS_ARTIFACTS` in `src/artifacts.js`, which is
  already the single source of truth for this set. Do not introduce a second list.
- Copying is **best-effort and non-fatal**: a failed copy reports a
  `report/finish` field and never changes the run outcome. The same principle as
  `reportEvent` — artifacts are disposable, the run is not.
- Retention is not automated in this pass. The directory grows; `doctor` reports
  its size so the operator can act.

### Testing

- A completed run leaves every produced artifact under `<artifactRoot>/<runId>/`
- A run that produced no diff omits `CHANGES.diff` without erroring
- An unwritable artifact root does not fail the run and does not change `outcome`
- The copied `events.jsonl` is byte-identical to the worktree original
- `generate-run-journal.js` accepts an artifact directory as input

---

## §3 — The executor is never taught the debate protocol

### Problem

The challenge channel is real and built. `src/decision.js` parses a `DECISION.md`
into typed questions (`Kind: technical | product | authority`). `run.js:412`
`routeChallenges()` detects it, confirms the diff is genuinely empty, emits a
`decision/challenged` event, and either resolves and re-runs the executor or halts
with outcome `needs-decision` carrying the questions.

**Nothing tells the executor this channel exists.** `DECISION.md` appears nowhere
in `executor.js`, `task.js`, `skills/uroboros/SKILL.md`, `commands/`, the README,
or the plan template — only in design docs, the parser, the router, and the
artifact exclusion list.

And the plan reaches Codex completely unwrapped. `executor.js:170`:

```js
const r = await spawnCapture(bin, args, { cwd, input: plan, timeoutMs, signal, ... });
```

`input: plan` is whatever `resolveTask` read off disk, byte for byte. No preamble,
no protocol, no framing.

Observed consequence: a round burned 381k input tokens, produced zero code, and
ended with *"Approve this design and I'll implement it."* The executor had a real
question, no sanctioned way to ask it, and said so in prose. `detectChallenge`
found no file, the gate passed vacuously, the diff was empty, and `run.js:542`
reported `no-op`. **A working debate loop reported a successful conversation
opener as "produced nothing."**

The scaffold invites this. `init.js:12` `PLAN_TEMPLATE` uses `## Required
behavior` / `## Invariants` / `## Out of scope` — headings that read as a design
document under review, not a work order.

### Design

Three changes, cheapest first.

**1. A harness-owned preamble.** Prepend to the plan before it reaches Codex —
written by the harness, not by the user, so it cannot be omitted:

- You are implementing an approved plan. Do not stop to request design approval.
- If you genuinely cannot proceed without a decision, write `DECISION.md` in the
  worktree root, in the documented `## Q1` / `Kind:` / `Question:` / `Options:` /
  `Recommendation:` format, and stop.
- Producing no diff and no `DECISION.md` is a failed pass.

The preamble is a single exported constant so tests can assert the executor
received it.

**2. Fix the scaffold.** `PLAN_TEMPLATE` reads as an instruction, not a proposal.
It also documents the `DECISION.md` escape hatch so a user reading the template
learns the protocol exists.

**3. Name the unstructured ask.** Belt-and-braces for an executor that ignores the
preamble. When the diff is empty, the exit code is 0, and no `DECISION.md` exists,
scan the executor's `agent_message` items for an approval request. On a match,
report outcome `no-op` with a `noOpReason: 'approval-requested'` fact, and say so
in `uro-report.md` — pointing at `DECISION.md` as the supported channel.

Detection is a conservative phrase match. A false negative is a normal `no-op`; a
false positive adds one explanatory line. Neither changes the outcome or the exit
code.

### Testing

- The executor receives the preamble ahead of the plan body
- `PLAN_TEMPLATE` contains no approval-seeking framing and documents `DECISION.md`
- An empty diff + exit 0 + approval-request prose sets `noOpReason`
- An empty diff + exit 0 + unrelated prose does not set it
- `noOpReason` never alters `outcome`, `gateStatus`, or the process exit code
- A well-formed `DECISION.md` still routes through `routeChallenges` unchanged

---

## §4 — Decision events are emitted into a vocabulary that rejects them

### Problem

`run.js:424` and `:445` emit:

```js
reportEvent(eventReporter, runId, 'decision', 'challenged', { questions });
reportEvent(eventReporter, runId, 'decision', 'resolved',   { answers });
```

`events.js` declares a closed vocabulary. `EVENT_STAGES` contains no `decision`;
`EVENT_TYPES` contains no `challenged` or `resolved`; `EVENT_PAIRS` has no
`decision/*`. So `createEvent` throws at `events.js:124`, and `reportEvent`
swallows it:

```js
} catch {
  // An event is disposable. The run is not.
}
```

That catch is correct engineering — observability must never kill a run. Here it
means **every debate event is silently discarded**. Not merely unrendered: never
written to `events.jsonl` at all. The safety net that keeps the run alive is what
hides the channel being mute.

### Design

Declare the vocabulary:

- `EVENT_STAGES`: add `decision`, positioned between `diff` and `verify` to match
  pipeline order
- `EVENT_TYPES`: add `challenged`, `resolved`
- `EVENT_PAIRS`: add `decision/challenged`, `decision/resolved`

Event fields:

- `decision/challenged` — `questions[]` (id, kind, question, options,
  recommendation), `challengeRound`
- `decision/resolved` — `answers[]`, `answeredBy` (`'user' | 'planner'`),
  `challengeRound`

`answeredBy` is what makes the exchange auditable: after the fact you can always
see who decided. In manual mode the answer is the operator's; in autonomous mode
it is the resolver's.

`events.js:193` `validateEventVocabulary` cross-checks declared pairs against
exercised emissions, so declaring these requires a test that actually emits them.
That is the intended ratchet, not an obstacle.

**Every new event in this spec must be declared here, or it will be swallowed the
same way.** The full set:

| Pair | Introduced by |
|---|---|
| `decision/challenged`, `decision/resolved` | §4 |
| `executor/extended` | §5 |
| `verify/item_completed` | §7 |
| `executor/item_started`, `verify/item_started` | §7 |
| `debate/round`, `debate/resist`, `debate/converged` | §8 / three-way debate spec |
| `debate/circling`, `debate/pivot` | §8 |

The `debate` stage and `resist` type are **already emitted by the pending
three-way debate design** (`{"stage":"debate","type":"resist",...}`) and are
likewise undeclared today. Declaring them here means that loop is observable the
day it lands, instead of shipping mute and needing this fix a second time.

Treat "emitting an event whose stage or type is undeclared" as the defect class
this section exists to close, not as a one-off fix for `decision`.

**Note:** a `decision` stage event now flows through `createGapWatchdog`'s
`observedReporter` like any other, which arms a stall timer against a stage that
is legitimately waiting on a human. Manual-mode `needs-decision` ends the run, so
the watchdog is disposed before it can fire — but this must be asserted, not
assumed.

### Testing

- `decision/challenged` and `decision/resolved` round-trip through `createEvent`
  without throwing
- Both appear in `events.jsonl` after a run that halts on a challenge
- `validateEventVocabulary` passes with the new pairs exercised
- An undeclared stage still throws (positive control — the guard is not weakened)
- A manual-mode `needs-decision` run emits no spurious `decision/stalled`

---

## §5 — The deadline kills healthy work

### Problem

Two independent systems that never speak to each other:

| | Measures | On breach |
|---|---|---|
| `stall-watchdog.js` | silence — *is it stuck?* | emit `stalled`, optionally restart |
| `spawn.js:136` timeout | elapsed wall-clock | `SIGKILL` the process tree |

At the deadline `spawn.js` calls `killProcessTree` — `taskkill /t /f` on Windows,
`process.kill(-pid, 'SIGKILL')` on POSIX. SIGKILL cannot be caught. Codex gets no
chance to flush a file. `run.js:510` sets `outcome = 'timed-out'`, the gate never
runs, the verifier never runs, and everything written mid-pass is discarded.

The timeout does not ask the watchdog anything. **A Codex streaming healthy output
every four seconds dies identically to one wedged for 25 minutes**, and the
evidence of which it was dies with it.

Elapsed time is the wrong signal. Silence is the right one, and uroboros already
measures it.

### Design

**Two-tier liveness.** `spawnCapture`'s `onStdout` receives every chunk, including
reasoning deltas that never become a completed item. That is a second signal
already arriving and currently unused. Split it:

| Tier | Trigger | Meaning | May kill? |
|---|---|---|---|
| **Liveness** | any byte on stdout | process is alive | **yes** |
| **Progress** | `item.completed` | finished real work | **never** |

Both are pure local observation. Neither costs a token or a model call.

**Thresholds.** Two knobs, both defaulting to 5 minutes:

- `URO_STALL_THRESHOLD_MS` (existing, default drops `10m → 5m`) now governs
  **liveness**. Five minutes of total dead air is unambiguous.
- `URO_PROGRESS_THRESHOLD_MS` (new, default 5m) governs **progress** silence and
  is **informational forever** — it renders as "no completed work for 5m, last
  action: editing `src/foo.js`" and never kills.

This inversion is what makes 5 minutes safe. Today's single threshold keys off
`item.completed` only, which is why `executor.js:164` documents that "healthy
Codex turns often outlive the watchdog gap" and why the default is padded to 10
minutes. Once a thinking executor proves liveness through raw bytes, the
completed-item threshold no longer has to be generous.

**Evidence-based deadline.** At the executor deadline, consult liveness:

- Still emitting → emit `executor/extended` with the observed gap, extend by one
  further interval, continue
- Silent past the liveness threshold → kill, and record *why*: gap length, last
  event, and the setting to raise

A hard ceiling (`URO_EXECUTOR_MAX_MS`, default 6h) remains so a truly wedged
process cannot hang a run forever. A timeout that can never fire is not a timeout.

**This is a precondition for the debate loop's own stuck-detection.**
`detectCircling` returns `false` with fewer than three recorded rounds. Three
rounds of review → fix-plan → re-execute against a real repository do not fit in
thirty minutes. The current wall-clock kill therefore destroys a debate *before*
circling can be detected — the timeout is not an alternative to `shouldPivot`, it
is what currently prevents it from ever firing.

The two detectors are complementary and neither substitutes for the other:

| | `detectCircling` | §5 liveness |
|---|---|---|
| Detects | **semantic** stuck — findings recur, count not decreasing | **mechanical** stuck — zero bytes |
| State | agents healthy, not converging | process crashed or wedged |
| Response | pivot | kill |

A wedged process produces no rounds, so the ledger never reaches three and
`detectCircling` never fires. A circling debate emits bytes constantly, so liveness
sees a healthy process. Both are required.

**Preserve partial work.** Before any kill, commit whatever the executor has
written to the isolated branch. A timed-out run then reports *how far it got*
instead of nothing. This applies to every kill path, including the hard ceiling.

### Testing

Use the existing controlled-clock pattern from `stall-watchdog.test.js`, including
its positive control.

- Bytes arriving past the deadline extend rather than kill
- Silence past the liveness threshold kills and records gap + last event
- Progress silence with live bytes never kills, and does emit a `stalled` event
- The hard ceiling kills even a chatty process
- Partial work is committed and appears in the diff of a timed-out run
- A timed-out run's report names the timeout that fired and how to raise it

---

## §6 — `doctor` buries its verdict

### Problem

Narrower than the findings doc reports. `doctor.js:71` already groups optional
checks after required ones, under a header stating they do not affect loop health.
Two things still cause the bad first impression:

1. **The verdict is last.** `HEALTHY`/`UNHEALTHY` is pushed at `:85-93`, after the
   full wall of output. Nothing at the top states the answer.
2. **Optional checks report `FAIL`.** `gh`, `gh auth`, the GitHub remote, and
   logdy all emit `status: 'FAIL'` (`doctor-checks.js:532`, `:559`, `:586`,
   `:594`). A missing optional tool is not a failure, but it renders in the same
   alarming token as a broken Codex sign-in.

### Design

- Lead with the verdict. Emit the health line immediately after the `uroboros
  doctor` header, then the detail. The trailing verdict stays, so scripts reading
  either position keep working.
- Optional check status tokens are **unchanged**. Renaming absent optional checks
  from `FAIL` to `SKIP` was considered and **rejected by the operator**: it changes
  `doctor` output that scripts or CI may be parsing, and leading with the verdict
  already solves the first-impression problem on its own.
- `doctor` reports the artifact-root size from §2.

### Testing

- The health verdict appears in the first three lines and again at the end, and
  the two agree
- A missing optional tool still renders `FAIL` and still leaves `ok: true`
- A failing required check renders `FAIL` and sets `ok: false`
- `--fix` remediation behaviour for optional checks is unchanged

---

## §7 — The live run transcript

### Problem

`renderRunDetail` (`dashboard-view.js:987`) already assembles nearly all the right
content on one page — live state, current stage, the TASK.md body, both verifier
seats, executor rationale, the unified diff, per-file changes, gate commands with
exit codes, stalls, token usage per seat — and `dashboard.js` pushes it over SSE
with a 250ms fingerprint diff and a 15s keepalive.

It renders as a **report**: stacked sections, read after the fact. What is wanted
is a **transcript**: one run, one tab, read-only, top-to-bottom as it happens,
with the diff beside it.

Three substantive gaps:

1. **The verifier does not stream.** `verifier.js:325` calls `spawnCapture` with no
   `onStdout` — despite already requesting `--output-format stream-json`. Cursor
   streams; uroboros discards the liveness and parses only at the end. The reviewer
   is silent for minutes, then a verdict appears.
2. **Reasoning text is dropped.** Verified against the Codex CLI: `codex exec
   --json` emits `{"type":"item.completed","item":{"type":"reasoning","text":...}}`.
   `createIncrementalReporter` captures text only for `agent_message`
   (`executor.js:113`), so reasoning arrives and is thrown away. uroboros also sets
   `model_reasoning_effort` but not `model_reasoning_summary`.
3. **`item.started` is filtered out.** `executor.js:80` drops every event that is
   not `item.completed`. Verified present: `command_execution` arrives first with
   `status: "in_progress"`. That is a free in-flight progress signal.

### Prior art

Five open-source viewers were evaluated: claude-devtools, claude-code-trace
(Rust + React 19 + Tauri + Python), claude-tap (Python, MIT), Codeman, and
simonw/claude-code-transcripts.

**None was adopted, for two reasons.** All parse Claude Code's
`~/.claude/projects/*.jsonl` format — which neither Codex nor Cursor writes — and
**none has a code-diff-beside-transcript layout**, so the wanted feature would be
built regardless. claude-tap's "structured diff" compares adjacent *API requests*,
not code. It is also a proxy, and therefore structurally blind to the gate:
`npm test` exiting 0 makes no API call.

That last point generalises. Of uroboros's twelve event stages, only two
(`executor`, `verify`) come from the agents. The other ten — `gate`, `isolate`,
`diff`, `merge`, `campaign`, `round`, `unit`, `planner`, `report`, `journal` — are
the harness's own. A session-viewer format has nowhere to put the gate, and the
gate is the product thesis.

**Adopted as ideas, at no dependency cost:** claude-devtools' renderer-per-step-type
(edit → inline diff, command → exit code + output, read → highlighted source), and
claude-tap's self-contained-HTML-plus-SSE shape — which is already what
`dashboard.js` does.

### Design

**The transcript is the only view.** The Triage and Project/Session tabs are
**removed**, not demoted — stated three times by the operator: "I don't need the
current 2 tabs, just one." Opening the dashboard lands directly in the transcript.

It is served by the same HTTP server, SSE push, event parser, and diff renderer
the removed views used — the plumbing is reused, the tab bar and its two views go.

**Many runs are handled by a run picker, not a second view.** Campaigns fan out
concurrent units (`campaign.js:535`), so the transcript header carries a selector
listing discoverable runs under the scratch root with their state, defaulting to
the most recent active one. Switching runs swaps the transcript; it does not open
a different page. One tab, one layout.

**This deletion removes most of the reason to split the file.** `renderTriage`,
`renderSessions`, `renderProjects`, `renderSessionList`, `renderProjectList`,
`renderPassRow`, `orderCorrectionRows`, `inferSessions`, `groupRunsByProject`, and
their triage helpers all go with the views they served. `dashboard-view.js` gets
substantially smaller before a single transcript renderer is added.

Two panes:

- **Left — transcript.** Chronological, attributed, one row per step, live.
  Renderer per step type: reasoning as muted italic, agent message as prose,
  file edit as a clickable row, command as command + exit code + collapsible
  output, verifier verdicts per seat.
- **Right — inspector.** Tabs for the diff, `plan.md`/`TASK.md`, and the verifier
  report markdown. Clicking a file event loads that file's diff.

The gate renders as a **visible seam**, not a chat row — a full-width band with
each command and its exit code. Two verifier seats render separately so a
disagreement is obvious. This is deliberate: the separation of seats is the
product's argument, and the layout should state it.

Debate turns render attributed:

```
CODEX    Q1 (authority) — delete the legacy adapter?
YOU      No — deprecate it, keep the shim.          (manual)
PLANNER  No — deprecate it, keep the shim.          (autonomous)
```

driven by the `answeredBy` field from §4. Manual mode surfaces the question and
the operator answers; autonomous mode shows the resolver's reply. Same rendering,
different author.

**Supporting changes:**

- `verifier.js` gets the `onStdout` incremental-reporter treatment `executor.js`
  already has. Verdict parsing is untouched — the stream is observed, not
  reinterpreted. `spawnCapture` still returns every original byte.
- `createIncrementalReporter` captures `reasoning` item text via the existing
  `encodeRecordedText` path, and observes `item.started` to emit an in-progress
  event. `buildCodexArgs` sets `model_reasoning_summary`.
- New event types: `verify/item_completed` (mirroring `executor/item_completed`)
  and an in-progress type for started items.

**No separate refactor pass.** The operator declined splitting the file as scope
that delays visible work, and removing the two views largely solves it anyway.
New transcript renderers go in their own module rather than growing
`dashboard-view.js` further.

### Phasing

| Phase | Content | Value |
|---|---|---|
| **0** | §4 vocabulary — debate visible in the existing timeline | ~5 lines; un-hides a built feature |
| **1** | Verifier streaming; reasoning + `item.started` capture | Live reviewer, live thinking |
| **2** | Split `dashboard-view.js`; two-pane transcript | The view itself |

Phase 0 ships independently of everything else and should not wait.

### Testing

- Verifier streaming emits incremental events, and `parseVerdict` /
  `hasVerdictEvidence` return byte-identical results to the non-streaming path
  (guarded by existing `verifier.test.js` and `verifier-evidence.test.js`)
- A `reasoning` item's text reaches the event stream, truncation-aware
- An `item.started` `command_execution` emits an in-progress event, later
  reconciled by its `item.completed`
- Transcript rendering is a pure function of a snapshot — golden-file tested like
  the removed dashboard views were
- The run picker lists discoverable runs and defaults to the most recent active one
- Removing the triage/session/project views breaks no remaining code path, and
  their golden fixtures are deleted with them
- Every rendered field is HTML-escaped; agent prose is untrusted input
- The transcript renders correctly for a run with zero decision events

---

## §8 — Push-back, arbitration, and the STORM pivot

### Problem

Three separate breaks in what is meant to be a conversation.

**1. Only one seat can push back, and its channel is disconnected.**

| Seat | Can it push back? | Vocabulary |
|---|---|---|
| Codex (executor) | in principle | `DECISION.md`, typed questions |
| Cursor (verifier) | **no** | two strings — `NO_BLOCKERS` or `ISSUES` (`verifier.js:24`) |
| Claude (planner) | no | authors `TASK.md`; nothing challenges back |

The seat whose entire job is finding problems can only vote.

**2. Nothing answers.** `run.js:428` refuses the answer-and-continue path unless a
`decisionResolver` is a function. Every production caller — `bin/loop.js`,
`campaign.js`, `setup.js` — omits it; the only supplier in the repository is
`test/run.test.js:610`. So `:433-446` is unreachable outside tests and every
challenge halts the run. The debate is one-way by omission, not design.

**3. `PIVOT_FRESH` has no meaning.** `campaign/debate/plan-debate.md` specifies
`shouldPivot` as returning `PIVOT_AMEND` / `PIVOT_FRESH` / `PIVOT_CONCLUDE`, each
merely "a distinct non-empty string". Nothing says what a fresh pivot *does*. A
pivot that re-runs the same approach is the re-roll the campaigns spec
deliberately removed in v2 — repetition, not learning.

### Design

**Arbitration.** Wire the resolver so the exchange completes without the operator
restarting the run.

- **`--mode manual` (default)** — halts with `needs-decision`; §4's events and §7's
  transcript render the questions; the operator answers and re-runs.
  `answeredBy: 'user'`.
- **`--mode autonomous`** — `bin/loop.js` supplies a resolver that answers from the
  plan and the executor's stated reasoning, rewrites `TASK.md` via the existing
  `planWithDecision`, and re-runs the executor. `answeredBy: 'planner'`.

The `mode` flag already exists (`args.js:16`) and `run.js` already branches on it.
This connects the branch that was left dangling.

This same mechanism is what the three-way debate design calls "Claude arbitrates".
It must not be built twice: the debate loop's `run.js` integration consumes this
resolver rather than introducing a parallel one.

**Bounds, because an auto-answering loop must not run away:**

- `challengeRounds` (existing, default 2) caps the exchange. On exhaustion the run
  halts with `needs-decision` and reports the unresolved questions.
- A resolver returning no answers is treated as no resolution: halt, do not re-run.
- `kind: 'authority'` questions **always** halt, even in autonomous mode. A
  question the executor itself classified as requiring authority is not one a
  resolver answers on the operator's behalf.

**The STORM pivot.** When `detectCircling` fires, `shouldPivot` escalates:

```
shouldPivot(0) → PIVOT_AMEND     adjust the existing plan in place
shouldPivot(1) → PIVOT_FRESH     regenerate via STORM multi-perspective
shouldPivot(2) → PIVOT_CONCLUDE  stop and report honestly
```

`PIVOT_FRESH` is defined here as **escalation to a campaign round**, not a local
retry. Operator decision, chosen to preserve the boundary the campaigns spec
draws: *"`loop run` remains one pass with one checkpoint. Rounds live at the
campaign level, in a separate command."*

Mechanism:

- The run ends with a new outcome, **`needs-pivot`**, carrying the debate ledger —
  all findings seen, which recurred, which resolved, and the round history.
- `campaign.js` consumes that ledger as input to Mode A: the planner generates N
  candidates from **genuinely distinct perspectives**, informed by exactly which
  framings already failed and how.
- Mode A's existing machinery is reused unchanged — `planner/candidate_generated`
  with declared perspectives, per-candidate gates and verifier passes,
  `planner/synthesis`. **No comparator is built and nothing is scored**, per that
  spec's anti-gaming rule.

This is the campaigns spec's own distinction between repetition and learning: a
round re-runs a *different* plan informed by real reviews of really executed code.
The ledger is what makes the new round better-informed rather than a re-roll.

**Out of scope for this pass:** STORM-generating the *initial* plan. It requires
`loop run` to hold a planner seat, which crosses the same boundary in the opposite
direction and costs planner tokens on every run. Revisit once pivot escalation is
proven.

### Testing

- Manual mode halts with `needs-decision` and emits `decision/challenged`
- Autonomous mode answers, rewrites `TASK.md`, re-runs the executor, and emits
  `decision/resolved` with `answeredBy: 'planner'`
- `challengeRounds` exhaustion halts rather than looping
- An `authority`-kind question halts in autonomous mode
- A resolver returning no answers halts and does not re-run
- `DECISION.md` is removed before the executor re-runs (existing `unlinkSync`)
- `detectCircling` true at `pivotCount === 1` produces outcome `needs-pivot`
- A `needs-pivot` run's facts carry the full ledger: all, recurring, resolved
- `PIVOT_CONCLUDE` stops and reports; it does not silently succeed
- A campaign consuming a `needs-pivot` ledger generates candidates whose declared
  perspectives differ from the failed framing

---

## Implementation order

This spec is larger than one implementation plan. It decomposes into three, in
this order — each independently shippable and independently valuable.

**Plan A — say what you know (small, no new surface).**
§1 env warning + timeout flags · §4 event vocabulary (all pairs in the table) ·
§6 doctor verdict-first. Nothing here depends on anything else, and §4 alone
makes the debate visible for the first time.

**Plan B — stop losing things, and finish the conversation.**
§2 durable artifacts · §5 evidence-based deadline and partial-work preservation ·
§3 executor preamble, plan template, and the named no-op · §8 arbitration and the
`needs-pivot` outcome. §5 depends on §4 having declared `executor/extended`. §8
depends on §3 — teaching the executor to ask is worthless if nothing answers, and
wiring an answer is worthless if it never asks. §5 is a hard precondition for the
debate loop: without it, `detectCircling` can never accumulate three rounds.

**Then — the debate loop itself.** `src/debate.js`, `src/review.js`,
`src/fix-plan.js` against their existing pre-written tests, then `run.js`
integration consuming §8's resolver and emitting §4's declared `debate/*` events.
Not part of this spec, but the reason it exists.

**Plan C — the transcript.**
§7 phases 1 and 2: verifier streaming, reasoning and `item.started` capture, then
the two-pane view as the primary entry point. Depends on Plan A's vocabulary, and
renders Plan B's debate exchange once §8 lands.

## Cross-cutting constraints

- **Zero runtime dependencies.** Non-negotiable; it is why the gate can run in a
  bare worktree with no `node_modules`. No change here adds one.
- **Observability cannot decide outcomes.** The `reportEvent` catch stays. New
  events, artifact copies, and transcript rendering are all best-effort.
- **No new artifact lists.** `HARNESS_ARTIFACTS` remains the single source.
- **Escape all rendered agent output.** Executor and verifier prose is untrusted.

## Out of scope

- The 97% cache ratio and the three-pass architecture (findings §2)
- An OTel GenAI semantic-convention exporter. Recorded as a deliberate future
  option: an **optional** exporter would make every third-party viewer work
  without a runtime dependency. Not this pass; the spec moves fast (v1.37→v1.41
  all touched GenAI).
- Adopting or forking any third-party viewer (see §7 prior art)
- Distributed/multi-machine execution, and therefore google/sam. Evaluated:
  it solves discovery, zero-trust transport, and identity portability, none of
  which a single-process local pipeline has. Reconsider only if campaign units
  ever fan out across machines.
- Automated retention/pruning of the artifact root

## Open questions

None blocking. One judgement call, resolved:

1. Dropping the shipped `URO_STALL_THRESHOLD_MS` default from 10m to 5m changes
   behaviour for existing users. **Approved by the operator.** Safe because it
   applies to the new *liveness* tier and the default policy is `report`.
