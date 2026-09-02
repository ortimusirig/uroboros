# Decomposition Spine Design — Project → Goals → Tasks

Date: 2026-09-01 · Status: approved by the owner in-session · Source commit at design time: `11befa5`

## Purpose

Make EULR-sized-and-bigger projects tractable for uroboros. The measured record
(peer campaign, 2026-09-01): task units are 5-for-6 landed including one fully
autonomous landing; goal-sized run units are 0-for-7 — the planning seats drown
in a ~1,700-file tree and a single mega-plan violates the one-increment rule by
construction. This design keeps the goal level for what it is good at
(deliberation) and reserves execution for tasks.

## The concept (owner-settled)

- **Seats decide; helper repos supply shapes, never the pen.** The three-way
  judged conversation (Codex + Cursor draft/review, Claude collates and
  arbitrates) performs all decomposition. spec-kit contributes artifact shapes
  and phase order; task-master contributes the dependency-graph shape; aider
  contributes the repo-map idea. None of them run in the loop and none of their
  formats ever gate anything mechanically.
- **Two deliberation tiers above the proven execution loop:**

  ```
  Project ──(tier 1: three-way conversation)──► goals
  Goal    ──(tier 2: three-way conversation)──► task units (plan.md + gate.json each)
  Task    ──(existing loop: evidence → debate → Claude lands)──► local commit
  ```

- **One deliberation per goal, execution per task.** Tier 2 IS the planning
  conversation for its tasks: it emits every task's `plan.md` and `gate.json`
  directly. Tasks enter the existing queue as ordinary task units. There is no
  per-task re-planning and no goal-sized run.
- **The incremental law is fractal** (owner amendment): the same rule at every
  tier, at its own scale, quoted verbatim in the reviewing prompts and enforced
  by seat judgement only:
  - Tier 1: every goal is a self-contained increment of the PROJECT — after its
    tasks land, the project runs and is usable with one more coherent
    capability. Goals are dependency-ordered, MVP-first: goal 1 is the smallest
    true version of the whole project. No goal depends on a later goal.
  - Tier 2: every task is a self-contained increment of the GOAL — runnable and
    testable alone, exactly one capability.
  A seat that believes an increment is not self-contained raises it as a
  structured suggestion (`S<id> P0: …`); no parser measures incrementality.
- **A goal is never "run" — it converges (tasks defined) and is then achieved
  (tasks landed + Claude's goal-acceptance review).**

## Nomenclature

| Word | Meaning here |
|---|---|
| Project | The whole ask, EULR-sized or bigger. One `project.md`, verbatim. |
| Goal | A self-contained increment of the project. One `spec.md`. Deliberated, never executed directly. |
| Task | A self-contained increment of a goal. One `plan.md` + `gate.json`. The loop's execution unit. |
| Constitution | Optional standing rules for the project (`constitution.md`). Operator-authored. Quoted in every tier's prompts when present; never generated, never validated. |

## Artifact layout (write-once, like all plan artifacts)

```
<target>/uro-project/
  project.md                     ← the Project statement, verbatim (tier-1 input, copied)
  constitution.md                ← optional, operator-seeded; quoted when present
  goals/
    goals.json                   ← tier-1 manifest: ordered goals with dependsOn
    G1-<slug>/
      spec.md                    ← tier-1 output: the goal's converged spec
      tasks/
        queue.json               ← tier-2 output: task units, topologically ordered
        T1-plan.md  T1-gate.json
        T2-plan.md  T2-gate.json …
```

- Every file is written with the `wx` flag (create-only), same as
  `writeArtifacts` today (plan.js:731). A collision is an error, never an
  overwrite. Re-running a tier against an existing output directory fails
  loudly; the operator chooses a new `--out` or clears deliberately.
- `goals.json` entry shape: `{ "id": "G1", "slug": "…", "statement": "…",
  "capability": "…", "dependsOn": ["G0"], "rationale": "…" }`. Goal-level
  `dependsOn` is advisory in this sub-project (the operator runs one goal's
  queue at a time, in manifest order); a goal-level runner that enforces it is
  the named project-runner follow-up.
- `queue.json` is a standard uroboros queue file (task units only):
  `[{ "name": "T1-…", "task": "T1-plan.md", "gate": "T1-gate.json" }, …]`,
  ordered topologically from the seats' declared task dependencies
  (serializing a declared partial order is bookkeeping, never judgement). A
  dependency cycle is a CONTRADICTION, and contradiction asks: it goes back to
  the conversation as named feedback ("T2 and T4 depend on each other —
  resolve or merge them") for the next round. Only a conversation that then
  fails to converge terminates, through its ordinary reasons. The writer never
  silently reorders and never flatly refuses a repairable artifact.

## Command surface

```
loop decompose --project <file-or-prose> --target <dir> --out <dir>   # tier 1
loop decompose --goal <path-to-spec.md>  --target <dir>               # tier 2
loop queue --file <…/tasks/queue.json> --accept-goal <…/spec.md>      # execution + goal acceptance
```

- Tier 2 writes into the goal directory that contains the given `spec.md`
  (sibling `tasks/`). `--out` is invalid with `--goal`.
- `--rounds`, `--candidates`, model flags, and timeouts mirror `loop plan`.
- `--map-budget <chars>` bounds the repo-map ration (default 12000).
- `--accept-goal` is explicit: without it, `loop queue` behaves exactly as
  today. No inference from file location.

## The conversation engine (reuse, not duplication)

`runPlan`'s internal loop (storm → propose → review both → agreement → ledger →
circling → pivot amend/fresh/conclude, with usage tallying, event reporting,
capability vetoes and the five terminal reasons) is extracted into
`src/conversation.js` as a tier-agnostic engine. Injected per tier:

- **prompt builders** — drafting, proposing, reviewing, agreement (each quotes
  the tier's incremental law, the constitution when present, and the repo map);
- **artifact parser** — what a valid proposal looks like (below);
- **artifact writer** — what converged output is written where.

`runPlan` becomes a thin wrapper over the engine with today's prompts, parser
(`PLAN_MD`/`GATE_JSON`) and writer — its behavior, events, and every existing
test stay unchanged. `runDecomposeProject` and `runDecomposeGoal`
(`src/decompose.js`) are two more wrappers.

Seat transports are unchanged: Codex stdin, Claude stdin, Cursor via file
workspace (`withSeatWorkspace`) receiving `PROJECT.md`/`GOAL_SPEC.md`,
`CONSTITUTION.md` when present, `REPO_MAP.md`, and `FEEDBACK.md`.

### Proposal artifact contracts (malformed output is fed back, not refused)

- **Tier 1** returns exactly two tagged artifacts:
  - `<GOALS_JSON>[ { id, slug, statement, capability, dependsOn, rationale } … ]</GOALS_JSON>`
  - `<GOALS_MD>` — markdown containing one `## G<n>: <title>` section per goal;
    each section becomes that goal's `spec.md` verbatim.
  Mismatched ids between the two artifacts, missing tags, or unparseable JSON
  in a PROPOSAL are contradictions fed back verbatim to the proposer for the
  next round ("repair until it works") — never an instant terminal. Only a
  proposer that stays unreachable (launch failure, timeout, no output at all)
  is `arbiter-unavailable`, because a seat that did not run cannot be repaired
  by feedback. The same rule applies to tier-2 artifacts.
- **Tier 2** returns exactly two tagged artifacts:
  - `<TASKS_JSON>[ { id, name, dependsOn, gate: [ {bin,args} … ] } … ]</TASKS_JSON>`
  - `<TASKS_MD>` — one `## T<n>: <title>` section per task; each section becomes
    that task's `plan.md` verbatim. `gate` becomes `T<n>-gate.json` (evidence
    commands — the prompts state, as `loop plan`'s already do, that the harness
    runs them once per round as recorded evidence and no exit code passes or
    fails anything).

### Review contract (identical to planning)

Plain chat text: `AGREE: yes|no`, then `S<id> P0|P1|P2: text`, then
`Q<id>: question`. Severities verbatim, never filtered. Convergence = both
seats AGREE **and** Claude's agreement judgement says converged. Silence,
unreadable output, or an absent seat is never agreement. Recurrence is measured
by the ledger over reused S-ids; what recurrence means is Claude's pivot
judgement (amend / fresh re-storm / conclude), unavailable → deterministic
ladder recorded unjudged. Capability vetoes run before tier-2 convergence
(each seat about its own work only), as in planning today.

## Repo map (`src/repo-map.js`) — the R4 root-cause fix, first version

Zero-dependency input ration for drafting/review prompts on big trees:

- Built from `git ls-files` (tracked files only) with per-file line counts,
  grouped by directory; then exported-symbol head scans (regex over
  `export|function |class |def `) added largest-file-first until the budget is
  reached. No fixed file or symbol counts exist — the single operator-set
  budget (`--map-budget`, default 12000 chars) is the only bound.
- The map DECLARES ITSELF: a header states its evidence grade
  ("heuristic file/symbol survey, not the repository"), exactly what it
  withheld (`… and N more files under <dir>`), and that the seat may read any
  file directly — a ration the model knows it can reach past, never a wall.
  A bound that hides what it withheld is a defect.
- Wired into both decompose tiers now. Adoption by `loop plan` and the run-side
  FRESH replanner is a named follow-up, not in this spec.
- This rations INPUT context. It never touches seat OUTPUT: the judged-text
  rule from `9299df3` (no excerpting on the judged path) is unaffected.

## Goal acceptance (the one new judgement point)

When `loop queue --accept-goal <spec.md>` completes with **every unit landed**:

1. Every landed unit's commit SHA is recorded in its `queue-log.jsonl` row
   (`commit: <sha>`) — this also improves the audit trail generally. The
   acceptance base is the PARENT of the earliest logged landed commit for this
   queue file, so a goal completed across several invocations (stop, resume,
   finish) still gets its complete aggregate diff `git diff <base>..HEAD`.
   Acceptance runs when the log shows every unit of the queue file landed.
2. Claude receives, first-hand: `spec.md`, `constitution.md` when present, the
   aggregate diff, and the queue-log rows of this invocation — via a new
   arbiter request type `acceptance` (prompt asks: is the project in a working
   state that now delivers this goal's capability?). Reply schema
   `{ approved: true|false, reasoning, findings[] }`, parsed like the landing
   judgement: no readable boolean is never consent.
3. Approved → recorded in the queue summary and appended to `queue-log.jsonl`
   as `{ goalAcceptance: { approved, reasoning, findings } }`.
   Refused or unavailable → queue stop kind `goal-acceptance` with the
   judgement recorded. Landed commits are NOT rolled back — the refusal is
   information for the operator, exactly like a landing refusal.
4. If the queue stopped before all units landed, acceptance does not run; the
   stop already tells the story.

Per-task landing review (`491b17c`) is unchanged and still runs for every task.

## Terminal states

- **Each decompose tier** reuses the conversation vocabulary verbatim:
  `converged` / `storm-exhausted` / `arbiter-unavailable` / `pivot-conclude` /
  `rounds-exhausted` (unbounded unless `--rounds`), plus thrown availability
  errors (write-once collision, dependency cycle, invalid artifacts, preflight).
  CLI exit: 0 only on converged, 1 otherwise, 2 on thrown preflight — same as
  `loop plan`.
- **Queue** gains exactly one stop kind: `goal-acceptance`.
- **Events**: no new stages or pairs. Both tiers report through the existing
  `plan` stage vocabulary with a `tier: 'project' | 'goal'` payload field
  (`loop plan` implicitly `tier: 'plan'`); acceptance reports through the
  existing `arbiter` stage pairs. The closed-vocabulary conformance surface is
  untouched.

## Token metering

The engine tallies every seat call into the result's `tokens.total` exactly as
`runPlan` does (the taxi meter runs whether or not you arrive). `--accept-goal`
adds the acceptance judgement's usage to the queue totals and its log row.

## Explicitly out of scope (YAGNI — later sub-projects)

Kanban board (B) · OTel/Langfuse observability (C) · PM/worker seat (D) ·
any spec-kit runtime coupling · parallel task execution within a goal's queue ·
repo-map adoption inside `loop plan`/FRESH · project-level multi-goal runner
(operator runs one goal's queue at a time) · any mechanical validation of
decomposition quality.

The queue's existing `goal` unit kind keeps working but is documented as legacy
once tier 2 ships.

## Build order (the incremental law applied to ourselves)

1. **`src/repo-map.js`** + hermetic tests. Independently useful.
2. **Engine extraction + tier 2** (`loop decompose --goal`): goal → task units.
   Immediately usable — the operator writes goals by hand at first (the proven
   supervisor pattern) and this alone replaces the failing goal-unit path.
   `runPlan` re-based on the engine with its full existing test suite green.
3. **Tier 1** (`loop decompose --project`): project → goals + manifest.
4. **Goal acceptance** (`--accept-goal` + arbiter type `acceptance` + queue stop).

Every increment lands green with hermetic adapter tests and counterfactuals
with applied guards, including at minimum: a convergence that ignores a seat's
AGREE turns the suite red; a dependency cycle silently reordered instead of
refused turns it red; a repo map that trims without saying so turns it red; an
acceptance that treats unavailable as approved turns it red.

## Standing DNA (embedded from the owner's Standing Instructions, generalized)

A shared prompt preamble, `CONVERSATION_DNA`, is included verbatim in every
tier's drafting, proposing, reviewing, and agreement prompts (and exported so
`loop plan` adopts it in the engine extraction). Its lines, generalized from
`Obsidian-ai/EULR/Standing Instructions.md` where they apply to uroboros:

1. **Determinism advises; the model decides; contradiction asks.** Anything
   mechanical in this system ranks, flags, records, or rations — it never
   decides, hides an option, or asserts a conclusion. Where a mechanical
   signal disagrees with a seat, that is a question put to a seat.
2. **No silent caps, gates, or refusals.** Every bound states what it
   withheld. A check that did not run must never read as one that passed —
   an empty result may mean "never ran", and no completion signal is trusted
   (exit 0 has lied here before).
3. **Never cut judged text short.** No truncation on any judged path
   (shipped: `9299df3`); correctness beats speed and cost; no wall-clock
   deadline substitutes for judged liveness.
4. **Corrections show BOTH.** When a proposal reverses an earlier round's
   decision, it marks the reversal explicitly (SUPERSEDED: …) next to what
   must survive — never a silent rewrite. Recommending with a reason is
   welcome; withholding the alternative is not.
5. **The loop writes the tests too.** Every task's plan carries test
   requirements the executor implements, and the reviewer still writes its
   own independent tests — no wave grades its own homework.
6. **Surface owner decisions; record assumptions.** A question about product
   intent that the arbiter cannot ground in `project.md` or the constitution
   is answered conservatively AND recorded in the converged artifact under an
   `## Assumptions` section, so the owner sees every decision taken on their
   behalf. Their decisions are surfaced with a recommendation, never taken.
7. **Repair until it works.** Malformed artifacts, contradictions, and cycles
   are fed back to the seats with the error verbatim; refusal is reserved for
   a seat that did not run.
8. **Depth over breadth — and the model knows it can fetch.** Rations (the
   repo map) always say the tail is reachable and how.

Alignment notes, not new work: "watch, nudge, change approach after 3 rounds"
is exactly the shipped circling window (measured trigger, judged meaning);
"launchFailed means no review happened" and "never mutate a live loop tree"
are shipped uroboros law. EULR-specific instructions (admin-mode engine, no
guest access, launcher/Ollama/browser-suite traps, no pie charts) do NOT enter
uroboros core: they are exactly what `constitution.md` is for — the operator
seeds EULR's constitution from Standing Instructions, and every tier quotes
it. Uroboros never generates or edits a constitution.

## Determinism and caps audit (every mechanical element, named)

| Element | Class | Why it is not a decision |
|---|---|---|
| Repo-map budget (`--map-budget`) | input ration | Operator-set, self-declaring, fetch-past-able; no fixed internal counts |
| Topological task ordering | bookkeeping | Serializes the seats' own declared order; cycles go back as feedback |
| Write-once artifacts (`wx`) | safety | Protects prior judgements from silent overwrite; collision is loud |
| Tag parsing (`GOALS_JSON` …) | availability | Malformed goes back as feedback; only a seat that never ran is unavailable |
| Circling window (3 rounds) | measured trigger | Starts a judgement (pivot), never renders one |
| Acceptance/landing "no readable boolean" | fail-closed reading | Absence of consent is never consent; stops, never passes |
| Stage liveness | measured, judged | Silence is judged alive-or-stuck; extensions judged; no flat deadline |
| `rounds`, `max-runs`, `token-budget` | operator's own caps | Set by the owner, forecast declared, run-in-flight always finishes |
| `MINIMUM_MAP_BUDGET` rejection | derived validation | Below it no honest self-declaration fits; derived from the map's own smallest renders, never guessed |
| Repo-map fallback ladder (incl. no-survey path) | input ration | Every return path measured against the actual budget, success and failure alike; nothing assumed to fit |
| Acceptance partial-trail / unreadable-log / empty-queue refusals | fail-closed reading | A landed row missing its commit, an unreadable queue-log, or zero queued units refuse the judgement; never judge blind, never vacuously accept |
| Tier-1 forward-dependency/cycle checks; tier-2 duplicate-section check | bookkeeping | Contradictions inside an artifact that arrived go back as feedback; never silently reordered, merged, or refused |
| Root-commit empty-tree diff base | bookkeeping | Git's empty-tree sentinel stands in for a nonexistent parent so a goal whose earliest landed commit is the repo's root is still diffable and judgeable |

Nothing else mechanical exists in this design. Any future bound must join this
table with its class and its self-declaration, or it does not ship.

## Global constraints (inherited, non-negotiable)

Zero runtime dependencies · Node ≥ 24 · no determinism anywhere a decision is
made (evidence deterministic, decisions judged) · write-once artifacts ·
scratch-root safety rules · closed event vocabulary · commit style with
Co-Authored-By and Claude-Session trailers · `FINDINGS-2026-08-27-performance.md`
stays out of commits.
