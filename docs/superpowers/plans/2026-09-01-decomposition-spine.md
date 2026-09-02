# Decomposition Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project → goals → tasks decomposition above the proven loop: a repo-map ration, one conversation engine shared with `loop plan`, `loop decompose` tiers 1 and 2, and Claude's goal-acceptance review — per the approved spec `docs/superpowers/specs/2026-09-01-decomposition-spine-design.md`.

**Architecture:** Extract `runPlan`'s storm→propose→review→agree→pivot loop into `src/conversation.js` (tier-agnostic engine; `runPlan` becomes a thin wrapper, all existing tests stay green). `src/decompose.js` adds two more wrappers (tier 1 project→goals, tier 2 goal→tasks) with spec-kit-shaped write-once artifacts. `src/repo-map.js` rations input context with a single declared operator budget. The queue gains `--accept-goal`: Claude reads the goal's aggregate diff first-hand before a goal counts as achieved.

**Tech Stack:** Node ≥ 24 stdlib only (zero runtime dependencies), `node:test`, existing uroboros modules (`plan.js`, `arbiter.js`, `queue.js`, `queue-runtime.js`, `events.js`, `spawn.js`).

## Global Constraints (from the spec — every task inherits these)

- **Zero runtime dependencies.** Node ≥ 24. `node --test` is the suite.
- **No determinism anywhere a decision is made.** Mechanical elements may rank/flag/record/ration only, and each must appear in the spec's determinism-and-caps audit table. Malformed seat output is fed back verbatim (repairable), never refused; only a seat that did not run is unavailable. Cycles are contradictions → feedback.
- **No silent caps.** Every bound states what it withheld. The repo map self-declares grade, omissions, and fetchability. Judged text is never truncated.
- **Write-once artifacts** (`wx` flag). Collision = loud error.
- **Closed event vocabulary.** No new stages/pairs: decompose reports through the `plan` stage with payload field `tier: 'project' | 'goal'` (`loop plan` = `'plan'`); acceptance through existing `arbiter` pairs.
- **`CONVERSATION_DNA`** preamble (Task 2, verbatim from the spec's Standing DNA section) goes into every tier's drafting/proposing/reviewing/agreement prompts.
- **Counterfactual discipline:** every new rule gets a sabotage script with an applied-guard (`exit 9` if the mutation did not verifiably land) proving the suite goes red. CF scripts live in the session scratchpad, run-and-restore, never committed.
- **Commits:** one per task, message style below, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01FrSRummkKu9FoqnMkGqmow`. Never `git add` `FINDINGS-2026-08-27-performance.md` (use `git add -A ':!FINDINGS-2026-08-27-performance.md'` or explicit paths).
- **Hermetic tests never launch a real CLI.** Follow `plan.test.js`'s seam: injecting `adapters.draft` marks a conversation hermetic; production seats resolve only when no test adapter is injected.
- Full suite green before every commit: `node --test` → `pass N, fail 0` (baseline 826 at `c5f6e08`).

## File Structure

| File | Responsibility |
|---|---|
| Create `src/repo-map.js` | The input ration: self-declaring repo survey under one budget |
| Create `src/conversation.js` | Tier-agnostic conversation engine + `CONVERSATION_DNA` |
| Modify `src/plan.js` | `runPlan` re-based on the engine; prompt builders exported for reuse |
| Create `src/decompose.js` | Tier strategies, artifact parsers/writers, `runDecomposeGoal`, `runDecomposeProject` |
| Modify `src/args.js`, `src/cli-help.js`, `bin/loop.js` | `decompose` command; `--accept-goal`, `--map-budget` |
| Create `commands/decompose.md` | Plugin command doc (conformance-tested against CLI_USAGE) |
| Modify `src/arbiter.js` | Request type `acceptance` + `parseAcceptanceJudgement` |
| Modify `src/queue-runtime.js` | `landQueueDiff` returns `{ paths, commit }`; `judgeGoalAcceptance` |
| Modify `src/queue.js` | log `commit` on landed rows; `--accept-goal` flow; stop kind `goal-acceptance` |
| Tests | `test/repo-map.test.js`, `test/conversation.test.js`, `test/decompose.test.js`; extend `test/arbiter.test.js`, `test/queue.test.js`, `test/queue-runtime.test.js`, `test/args.test.js` (if present — else assertions live in the nearest existing suite) |

---

### Task 1: `src/repo-map.js` — the self-declaring input ration

**Files:**
- Create: `src/repo-map.js`
- Test: `test/repo-map.test.js`

**Interfaces:**
- Consumes: `spawnCapture` from `src/spawn.js` (`await spawn(bin, args, {cwd}) → {code, stdout, stderr}`).
- Produces: `export const DEFAULT_MAP_BUDGET = 12_000;` and `export async function buildRepoMap({ target, budget = DEFAULT_MAP_BUDGET, spawn = spawnCapture, readFile = readFileSync }) → Promise<string>`. Later tasks embed the returned string in prompts as `REPO_MAP.md`.

- [x] **Step 1: Write the failing tests**

```js
// test/repo-map.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoMap, DEFAULT_MAP_BUDGET } from '../src/repo-map.js';

function fakeSpawnFor(files) {
  return async (bin, args) => {
    assert.equal(bin, 'git');
    assert.deepEqual(args.slice(-1), ['ls-files']);
    return { code: 0, stdout: `${files.join('\n')}\n`, stderr: '' };
  };
}
const fakeRead = (contents) => (path) => {
  const key = Object.keys(contents).find((name) => path.replaceAll('\\', '/').endsWith(name));
  if (key === undefined) throw new Error(`ENOENT ${path}`);
  return contents[key];
};

test('the map declares its grade, its fetchability, and every omission', async () => {
  const files = ['src/a.js', 'src/b.js', 'docs/c.md'];
  const map = await buildRepoMap({
    target: 'T', budget: DEFAULT_MAP_BUDGET,
    spawn: fakeSpawnFor(files),
    readFile: fakeRead({ 'src/a.js': 'export function alpha() {}\n', 'src/b.js': 'x\n', 'docs/c.md': '# c\n' }),
  });
  assert.match(map, /heuristic file\/symbol survey, not the repository/);
  assert.match(map, /may read any file directly/i);
  assert.match(map, /src\/a\.js \(1 lines?\)/);
  assert.match(map, /alpha/);
  assert.doesNotMatch(map, /and \d+ more files/, 'nothing was withheld, so nothing claims to be');
});

test('a trimming budget names exactly what it withheld — never a silent cap', async () => {
  const files = Array.from({ length: 400 }, (_, i) => `src/mod${String(i).padStart(3, '0')}.js`);
  const contents = Object.fromEntries(files.map((f) => [f, 'export const x = 1;\n'.repeat(3)]));
  const map = await buildRepoMap({
    target: 'T', budget: 1200, spawn: fakeSpawnFor(files), readFile: fakeRead(contents),
  });
  assert.ok(map.length <= 1200, `map ${map.length} exceeds its declared budget`);
  assert.match(map, /and \d+ more files under src/, 'the trim must be named');
  assert.match(map, /may read any file directly/i, 'fetchability survives trimming');
});

test('outside a git repository the map says so instead of pretending', async () => {
  const map = await buildRepoMap({
    target: 'T', spawn: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    readFile: fakeRead({}),
  });
  assert.match(map, /not a git repository/i);
  assert.match(map, /no file survey was produced/i);
});
```

- [x] **Step 2: Run to verify failure**

Run: `node --test test/repo-map.test.js`
Expected: FAIL — `Cannot find module '../src/repo-map.js'`.

- [x] **Step 3: Implement**

```js
// src/repo-map.js
// The input ration for big-tree conversations. It rations INPUT context only
// (never seat output), carries a single operator-set budget as its only bound,
// and DECLARES ITSELF: grade, omissions, fetchability. A bound that hides
// what it withheld is a defect.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCapture } from './spawn.js';

export const DEFAULT_MAP_BUDGET = 12_000;

const SYMBOL_PATTERN = /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=|def\s+([A-Za-z_]\w*)\s*\()/;
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py']);

const HEADER = [
  '# Repository map (heuristic file/symbol survey, not the repository)',
  '',
  'This is a RATION, not a wall: you may read any file directly for the whole',
  'truth. File list from `git ls-files`; line counts read; symbols regex-scanned.',
  '',
].join('\n');

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

function scanSymbols(text) {
  const symbols = [];
  for (const line of text.split('\n')) {
    const match = SYMBOL_PATTERN.exec(line);
    const name = match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4];
    if (name) symbols.push(name);
  }
  return symbols;
}

export async function buildRepoMap({
  target,
  budget = DEFAULT_MAP_BUDGET,
  spawn = spawnCapture,
  readFile = readFileSync,
} = {}) {
  const ls = await spawn('git', ['-C', target, 'ls-files']);
  if (ls.code !== 0) {
    return `${HEADER}${(ls.stderr || 'git ls-files failed').trim()} — no file survey was produced; explore the directory directly.\n`;
  }
  const paths = ls.stdout.split(/\r?\n/).filter(Boolean);
  const entries = paths.map((path) => {
    let lines = null;
    let text = null;
    try {
      text = String(readFile(join(target, path)));
      lines = text.split('\n').length;
    } catch { /* unreadable stays null — declared below, never invented */ }
    return { path, lines, text };
  });

  // Directory-grouped file listing, then symbol scans largest-first, appended
  // while the budget holds. Whatever does not fit is COUNTED and NAMED.
  const byDirectory = new Map();
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/');
    const directory = slash === -1 ? '.' : entry.path.slice(0, slash);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(entry);
  }

  const lines = [HEADER, '## Files', ''];
  const omitted = new Map();
  const reserve = 400; // space kept for omission notes + symbols header — itself declared: notes always fit.
  let spent = lines.join('\n').length;
  for (const [directory, group] of [...byDirectory.entries()].sort()) {
    const heading = `### ${directory}/`;
    if (spent + heading.length + 1 > budget - reserve) {
      omitted.set(directory, group.length);
      continue;
    }
    lines.push(heading);
    spent += heading.length + 1;
    for (const entry of group) {
      const row = `- ${entry.path} (${entry.lines ?? 'unreadable'} lines)`;
      if (spent + row.length + 1 > budget - reserve) {
        omitted.set(directory, (omitted.get(directory) ?? 0) + 1);
        continue;
      }
      lines.push(row);
      spent += row.length + 1;
    }
  }

  const largestFirst = entries
    .filter((entry) => entry.text !== null && SOURCE_EXTENSIONS.has(extensionOf(entry.path)))
    .sort((left, right) => (right.lines ?? 0) - (left.lines ?? 0));
  const symbolLines = [];
  let symbolFilesShown = 0;
  for (const entry of largestFirst) {
    const symbols = scanSymbols(entry.text);
    if (symbols.length === 0) continue;
    const row = `- ${entry.path}: ${symbols.join(', ')}`;
    if (spent + row.length + 24 > budget - reserve) break;
    symbolLines.push(row);
    spent += row.length + 1;
    symbolFilesShown++;
  }
  if (symbolLines.length > 0) lines.push('', '## Symbols (largest files first)', ...symbolLines);

  const notes = [];
  for (const [directory, count] of [...omitted.entries()].sort()) {
    notes.push(`… and ${count} more files under ${directory}/ (budget) — read them directly if relevant.`);
  }
  const symbolsSkipped = largestFirst.length - symbolFilesShown;
  if (symbolsSkipped > 0) {
    notes.push(`… symbol scans withheld for ${symbolsSkipped} more files (budget) — read them directly if relevant.`);
  }
  if (notes.length > 0) lines.push('', '## Withheld by the budget', ...notes);
  return `${lines.join('\n')}\n`;
}
```

- [x] **Step 4: Run to verify pass**

Run: `node --test test/repo-map.test.js` → `pass 3, fail 0`. Then full suite: `node --test` → `fail 0`.

- [x] **Step 5: Counterfactual + commit**

CF (scratchpad script, applied-guard `exit 9` if the mutation misses): delete the `## Withheld by the budget` block append (`if (notes.length > 0) …` line) from `src/repo-map.js`, run `node --test --test-name-pattern="names exactly what it withheld" test/repo-map.test.js`, expect FAIL, restore. Then:

```bash
git add src/repo-map.js test/repo-map.test.js
git commit -m "feat(repo-map): self-declaring input ration under one operator budget"
```
(with the standard trailers.)

---

### Task 2: `src/conversation.js` — engine extraction, `runPlan` re-based, `CONVERSATION_DNA`

**Files:**
- Create: `src/conversation.js`
- Modify: `src/plan.js` (lines 745–1180 at `c5f6e08` — `runPlan`'s body)
- Test: `test/conversation.test.js` (new), plus the EXISTING `test/plan.test.js` and `test/events.test.js` must stay green unchanged (that is the extraction's acceptance bar).

**Interfaces:**
- Produces:

```js
export const CONVERSATION_DNA = [
  'Standing law for every seat in this conversation:',
  '1. Determinism advises; the model decides; contradiction asks. Mechanical signals rank, flag, record, or ration — they never decide, hide an option, or assert a conclusion.',
  '2. No silent caps, gates, or refusals. Every bound states what it withheld. A check that did not run must never read as one that passed; an empty result may mean never-ran; trust no completion signal.',
  '3. Never cut judged text short. Correctness beats speed and cost.',
  '4. Corrections show BOTH: when you reverse an earlier round\'s decision, mark it explicitly (SUPERSEDED: ...) beside what must survive — never a silent rewrite. Recommend with a reason; never withhold the alternative.',
  '5. The loop writes the tests too: every task carries test requirements the executor implements, and the reviewer still writes its own independent tests.',
  '6. Surface owner decisions; record assumptions: a product-intent question you cannot ground in the project statement or constitution is answered conservatively AND recorded under an ## Assumptions heading in your artifact.',
  '7. Repair until it works: malformed artifacts, contradictions, and cycles come back to you verbatim as feedback — answer them.',
  '8. Rations (like the repository map) are reachable-past: read any file directly when the survey is not enough.',
].join('\n');

export async function runConversation({
  runId, reporter, rounds, tier,           // tier: 'plan' | 'goal' | 'project'
  seats: { draftCodex, draftCursor, reviewCodex, reviewCursor, arbitrate, checkCapability },
  strategy: {
    draftRequest,       // ({ round, feedback, failedPlan }) → { codexInput, cursorRequest, claudeRequest }
    parseDraft,         // (text) → artifact object; throw Error → that seat's draft failed (availability)
    proposeRequest,     // ({ round, drafts, feedback, questions, previousProposal }) → arbiter request object
    parseProposal,      // (answerText) → proposal object; throw RepairableArtifactError → feedback next round
    reviewRequests,     // ({ round, proposal }) → { codex, cursor } request payloads
    agreementRequest,   // ({ round, proposal, reviews }) → arbiter request object
    capabilityPlanText, // (proposal) → string | null (null skips capability vetoes)
    writeConverged,     // (proposal) → extra result fields; throw RepairableArtifactError → feedback next round
  },
}) → result  // identical shape to today's runPlan finish(): { runId, converged, reason, rounds, storm,
             // roundHistory, capabilityVetoes, pivotHistory, tokens, ...writeConverged fields }
export class RepairableArtifactError extends Error {}
```

- Consumes: nothing new — the engine body IS `runPlan`'s current loop, moved.

- [x] **Step 1: Write the engine contract tests (new behavior only — the repairable-feedback rule)**

```js
// test/conversation.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConversation, RepairableArtifactError, CONVERSATION_DNA } from '../src/conversation.js';

const seatsFor = ({ proposals, agrees = true }) => {
  let proposeCalls = 0;
  const calls = { feedbackSeen: [] };
  return {
    calls,
    seats: {
      draftCodex: async () => 'DRAFT',
      draftCursor: null,
      reviewCodex: async () => ({ agree: agrees, readable: true, suggestions: [], questions: [], content: '' }),
      reviewCursor: async () => ({ agree: agrees, readable: true, suggestions: [], questions: [], content: '' }),
      checkCapability: null,
      arbitrate: async (request) => {
        if (request.type === 'propose') return { verdict: 'answered', answer: proposals[Math.min(proposeCalls++, proposals.length - 1)] };
        if (request.type === 'agreement') return { verdict: 'answered', converged: true, reason: '', feedback: '' };
        return { verdict: 'answered' };
      },
    },
    strategy: {
      draftRequest: ({ feedback }) => { calls.feedbackSeen.push(feedback ?? ''); return { codexInput: 'draft', cursorRequest: null, claudeRequest: null }; },
      parseDraft: (text) => ({ plan: text }),
      proposeRequest: ({ feedback }) => ({ type: 'propose', feedback }),
      parseProposal: (text) => {
        if (text === 'MALFORMED') throw new RepairableArtifactError('GOALS_JSON missing');
        return { plan: text };
      },
      reviewRequests: () => ({ codex: {}, cursor: {} }),
      agreementRequest: () => ({ type: 'agreement' }),
      capabilityPlanText: () => null,
      writeConverged: () => ({ written: true }),
    },
  };
};

test('a malformed proposal is fed back verbatim and repaired next round — never a terminal', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['MALFORMED', 'GOOD'] });
  const proposeFeedback = [];
  const wrapped = { ...strategy, proposeRequest: (ctx) => { proposeFeedback.push(ctx.feedback ?? ''); return { type: 'propose' }; } };
  const result = await runConversation({ runId: 'conv-repair', tier: 'goal', seats, strategy: wrapped });
  assert.equal(result.converged, true);
  assert.equal(result.rounds, 2);
  assert.match(proposeFeedback[1], /GOALS_JSON missing/, 'the parse error reaches the proposer verbatim');
});

test('an unreachable proposer is still terminal — a seat that never ran cannot be repaired', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['unused'] });
  seats.arbitrate = async (request) => request.type === 'propose'
    ? { verdict: 'UNVERIFIED', launchFailed: true }
    : { verdict: 'answered', converged: true };
  const result = await runConversation({ runId: 'conv-down', tier: 'goal', seats, strategy });
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'arbiter-unavailable');
});

test('a repairable writeConverged failure (e.g. a dependency cycle) loops as feedback', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD', 'GOOD'] });
  let writes = 0;
  strategy.writeConverged = () => {
    writes++;
    if (writes === 1) throw new RepairableArtifactError('T2 and T4 depend on each other — resolve or merge them');
    return { written: true };
  };
  const seen = [];
  strategy.proposeRequest = (ctx) => { seen.push(ctx.feedback ?? ''); return { type: 'propose' }; };
  const result = await runConversation({ runId: 'conv-cycle', tier: 'goal', seats, strategy });
  assert.equal(result.converged, true);
  assert.match(seen[1], /depend on each other/);
});

test('the DNA is present and carries the standing law verbatim', () => {
  assert.match(CONVERSATION_DNA, /Determinism advises; the model decides; contradiction asks/);
  assert.match(CONVERSATION_DNA, /SUPERSEDED/);
  assert.match(CONVERSATION_DNA, /Repair until it works/);
});
```

- [x] **Step 2: Run to verify failure** — `node --test test/conversation.test.js` → module not found.

- [x] **Step 3: Extract the engine (the recipe — mechanical, anchored)**

In `src/conversation.js`, define `CONVERSATION_DNA` and `RepairableArtifactError` exactly as in Interfaces. Then MOVE from `src/plan.js` into `runConversation`, verbatim except for the named substitutions: the `ledger`/`usageTotal`/`tallyUsage`/`pivotCount`/histories block (plan.js:807–815), `finish()` (:848–868), `stormOnce` (:874–925 — substitute the three inline prompt/request constructions with `strategy.draftRequest(...)` fields; codex/cursor/claude call sites keep their seat functions from `seats`), `normalizeSeatReview`/`unavailableReview`/`reviewBoth` (:927–977 — request payloads from `strategy.reviewRequests`), and the main `for (round…)` loop (:985–1180) with these substitutions:
  - `arbitrate({type:'propose', …})` → `seats.arbitrate(strategy.proposeRequest({ round, drafts, feedback, questions: openQuestions, previousProposal }))`
  - `normalizeDraft(text)` for the proposal → `strategy.parseProposal(text)` wrapped: `RepairableArtifactError` → set `feedback = error.message; reStorm = false; continue;` (record `{ round, repair: error.message }` into `roundHistory`); any other throw or unreachable seat → `finish('arbiter-unavailable', round)` exactly as today.
  - agreement request construction → `strategy.agreementRequest({ round, proposal, reviews })`.
  - `capabilityVetoes({ plan: proposal.plan, … })` → gated on `strategy.capabilityPlanText(proposal)` returning non-null, which supplies the text.
  - `writeArtifacts(request.out, proposal.plan, proposal.gate)` → `const extra = strategy.writeConverged(proposal)` with `RepairableArtifactError` → feedback-and-continue (same as parseProposal), success → `finish('converged', round, extra)`.
  - Every `reportEvent(reporter, runId, 'plan', <type>, {…})` gains `tier` in its payload.
`runPlan` keeps: validation, superpowers preflight, seat resolution (hermetic seam untouched: `adapters.draft` marks hermetic), dry-run, and then delegates to `runConversation` with `tier: 'plan'` and a strategy built from its existing prompt builders (`draftingPrompt`, review prompts, `parseDraftArtifact` as both `parseDraft` and `parseProposal` — with `parseProposal` throwing `RepairableArtifactError` for tag/JSON problems, plain `Error` reserved for empty output) and `writeConverged: (proposal) => writeArtifacts(request.out, proposal.plan, proposal.gate)`. Prepend `CONVERSATION_DNA` to every prompt builder's output in `plan.js`.

- [x] **Step 4: Run to verify pass** — `node --test test/conversation.test.js test/plan.test.js test/events.test.js` → `fail 0`, then full `node --test` → `fail 0` (existing plan tests green is the extraction's bar; if a plan test pinned malformed-proposal→arbiter-unavailable, update THAT test to the repairable contract and say so in the commit body).

- [x] **Step 5: Counterfactual + commit** — CF: in `conversation.js`, change the `RepairableArtifactError` catch to `return finish('arbiter-unavailable', round)`; expect `test/conversation.test.js` FAIL (repair test); restore. Commit `feat(conversation): extract the tier-agnostic engine; malformed artifacts repair, never refuse`.

---

### Task 3: Tier 2 — `runDecomposeGoal` (goal → task units)

**Files:**
- Create: `src/decompose.js`
- Test: `test/decompose.test.js`

**Interfaces:**
- Consumes: `runConversation`, `CONVERSATION_DNA`, `RepairableArtifactError` (Task 2); `buildRepoMap` (Task 1); from `plan.js`: the production seat runners it already exports/uses (`productionDraft` pattern via `runExecutor`, `runVerifier`, `runArbiter`, `withSeatWorkspace` — export `withSeatWorkspace` from `plan.js` if not already exported); `verifySuperpowersSeats`/`applySuperpowersRequirement`; `parseSeatReview` (export from `plan.js`).
- Produces: `export async function runDecomposeGoal({ goalSpecPath, target, rounds, mapBudget, plannerModel, verifierModel, arbiterModel, runId, reporter, env, home, superpowers, adapters = {} }) → result` (engine result shape + `{ queuePath, taskPaths: [{ plan, gate }] }` on converged). Artifact contracts verbatim from the spec:
  - proposal = `<TASKS_JSON>[{ id, name, dependsOn, gate: [{bin,args}…] }…]</TASKS_JSON>` + `<TASKS_MD>` with one `## T<n>: <title>` section per task;
  - writer emits, in the goal directory (`dirname(goalSpecPath)`): `tasks/queue.json` (units `{ name, task: 'T<n>-plan.md', gate: 'T<n>-gate.json' }` topologically ordered from `dependsOn`), `tasks/T<n>-plan.md` (the section body verbatim), `tasks/T<n>-gate.json` — ALL with `{ flag: 'wx' }`;
  - cycle in `dependsOn` → `throw new RepairableArtifactError('T<a> and T<b> depend on each other — resolve or merge them')` (the engine loops it as feedback);
  - id mismatch between JSON and MD, missing tags, bad JSON → `RepairableArtifactError` with the exact problem text.
- Tier-2 prompts (all prefixed with `CONVERSATION_DNA`, the constitution's text when `<goalDir>/../../constitution.md` exists, and `REPO_MAP.md` content): drafting asks each seat to break THIS goal (spec text included verbatim) into tasks obeying the tier-2 incremental law quoted verbatim from the spec ("every task is a self-contained increment of the GOAL — runnable and testable alone, exactly one capability"), each `## T<n>` section carrying the same headings `loop plan` demands (Title, Required behavior, Invariants, Test requirements, Out of scope), `gate` as evidence commands with the standard no-verdict sentence. Reviews and agreement reuse the planning contract (`AGREE:`/`S<id>`/`Q<id>`), pinned to THIS goal spec.
- Hermetic seam: `adapters.draft` injected marks hermetic exactly as `runPlan`.

- [x] **Step 1: Failing tests**

```js
// test/decompose.test.js  (fixtures mirror plan.test.js's hermetic style)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDecomposeGoal } from '../src/decompose.js';
import { VERIFIED_SUPERPOWERS } from '../fixtures/verified-superpowers.mjs';

function goalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'decomp-'));
  const goalDir = join(root, 'uro-project', 'goals', 'G1-demo');
  mkdirSync(goalDir, { recursive: true });
  const specPath = join(goalDir, 'spec.md');
  writeFileSync(specPath, '# G1: demo goal\nDeliver the demo capability.\n');
  return { root, goalDir, specPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const proposalText = (tasksJson, tasksMd) => `<TASKS_JSON>${JSON.stringify(tasksJson)}</TASKS_JSON>\n<TASKS_MD>${tasksMd}</TASKS_MD>`;
const goodTasks = [
  { id: 'T1', name: 'T1-first', dependsOn: [], gate: [{ bin: 'node', args: ['--test'] }] },
  { id: 'T2', name: 'T2-second', dependsOn: ['T1'], gate: [{ bin: 'node', args: ['--test'] }] },
];
const goodMd = '## T1: first\nTitle: first\nRequired behavior: A.\nTest requirements: t.\n\n## T2: second\nTitle: second\nRequired behavior: B.\nTest requirements: t.\n';

function adaptersFor(proposals) {
  let call = 0;
  return {
    draft: async () => '<TASKS_JSON>[]</TASKS_JSON>\n<TASKS_MD></TASKS_MD>',
    review: async () => ({ agree: true, readable: true, suggestions: [], questions: [], content: '' }),
    codexReview: async () => ({ agree: true, readable: true, suggestions: [], questions: [], content: '' }),
    runArbiter: async ({ request }) => request.type === 'propose'
      ? { verdict: 'answered', answer: proposals[Math.min(call++, proposals.length - 1)] }
      : request.type === 'agreement'
        ? { verdict: 'answered', converged: true, reason: '', feedback: '' }
        : { verdict: 'answered' },
  };
}

test('a converged goal writes topologically ordered task units, write-once', async () => {
  const fixture = goalFixture();
  try {
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-ok',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: adaptersFor([proposalText([goodTasks[1], goodTasks[0]], goodMd)]),
    });
    assert.equal(result.converged, true);
    const queue = JSON.parse(readFileSync(join(fixture.goalDir, 'tasks', 'queue.json'), 'utf8'));
    assert.deepEqual(queue.map((unit) => unit.name), ['T1-first', 'T2-second'],
      'declared order serialized; T1 lands before its dependent');
    assert.match(readFileSync(join(fixture.goalDir, 'tasks', 'T1-plan.md'), 'utf8'), /Required behavior: A/);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.goalDir, 'tasks', 'T2-gate.json'), 'utf8')),
      [{ bin: 'node', args: ['--test'] }]);
    await assert.rejects(() => runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-again',
      superpowers: VERIFIED_SUPERPOWERS, adapters: adaptersFor([proposalText(goodTasks, goodMd)]),
    }), /EEXIST|already exists/i, 'write-once: a second convergence collides loudly');
  } finally { fixture.cleanup(); }
});

test('a dependency cycle goes back as feedback and the repaired round converges', async () => {
  const fixture = goalFixture();
  const cyclic = [
    { id: 'T1', name: 'T1-a', dependsOn: ['T2'], gate: [] },
    { id: 'T2', name: 'T2-b', dependsOn: ['T1'], gate: [] },
  ];
  try {
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-cycle',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: adaptersFor([
        proposalText(cyclic, '## T1: a\nx\n\n## T2: b\nx\n'),
        proposalText(goodTasks, goodMd),
      ]),
    });
    assert.equal(result.converged, true, 'the cycle repaired through feedback, not refusal');
    assert.equal(result.rounds, 2);
  } finally { fixture.cleanup(); }
});

test('mismatched ids are fed back verbatim, not terminal', async () => {
  const fixture = goalFixture();
  try {
    const result = await runDecomposeGoal({
      goalSpecPath: fixture.specPath, target: fixture.root, runId: 'd2-ids',
      superpowers: VERIFIED_SUPERPOWERS,
      adapters: adaptersFor([
        proposalText(goodTasks, '## T1: only one section\nx\n'),
        proposalText(goodTasks, goodMd),
      ]),
    });
    assert.equal(result.converged, true);
    assert.equal(result.rounds, 2);
  } finally { fixture.cleanup(); }
});
```

- [x] **Step 2: Run to verify failure** — module not found.
- [x] **Step 3: Implement** `src/decompose.js`. The two load-bearing helpers, complete:

```js
export function parseTaggedPair(text, { jsonTag, mdTag, idPattern }) {
  const source = String(text ?? '');
  const jsonText = new RegExp(`<${jsonTag}>\\s*([\\s\\S]*?)\\s*</${jsonTag}>`, 'i').exec(source)?.[1];
  const mdText = new RegExp(`<${mdTag}>\\s*([\\s\\S]*?)\\s*</${mdTag}>`, 'i').exec(source)?.[1];
  if (jsonText === undefined || mdText === undefined) {
    throw new RepairableArtifactError(`missing <${jsonTag}> or <${mdTag}> tags — return both, exactly once`);
  }
  let items;
  try { items = JSON.parse(jsonText); } catch (error) {
    throw new RepairableArtifactError(`<${jsonTag}> is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new RepairableArtifactError(`<${jsonTag}> must be a non-empty array`);
  }
  const sections = new Map();
  const heading = new RegExp(`^## (${idPattern}):[^\\n]*$`, 'gm');
  const matches = [...mdText.matchAll(heading)];
  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : mdText.length;
    sections.set(match[1], mdText.slice(start, end).trim());
  }
  const jsonIds = items.map((item) => String(item.id));
  const missing = jsonIds.filter((id) => !sections.has(id));
  const extra = [...sections.keys()].filter((id) => !jsonIds.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new RepairableArtifactError(
      `id mismatch between ${jsonTag} and ${mdTag}: missing sections [${missing}], unmatched sections [${extra}]`);
  }
  return { items, sections };
}

export function topologicalOrder(tasks) {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn ?? [])]));
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) =>
      [...deps].every((dep) => !remaining.has(dep))).map(([id]) => id);
    if (ready.length === 0) {
      const [a, b] = [...remaining.keys()];
      throw new RepairableArtifactError(`${a} and ${b} depend on each other — resolve or merge them`);
    }
    for (const id of ready) { ordered.push(tasks.find((task) => task.id === id)); remaining.delete(id); }
  }
  return ordered;
}
```

Then: `writeTier2Artifacts(goalDir, { items, sections })` writes `tasks/T<n>-plan.md` (section body verbatim), `tasks/T<n>-gate.json` (`JSON.stringify(item.gate, null, 2)`), and `tasks/queue.json` from `topologicalOrder(items)` — every write `{ flag: 'wx' }`; tier-2 prompt builders (CONVERSATION_DNA + constitution file content when `join(goalDir, '..', '..', 'constitution.md')` exists + `await buildRepoMap({ target, budget: mapBudget })` + the goal spec text verbatim + the tier-2 incremental law quoted verbatim from the spec); seat resolution copied from `runPlan`'s block (hermetic on `adapters.draft`); delegate to `runConversation({ tier: 'goal', … })` with `parseProposal: (text) => parseTaggedPair(text, { jsonTag: 'TASKS_JSON', mdTag: 'TASKS_MD', idPattern: 'T\\d+' })` and `writeConverged` calling `writeTier2Artifacts`.
- [x] **Step 4: Run to verify pass** — `node --test test/decompose.test.js` → `fail 0`; full suite `fail 0`.
- [x] **Step 5: CF + commit** — CF: make `topologicalOrder` silently drop cycle edges instead of throwing (guarded mutation); expect the cycle test FAIL (converges in 1 round); restore. Commit `feat(decompose): tier 2 — a goal converges into write-once task units`.

---

### Task 4: `decompose` CLI (tier 2 wiring)

**Files:**
- Modify: `src/cli-help.js` (CLI_COMMANDS + usage line), `src/args.js` (new command block after the `plan` block at :251), `bin/loop.js` (dispatch after the `plan` branch at :92)
- Create: `commands/decompose.md`
- Test: extend `test/decompose.test.js` (args parsing via `parseArgs` from `src/args.js`), and the existing `test/plugin-packaging.test.js` conformance must pass.

**Interfaces:**
- `parseArgs(['decompose','--goal',p,'--target',t])` → `{ command:'decompose', mode:'goal', goal:p, target:t, mapBudget:12000, … }`; `--project`+`--out` → `mode:'project'` (Task 5 uses it; parse it now, and `bin/loop.js` answers `decompose --project` with `process.stderr.write('decompose --project ships in the next increment\n'); process.exitCode = 2;` until Task 5 replaces that branch — stated in help as such). Exactly one of `--goal`/`--project` required; `--out` required with `--project`, forbidden with `--goal`; `--map-budget` positive int, default 12000; `--rounds`, model flags mirror `plan`.
- `bin/loop.js` `decompose --goal` branch mirrors the `plan` branch (:92–119): stderr event reporter, `runDecomposeGoal(...)`, JSON result to stdout, exit 1 unless converged, 2 on throw.
- `cli-help.js` Commands line: `  decompose  Debate a project into goals, or one goal into loop-ready task units.` and `commands/decompose.md` front-matter description IDENTICAL to that line's text (the packaging test enforces it).

- [x] **Step 1: Failing tests** — add to `test/decompose.test.js`:

```js
import { parseArgs } from '../src/args.js';
test('decompose args: goal mode', () => {
  const opts = parseArgs(['decompose', '--goal', 'g/spec.md', '--target', '.', '--map-budget', '5000']);
  assert.deepEqual({ command: opts.command, mode: opts.mode, goal: opts.goal, mapBudget: opts.mapBudget },
    { command: 'decompose', mode: 'goal', goal: 'g/spec.md', mapBudget: 5000 });
});
test('decompose args: exactly one of --goal/--project', () => {
  assert.throws(() => parseArgs(['decompose', '--target', '.']), /--goal or --project/);
  assert.throws(() => parseArgs(['decompose', '--goal', 'a', '--project', 'b', '--target', '.']), /--goal or --project/);
  assert.throws(() => parseArgs(['decompose', '--goal', 'a', '--target', '.', '--out', 'o']), /--out/);
});
```

- [x] **Step 2: Verify failure** (unknown command). **Step 3: Implement** the three files + `commands/decompose.md` (front matter `description:` = the Commands line text; body: one paragraph on the two modes + the no-verdict evidence sentence). **Step 4:** `node --test test/decompose.test.js test/plugin-packaging.test.js` → `fail 0`; full suite `fail 0`. **Step 5:** Commit `feat(cli): loop decompose --goal`.

---

### Task 5: Tier 1 — `runDecomposeProject` (project → goals)

**Files:**
- Modify: `src/decompose.js`, `bin/loop.js` (replace the Task-4 `--project` stub branch)
- Test: extend `test/decompose.test.js`

**Interfaces:**
- Produces: `export async function runDecomposeProject({ project, target, out, rounds, mapBudget, …, adapters }) → result` + on converged `{ manifestPath, goalDirs: [...] }`.
- Artifacts verbatim from the spec: `--out` dir gains `project.md` (input verbatim — file content if the value names an existing file, else the prose), optional pre-existing `constitution.md` untouched and quoted in prompts, `goals/goals.json` manifest `[{ id, slug, statement, capability, dependsOn, rationale }]`, `goals/G<n>-<slug>/spec.md` from `<GOALS_MD>` sections `## G<n>: <title>`. All `wx`. Goal-level `dependsOn` advisory (no runtime enforcement). Cycle/mismatch/missing-tag → `RepairableArtifactError` (same helpers as tier 2, reused — DRY: generalize `parseTaggedPair(text, jsonTag, mdTag, idPattern)` used by both tiers).
- Tier-1 prompts: DNA + constitution + repo map + project statement verbatim + the tier-1 incremental law quoted verbatim from the spec ("every goal is a self-contained increment of the PROJECT … MVP-first: goal 1 is the smallest true version of the whole project. No goal depends on a later goal.").

- [x] **Step 1: Failing tests** — three tests, same shapes as Task 3 but tier 1 (the collision and cycle tests repeat Task 3's structure with these fixtures). The converged-path test, complete:

```js
const goalProposal = () => `<GOALS_JSON>${JSON.stringify([
  { id: 'G1', slug: 'mvp', statement: 'Smallest true version.', capability: 'runs end to end', dependsOn: [], rationale: 'MVP-first' },
  { id: 'G2', slug: 'reports', statement: 'Add reporting.', capability: 'reports', dependsOn: ['G1'], rationale: 'builds on G1' },
])}</GOALS_JSON>\n<GOALS_MD>## G1: mvp\nDeliver the smallest true version.\n\n## G2: reports\nAdd reporting on top of G1.\n</GOALS_MD>`;

test('a converged project writes the manifest and per-goal specs verbatim, write-once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'decomp1-'));
  try {
    const out = join(root, 'uro-project');
    const result = await runDecomposeProject({
      project: 'Build the demo product.', target: root, out, runId: 'd1-ok',
      superpowers: VERIFIED_SUPERPOWERS, adapters: adaptersFor([goalProposal()]),
    });
    assert.equal(result.converged, true);
    assert.equal(readFileSync(join(out, 'project.md'), 'utf8'), 'Build the demo product.\n');
    const manifest = JSON.parse(readFileSync(join(out, 'goals', 'goals.json'), 'utf8'));
    assert.deepEqual(manifest.map((goal) => goal.id), ['G1', 'G2']);
    assert.match(readFileSync(join(out, 'goals', 'G1-mvp', 'spec.md'), 'utf8'),
      /Deliver the smallest true version\./);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```
- [x] **Step 2:** verify failure. **Step 3:** implement via the shared `parseTaggedPair` + `writeTier1Artifacts`; wire the real `--project` branch in `bin/loop.js`. **Step 4:** targeted + full suite `fail 0`. **Step 5:** CF: sabotage the slug/section writer to drop the `## Assumptions`-carrying section body (write titles only) → the verbatim-spec test FAILS; restore. Commit `feat(decompose): tier 1 — a project converges into an MVP-first goal manifest`.

---

### Task 6: Arbiter `acceptance` judgement

**Files:**
- Modify: `src/arbiter.js` (prompt type + parser), Test: extend `test/arbiter.test.js`

**Interfaces:**
- `buildArbiterPrompt({ type: 'acceptance', goalSpec, constitution, diff, queueLog })` — prompt text: read the goal spec and the AGGREGATE diff of every landed task first-hand; the question is "is the project in a working state that now delivers this goal's capability?"; schema `{"approved":true|false,"reasoning":"…","findings":[{"id":"A1","severity":"…","text":"…"}]}`; severities the arbiter's own words, nothing mechanical acts on them; sections `GOAL_SPEC`, `CONSTITUTION` (when non-empty), `AGGREGATE_DIFF`, `QUEUE_LOG`.
- `export function parseAcceptanceJudgement(response)` — exactly `parseLandingJudgement`'s contract (approved boolean required else `{verdict:'UNVERIFIED'}`; findings carried verbatim; returns `{verdict:'answered', approved, reasoning, findings}`). Reuse by delegation: `export const parseAcceptanceJudgement = parseLandingJudgement;` is acceptable ONLY if the landing parser has no landing-specific wording; it does not — delegate and re-export.

- [x] **Step 1: Failing tests** (extend `test/arbiter.test.js`):

```js
test('the acceptance prompt asks the working-state question with spec, diff, and log in front of Claude', () => {
  const prompt = buildArbiterPrompt({ type: 'acceptance', goalSpec: 'G1 spec text',
    constitution: 'law text', diff: 'diff --git a/x b/x', queueLog: [{ name: 'T1', landed: true }] });
  assert.match(prompt, /working state that now delivers/);
  assert.match(prompt, /"approved":true\|false/);
  assert.match(prompt, /GOAL_SPEC G1 spec text/);
  assert.match(prompt, /CONSTITUTION law text/);
  assert.match(prompt, /AGGREGATE_DIFF diff --git a\/x b\/x/);
  assert.match(prompt, /QUEUE_LOG \[/);
});
test('acceptance parsing: silence is never consent', () => {
  assert.equal(parseAcceptanceJudgement({ answer: 'ship it' }).verdict, 'UNVERIFIED');
  assert.deepEqual(parseAcceptanceJudgement({ approved: false, reasoning: 'G1 capability absent' }),
    { verdict: 'answered', approved: false, reasoning: 'G1 capability absent', findings: [] });
});
```

- [x] **Steps 2–5:** fail → implement (`if (request.type === 'acceptance') { … }` beside the `landing` block; omit the CONSTITUTION line when empty) → targeted + full suite green → commit `feat(arbiter): goal-acceptance judgement`.

---

### Task 7: Queue — landed commit SHAs, `--accept-goal`, stop kind `goal-acceptance`

**Files:**
- Modify: `src/queue-runtime.js` (`landQueueDiff` returns `{ paths, commit }` — after the `git commit` at :278–284 run `git rev-parse HEAD` via `gitCommand` and include it; add `judgeGoalAcceptance({ goalSpecPath, target, logPath }, { arbiter = runArbiter, runCommand = spawnCapture })` → reads the goal spec + optional sibling `../../constitution.md`, reads the log rows for landed units (each now carrying `commit`), base = `<earliest landed commit>^`, `git -C target diff <base>..HEAD`, builds `{type:'acceptance', …}`, parses with `parseAcceptanceJudgement`, returns `{ approved, reasoning, findings, usage }` — `usage` from the arbiter result (`EMPTY_USAGE` on throw) — with `approved: null` on throw/UNVERIFIED); wire `acceptGoal: (request) => judgeGoalAcceptance(request, options)` into `createQueueRuntime`.
- Modify: `src/queue.js` — landed log rows gain `commit: landing.commit`; `runQueue` accepts `acceptGoal` dependency + `acceptGoalSpec` option; after the unit loop, when `acceptGoalSpec` is set AND `stop === null` AND every unit of this queue file shows landed in the log: run acceptance; approved → append `{ goalAcceptance: {...}, tokens: <acceptance usage> }` log line + summary line, and add the acceptance usage to `totalTokens` (the taxi meter runs whether or not you arrive — spec requirement); refused/null → `stop = { kind: 'goal-acceptance', reason: approved === false ? 'Claude refused the goal: <reasoning>' : "Claude's goal acceptance was unavailable — a goal is never achieved unseen: <reasoning>" }` (also logged). Landed commits are never rolled back.
- Modify: `src/args.js` queue block (:220) `'accept-goal': { type: 'string' }` → `acceptGoalSpec`; `src/queue-cli.js` passes it through; `src/cli-help.js` queue usage line gains `[--accept-goal <spec.md>]`.
- Test: extend `test/queue.test.js` + `test/queue-runtime.test.js`.

**Interfaces:** consumes Task 6's `parseAcceptanceJudgement` + `buildArbiterPrompt({type:'acceptance'…})`.

- [x] **Step 1: Failing tests** — `test/queue.test.js` (fakeRuntime gains a default `acceptGoal: async () => ({ approved: true, reasoning: 'goal verified in fixture' })` and captures calls, mirroring the Task-pattern of `judgeLanding` in the same file):

```js
test('with --accept-goal, Claude closes the goal after the last landing and the judgement is logged', async () => {
  const fixture = makeFixture(2);
  try {
    const runtime = fakeRuntime([reviewReady('run-1'), reviewReady('run-2')]);
    const result = await runQueue({ file: fixture.file, target: fixture.target,
      acceptGoalSpec: 'G1/spec.md', dependencies: runtime.dependencies });
    assert.equal(runtime.acceptances.length, 1, 'acceptance runs exactly once, after all landings');
    assert.equal(result.stop, null);
    const log = readLog(fixture.logPath);
    assert.equal(log.at(-1).goalAcceptance.approved, true);
    assert.ok(log[0].commit, 'landed rows carry their commit SHA');
  } finally { fixture.cleanup(); }
});
test('a refused goal acceptance stops with kind goal-acceptance and rolls nothing back', async () => {
  const fixture = makeFixture(1);
  try {
    const runtime = fakeRuntime([reviewReady('run-1')], {
      acceptGoal: async () => ({ approved: false, reasoning: 'capability incomplete' }) });
    const result = await runQueue({ file: fixture.file, target: fixture.target,
      acceptGoalSpec: 'G1/spec.md', dependencies: runtime.dependencies });
    assert.equal(runtime.landings.length, 1, 'the landing already happened and stays');
    assert.equal(result.stop.kind, 'goal-acceptance');
    assert.match(result.stop.reason, /capability incomplete/);
  } finally { fixture.cleanup(); }
});
test('an unavailable goal acceptance never marks a goal achieved', async () => {
  const fixture = makeFixture(1);
  try {
    const runtime = fakeRuntime([reviewReady('run-1')], {
      acceptGoal: async () => { throw new Error('claude unreachable'); } });
    const result = await runQueue({ file: fixture.file, target: fixture.target,
      acceptGoalSpec: 'G1/spec.md', dependencies: runtime.dependencies });
    assert.equal(result.stop.kind, 'goal-acceptance');
    assert.match(result.stop.reason, /never achieved unseen/);
  } finally { fixture.cleanup(); }
});
test('without --accept-goal the queue behaves exactly as before', async () => {
  const fixture = makeFixture(1);
  try {
    const runtime = fakeRuntime([reviewReady('run-1')]);
    const result = await runQueue({ file: fixture.file, target: fixture.target,
      dependencies: runtime.dependencies });
    assert.equal(runtime.acceptances.length, 0);
    assert.equal(result.stop, null);
  } finally { fixture.cleanup(); }
});
```

`test/queue-runtime.test.js`: `judgeGoalAcceptance` hands the arbiter spec + constitution + `git diff <first-landed-commit>^..HEAD` output + log rows (fake `runCommand` asserts the exact `git diff` argv), and returns `approved: null` with the error text when the arbiter throws. `landQueueDiff` test extends the existing landing test to assert the returned `commit` matches `git rev-parse HEAD` in the fixture repo.

- [x] **Steps 2–5:** fail → implement → targeted + full `node --test` `fail 0` → CF: change the acceptance gate to `approved !== false` (unavailable-as-consent) with applied guard; expect the unavailable test FAIL; restore → commit `feat(queue): Claude closes every goal — acceptance review with logged commit trail`.

---

### Task 8: Docs + spec audit table + push

**Files:**
- Modify: `docs/usage.md` (decompose section: two modes, artifact layout, `--map-budget` as the audit-table ration, `--accept-goal`; one sentence marking queue `goal` units legacy), `README.md` (hierarchy paragraph: Project → goals → tasks with the three-line diagram from the spec), `skills/uroboros/SKILL.md` (one bullet: decompose + acceptance exist and what they cannot do), spec's audit table gains no rows (verify: no new mechanical element beyond those already listed — if implementation added one, it must join the table in this task or be removed).

- [x] **Step 1:** write the docs. **Step 2:** `node --test` full → `fail 0` (planner-docs/packaging conformance included). **Step 3:** commit `docs: decomposition spine — decompose, acceptance, and the caps audit`. **Step 4:** `git push origin main`, verify `git log --oneline -8` shows Tasks 1–8.

---

## Execution order & checkpoints

Tasks 1→8 strictly in order (each consumes the previous Interfaces). Checkpoints after Task 2 (the extraction — highest risk: full suite must be green with plan tests untouched or explicitly re-contracted) and Task 7 (behavioral surface of the queue). Every task ends with the full suite green and its own commit; counterfactual scripts run before the commits they protect.
