# Findings Fix Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open dogfood findings (P2/P3 harness-artifact corruption, F13 lost judge answers + judge context, F12 repair-vs-round budget, F14/F17 invisible judgements, P1/P5/P9 operator truthfulness, P4 stall liveness, P6/P7/P8 environment and docs) with tests pinning each.

**Architecture:** Surgical fixes inside existing modules — no new files except tests. Every honesty-affecting change follows the standing laws: no silent caps (every new bound joins the audit table in `docs/superpowers/specs/2026-09-01-decomposition-spine-design.md`), silence is never consent, raw evidence travels verbatim when a parse fails.

**Tech Stack:** Node built-ins only, `node:test`, zero runtime dependencies.

## Global Constraints

- Zero runtime dependencies; Node built-ins and `node:test` only.
- The full suite (`node --test` from the repo root, currently 889 passing) must stay green after every task.
- Never `git add` `FINDINGS-2026-08-27-performance.md` or `FINDINGS-2026-09-01-dogfood-decompose.md` (use explicit paths in every `git add`).
- Commit trailers, verbatim on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01FrSRummkKu9FoqnMkGqmow`
- Any new bound (retry counts, repair budgets) MUST be added to the determinism-and-caps audit table in `docs/superpowers/specs/2026-09-01-decomposition-spine-design.md` (`| Element | Class | Why it is not a decision |` rows near line 300) — the table's closure clause forbids undeclared bounds.
- New event (stage, type) pairs MUST be added to `LISTED_EVENT_PAIRS` in `src/events.js` AND exercised by a constructed fixture event inside the test `fully exercised runs have exact pair equality with both event vocabularies` in `test/events.test.js` (append to the `allEvents` composition around line 760, following the `verifyRetryEvents` example).
- Mixed-CRLF files (`src/args.js`, `test/args.test.js`, `test/rename.test.js`) require byte-preserving edits: verify `tr -cd '\r' < FILE | wc -c` is unchanged after any edit to them.
- The events console formatter is `detailFor` in `src/events.js`; every new event must render its meaning there (bare stage/type lines are finding F17's disease).

---

### Task 1: Harness artifacts are never "reviewer scope violations" and never pollute the executor's view (P2 Critical + P3)

**Files:**
- Modify: `src/review-protection.js` (runProtectedOperation, ~line 113; snapshot comparison internals above it)
- Modify: `src/run.js` (isolation setup near line 682 where `TASK.md` is written into `iso.dir`)
- Test: `test/review-protection.test.js` (exists — extend), `test/run.test.js` or the isolation test file that covers `iso.dir` setup (find with `grep -rln "TASK.md" test/`)

**Interfaces:**
- Consumes: `runProtectedOperation({ cwd, scope, prefix, stage, role, runId, reporter, operation, ... })` — restores post-operation worktree changes and reports `scope_violation` events (review-protection.js:113-152).
- Produces: a module-level exported constant `HARNESS_ARTIFACTS_PATTERNS` in `src/review-protection.js` — an array of relative-path predicates the snapshot/restore machinery must ignore: `events.jsonl`, `TASK.md`, `CHANGES.diff`, and anything under `__uro_review/`. Task 1 is self-contained; no later task consumes it.

**Background (the bug, from the peer session's live runs):** both observed runs logged `verify/scope_violation restored out-of-scope writes paths=events.jsonl`. `events.jsonl` is the harness's OWN append-only log inside the worktree; attributing it to the reviewer and restoring it rolls back the run record mid-run. Additionally `git status --short` in the worktree shows untracked `TASK.md`/`events.jsonl` the executor did not create, which pollutes its view (P3).

- [ ] **Step 1: Write the failing test for P2** — in `test/review-protection.test.js`, following the file's existing harness style (injected `captureSnapshot`/`restoreSnapshot` or a real temp worktree, whichever the file already uses):

```js
test('harness artifacts are invisible to the scope check', async () => {
  // The operation appends to events.jsonl (as the harness itself does mid-run)
  // and writes a reviewer file under __uro_review/. Neither is a violation;
  // a genuinely out-of-scope write still is.
  const dir = mkdtempSync(join(tmpdir(), 'uro-scope-'));
  writeFileSync(join(dir, 'events.jsonl'), '{"seed":true}\n');
  const events = [];
  const { restoredPaths } = await runProtectedOperation({
    cwd: dir,
    scope: ['**'],
    prefix: 'test-scope',
    stage: 'verify',
    role: 'reviewer',
    runId: 'scope-harness',
    reporter: (event) => events.push(event),
    operation: async () => {
      appendFileSync(join(dir, 'events.jsonl'), '{"appended":true}\n');
      mkdirSync(join(dir, '__uro_review'), { recursive: true });
      writeFileSync(join(dir, '__uro_review', 'REVIEW.md'), 'findings\n');
      writeFileSync(join(dir, 'stray.txt'), 'out of scope\n');
    },
  });
  assert.deepEqual(restoredPaths, ['stray.txt'], 'only the stray write is restored');
  assert.match(readFileSync(join(dir, 'events.jsonl'), 'utf8'), /appended/,
    'the run log keeps its mid-run append');
  const violation = events.find((e) => e.type === 'scope_violation');
  assert.ok(violation && !violation.paths.includes('events.jsonl'));
  rmSync(dir, { recursive: true, force: true });
});
```

Adapt the exact invocation to `runProtectedOperation`'s real contract (read the existing tests in the same file first — reuse their setup helpers; the `scope: ['**']` argument shape must match what existing callers pass, grep `runProtectedOperation(` in `src/`).

- [ ] **Step 2: Run it, confirm it fails** — `node --test test/review-protection.test.js` — expected: restoredPaths contains `events.jsonl` (the bug).
- [ ] **Step 3: Implement** — in `src/review-protection.js`, export the predicate and apply it wherever the snapshot diff decides a path was changed/created (both the capture comparison and the restore loop):

```js
// The harness writes these into the worktree itself (append-only run log,
// the task brief, the diff handoff, the reviewer's sanctioned report area).
// They are never a seat's scope violation, and restoring the run log rewrites
// history mid-run — the peer session watched it happen twice.
export const HARNESS_ARTIFACT_PATTERNS = Object.freeze([
  /^events\.jsonl$/, /^TASK\.md$/, /^CHANGES\.diff$/, /^__uro_review(\/|\\|$)/,
]);
export function isHarnessArtifact(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/');
  return HARNESS_ARTIFACT_PATTERNS.some((pattern) => pattern.test(normalized));
}
```

Filter in the restoration path list: `restoredPaths = (restoration?.restoredPaths ?? []).filter((p) => !isHarnessArtifact(p));` is NOT sufficient alone — the restore itself must skip these paths so the file content is not rolled back. Apply `isHarnessArtifact` inside `restoreWorktreeSnapshot`'s change-detection loop (and the capture if it snapshots content for later comparison), so harness files are neither reverted nor reported.

- [ ] **Step 4: Run the test, confirm it passes**, then the module's full file: `node --test test/review-protection.test.js`.
- [ ] **Step 5: Write the failing test for P3** — the isolation dir must hide harness files from git:

```js
test('harness files are git-invisible inside the isolated worktree', () => {
  // After isolation setup writes TASK.md and the run appends events.jsonl,
  // `git status --porcelain` in the worktree must not list them.
});
```

Locate the isolation test file (`grep -rln "iso.dir\|isolat" test/`) and follow its real-worktree fixture pattern. The assertion: run the same setup path `run.js` uses (or call the isolation helper directly), write `TASK.md` + `events.jsonl`, then `git -C <dir> status --porcelain` output does not mention either.

- [ ] **Step 6: Implement P3** — at isolation setup (where run.js writes `TASK.md`, line ~682, or better inside `src/isolation.js` right after the worktree is created), append the harness names to the tree's git exclude file, resolved per-tree:

```js
import { execFileSync } from 'node:child_process';
const excludePath = execFileSync('git', ['-C', iso.dir, 'rev-parse', '--git-path', 'info/exclude'],
  { encoding: 'utf8' }).trim();
const resolvedExclude = isAbsolute(excludePath) ? excludePath : join(iso.dir, excludePath);
mkdirSync(dirname(resolvedExclude), { recursive: true });
appendFileSync(resolvedExclude, '\n# uroboros harness artifacts — not the seat\'s work\nTASK.md\nevents.jsonl\nCHANGES.diff\n__uro_review/\n');
```

Use the spawn wrapper the module already uses for git (grep `runCommand\|execFile` in `src/isolation.js`) rather than raw `execFileSync` if one exists — match house style.

- [ ] **Step 7: Full suite green** — `node --test` → 890+ pass, 0 fail.
- [ ] **Step 8: Commit** — `git add src/review-protection.js src/isolation.js src/run.js test/review-protection.test.js <isolation test file>` then commit: `fix(review-protection): harness artifacts are never scope violations and never pollute the worktree` with the standard trailers.

### Task 2: Unjudged judgements keep their raw answer, and the agreement judge sees each seat's true state (F13 + T-engine)

**Files:**
- Modify: `src/conversation.js` (agreement handling ~line 409-426, pivot handling ~line 533-545)
- Modify: `src/decompose.js` and `src/plan.js` (their `agreementRequest` builders — grep `agreementRequest` in each; both tiers' builders must gain the same per-seat stance context)
- Test: `test/conversation.test.js`, `test/decompose.test.js`

**Interfaces:**
- Consumes: `agreementRequest({ round, proposal, reviews })` (conversation.js:426) where `reviews.codex` / `reviews.cursor` each carry `{ agree, readable, suggestions, questions, content, unavailable? }`.
- Produces: (1) roundHistory `agreement` objects gain `raw: <string>` when `verdict !== 'answered'`; (2) pivotHistory entries gain `raw: <string>` when `unjudged === true`; (3) every tier's agreement request/prompt includes, per seat, one of exactly three states — `stance: 'agree' | 'disagree' | 'stance-unreadable' | 'unavailable'` — and, for `stance-unreadable`, the seat's raw `content` verbatim under a clearly labeled section.

**Background:** run 3 round 3's agreement came back ANSWERED-but-unparseable and the raw answer was dropped (undiagnosable); every run's judge said "Both seats say AGREE: no" when Cursor's stance was actually *unreadable* — the request never told it.

- [ ] **Step 1: Failing test — unjudged agreement keeps its raw answer** (`test/conversation.test.js`, using the existing `seatsFor` harness):

```js
test('an unjudged agreement keeps the raw answer for diagnosis', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'], agrees: true });
  seats.arbitrate = async (request) => {
    if (request.type === 'propose') return { verdict: 'answered', answer: 'GOOD' };
    if (request.type === 'agreement') return { verdict: 'answered', answer: 'prose that fails the agreement parse' };
    return { verdict: 'answered' };
  };
  const result = await runConversation({ runId: 'conv-unjudged-raw', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(result.converged, false);
  const agreement = result.roundHistory[0].agreement;
  assert.notEqual(agreement.verdict, 'answered');
  assert.equal(agreement.raw, 'prose that fails the agreement parse');
});
```

Adapt to how `seatsFor`'s arbitrate mock and the engine's agreement parsing actually interact (read the harness at the top of the test file: the agreement path may consume `{ verdict, converged, reason }` objects — an object without a boolean `converged` is the unjudged shape; if so, return `{ verdict: 'answered', answer: 'prose...' }` and assert on whatever the engine records — the requirement is that the raw text of the unparseable answer is retained verbatim on the agreement record).

- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement** in `src/conversation.js` at the agreement resolution (~:426): when the parsed agreement is unjudged (`verdict !== 'answered'`), attach `raw` from the arbiter response's answer/text (whatever field carried the unparseable content — mirror how `parseAcceptanceJudgement`-style parsers receive `{ answer }`). Same pattern at the pivot judgement (~:533): when `unjudged`, `pivotHistory.push({ ..., raw })`.
- [ ] **Step 4: Failing test — the agreement request names each seat's true state** — in `test/conversation.test.js`, capture the agreement request:

```js
test('the agreement judge is told a stance was unreadable, with the raw text', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  seats.reviewCursor = async () => 'Looks great, ship it';   // no stance line
  let seen;
  strategy.agreementRequest = (ctx) => { seen = ctx; return { type: 'agreement' }; };
  await runConversation({ runId: 'conv-agreement-context', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(seen.reviews.cursor.readable, false);
  assert.match(seen.reviews.cursor.content, /Looks great/);
});
```

If the engine already passes full review objects through (it passes `reviews` verbatim at :426), this test may pass immediately — then the REAL work is in the tier builders: extend `test/decompose.test.js` with a direct test of the tier-2 agreement prompt builder (grep its name — the function that renders the agreement arbiter prompt from reviews) asserting the rendered prompt contains, for an unreadable cursor review: the literal words `stance unreadable` and the raw content; for an unavailable one: `unavailable`; and never claims "says AGREE: no" for either.

- [ ] **Step 5: Implement the tier builders** — in `src/decompose.js` (both tier-1 and tier-2 agreement prompt builders) and `src/plan.js` (its agreement builder): render each seat's block as:

```
CODEX_REVIEW (stance: disagree) [suggestions...]
CURSOR_REVIEW (stance: stance-unreadable — the AGREE line did not parse; judge the raw text yourself)
<raw content verbatim>
```

with the four states mapped exactly: `unavailable: true` → `unavailable (seat never ran)`; `readable === false` → `stance-unreadable` + raw content; else `agree`/`disagree`. Do not summarize or trim the raw content.

- [ ] **Step 6: Full suite green.** `node --test`.
- [ ] **Step 7: Commit** — `fix(conversation): unjudged judgements keep raw answers; the agreement judge sees true seat states`.

### Task 3: Artifact repairs stop consuming deliberation rounds (F12)

**Files:**
- Modify: `src/conversation.js` (the round loop at :366 `for (round = 1; rounds === undefined || round <= rounds; round++)` and the repair `continue` path near :382-392)
- Modify: `docs/superpowers/specs/2026-09-01-decomposition-spine-design.md` (audit table + terminal reasons prose)
- Test: `test/conversation.test.js`

**Interfaces:**
- Consumes: the repair path `roundHistory.push({ round, repair }); feedback = repair; reStorm = false; continue;`.
- Produces: exported `MAX_ARTIFACT_REPAIRS = 5` from `src/conversation.js`; a new terminal `reason: 'proposal-irreparable'` on the conversation result; repairs recorded in roundHistory WITHOUT advancing the round number.

- [ ] **Step 1: Failing test:**

```js
test('a repair does not consume a deliberation round', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['BROKEN', 'GOOD'] });
  let parses = 0;
  strategy.parseProposal = (text) => {
    parses += 1;
    if (parses === 1) throw new RepairableArtifactError('missing tags');
    return { plan: text };
  };
  const result = await runConversation({ runId: 'conv-repair-budget', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(result.converged, true, 'one round budget survives one repair');
  assert.equal(result.rounds, 1, 'the repaired proposal is still round 1');
});

test('repairs are bounded: the sixth ends the conversation as proposal-irreparable', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['BROKEN'] });
  strategy.parseProposal = () => { throw new RepairableArtifactError('always broken'); };
  const result = await runConversation({ runId: 'conv-repair-cap', tier: 'goal', seats, strategy, rounds: 3 });
  assert.equal(result.converged, false);
  assert.equal(result.reason, 'proposal-irreparable');
});
```

Adapt `strategy.parseProposal` to the harness's real hook name (the `seatsFor` strategy in the test file defines `parseDraft`/`parseProposal` — read it; the repair originates where `RepairableArtifactError` is caught around the proposal parse).

- [ ] **Step 2: Run, confirm fail** (first test: converged false today because the repair ate round 1).
- [ ] **Step 3: Implement:** in the repair catch path, replace round consumption: decrement the loop counter before `continue` (`round -= 1;`) so the retried proposal reuses the number, and count `artifactRepairs += 1`; when `artifactRepairs > MAX_ARTIFACT_REPAIRS` (exported, = 5), `return finish('proposal-irreparable', round, {})` (match `finish`'s real signature at :228). Keep the repair rows in roundHistory as today (they may share a round number with the real round — that is the truthful record). The repair event (`plan/proposal FAILED REPAIR ...`) keeps firing.
- [ ] **Step 4: Audit table row** in the spec doc, after the launch-retry row:

```markdown
| Artifact repair budget | bounded feedback loop | A malformed artifact re-asks the same judge with the exact parse error, up to 5 times per conversation; it never consumes a deliberation round, and exhaustion ends loudly as `proposal-irreparable` — no partial artifact ever lands |
```

Also add `proposal-irreparable` beside the other terminal reasons wherever the spec/docs enumerate them (`grep -rn "pivot-conclude" docs/ skills/` and extend each list).

- [ ] **Step 5: Full suite green.** Watch for tests that assert round numbering around repairs (run 6's F12 behavior may be pinned somewhere — if a test asserts a repair consumes a round, that test embodies the finding and is updated to the new law, citing F12 in a comment).
- [ ] **Step 6: Commit** — `fix(conversation): repairs never consume deliberation rounds and are bounded at five`.

### Task 4: The pivot decision and capability vetoes become visible events (F14 + F17)

**Files:**
- Modify: `src/conversation.js` (pivot decision site ~:533-545; the capability veto reportEvent at :124 already exists — verify its payload carries `seat`, `what`, `why`, `alternative`)
- Modify: `src/events.js` (`LISTED_EVENT_PAIRS` + `detailFor`)
- Test: `test/events.test.js`, `test/conversation.test.js`

**Interfaces:**
- Produces: new listed pair `plan/pivot` with fields `{ tier, planRound, decision, unjudged, reason }`; `detailFor` renders it and renders `capability/vetoed` fields.

- [ ] **Step 1: Failing formatter tests** in `test/events.test.js` (append near the plan-events test):

```js
test('pivot decisions and capability vetoes print their substance', () => {
  assert.match(
    detailFor({ stage: 'plan', type: 'pivot', tier: 'goal', planRound: 3, decision: 'conclude', unjudged: false, reason: 'oscillation without substance' }),
    /decision=conclude.*reason=oscillation without substance/,
  );
  assert.match(
    detailFor({ stage: 'capability', type: 'vetoed', seat: 'reviewer', what: 'cannot run the gate', why: 'no python', alternative: 'use node' }),
    /seat=reviewer.*what=cannot run the gate.*why=no python/,
  );
});
```

- [ ] **Step 2: Run, confirm fail.**
- [ ] **Step 3: Implement in `src/events.js`:** add `'plan/pivot',` to `LISTED_EVENT_PAIRS` beside the other plan pairs (line ~128-135). In `detailFor`'s plan case add:

```js
    if (event.type === 'pivot') {
      return `${event.unjudged ? 'UNJUDGED ladder' : 'decision'}=${oneLine(event.decision)}${tier}${round}`
        + (event.reason ? ` reason=${oneLine(event.reason)}` : '');
    }
```

Add a capability case before the final fallback:

```js
  if (event.stage === 'capability' && event.type === 'vetoed') {
    return `seat=${oneLine(event.seat)} what=${oneLine(event.what)} why=${oneLine(event.why)}`
      + (event.alternative ? ` alternative=${oneLine(event.alternative)}` : '');
  }
```

- [ ] **Step 4: Emit the pivot event** in `src/conversation.js` where `pivotHistory.push({ decision, unjudged, reason })` happens (~:545): directly beside the push, `reportEvent(reporter, runId, 'plan', 'pivot', { tier, planRound: round, decision, unjudged, reason });` (use the in-scope variable names — read the surrounding destructuring). Verify the capability veto emission at :124 includes `seat`, `what`, `why`, `alternative` from the judgement object; add any missing field to the payload.
- [ ] **Step 5: Conformance fixture** — in the vocabulary-conformance test's event composition, append beside `verifyRetryEvents`:

```js
    const pivotDecisionEvents = [createEvent({
      runId: 'conformance-plan-pivot', stage: 'plan', type: 'pivot',
      fields: { tier: 'goal', planRound: 3, decision: 'conclude', unjudged: false, reason: 'conformance fixture' },
    })];
```

and spread it into `allEvents`.

- [ ] **Step 6: Engine test** in `test/conversation.test.js`: drive a conversation to a pivot (reuse the existing `'a judged conclude ends the plan as pivot-conclude'` test's setup) with a `reporter` capturing events; assert one event with `stage === 'plan' && type === 'pivot' && decision === 'conclude'`.
- [ ] **Step 7: Full suite green; commit** — `feat(events): pivot decisions and capability vetoes print their substance`.

### Task 5: The operator is never told false things: dashboard probe, token zeros, files list (P1 + P5 + P9)

**Files:**
- Modify: `src/dashboard-launcher.js` (`DEFAULT_STARTUP_TIMEOUT_MS` at :14 and the probe loop :145-200)
- Modify: `src/status.js` (:181-183)
- Test: `test/dashboard-launcher.test.js` (exists — grep for it; else the launcher's covering test file), `test/status.test.js`

- [ ] **Step 1: P1 failing test** — the launcher keeps probing until the startup budget and reports the real outcome:

```js
test('a slow-binding dashboard is found, not declared missing', async () => {
  let calls = 0;
  const result = await launchDashboard({   // use the module's real entry (grep exports)
    port: 7331,
    probe: async () => { calls += 1; return calls >= 3; },
    probeTimeoutMs: 50,
    startupTimeoutMs: 5000,
    // ...whatever minimal options the real signature needs; read the existing tests
  });
  assert.equal(result.available, true);
  assert.ok(calls >= 3, 'the probe retries until the bind lands');
});
```

- [ ] **Step 2: Implement P1** — raise `DEFAULT_STARTUP_TIMEOUT_MS` from `1500` to `8000` and make the wait loop re-probe on an interval (e.g. every 250ms of the remaining budget — the loop skeleton at :197 already computes `remaining`); when the budget truly ends, the notice must state what was probed and that the server may still bind late: `dashboard did not answer on http://127.0.0.1:<port> within <n>ms — it may still be starting; re-check the URL before assuming it is down.`
- [ ] **Step 3: P5 failing test** — `test/status.test.js`: a status whose usage was not yet accounted renders `not yet accounted`, never zeros:

```js
assert.match(renderedStatus, /Tokens: not yet accounted/);
```

Find how `status.tokens` distinguishes "no usage rows yet" from "genuinely zero" — if it cannot (both arrive as zeros), add an explicit flag upstream where status is assembled (`status.tokensAccounted = <whether any usage row exists>`); truthful-zero stays possible: a run with real recorded zero usage still prints zeros.
- [ ] **Step 4: Implement P5** in `src/status.js:182`: `status.tokensAccounted === false` → `Tokens: not yet accounted (usage lands when the stage completes)`.
- [ ] **Step 5: P9** — `src/status.js:181`: render one path per line:

```js
    `Files changed (${status.files.length}):`,
    ...status.files.map((file) => `  ${file}`),
```

(keep `(none)` when empty: `...(status.files.length === 0 ? ['  (none)'] : status.files.map((file) => `  ${file}`))`). Update any test pinning the old single-line format.
- [ ] **Step 6: Full suite green; commit** — `fix(status,dashboard): truthful probe, truthful tokens, readable file list`.

### Task 6: One long edit is not a stall (P4)

**Files:**
- Modify: `src/stall-watchdog.js` (the progress-keyed detector, `lastProgressAt` ~:216)
- Test: `test/stall-watchdog.test.js` (exists — extend in its harness style)

**Background:** the peer's run logged `executor/stalled no completed work for 300013ms last action=editing agent/__init__.py` during a healthy 22-minute single-file edit — `lastProgressAt` only advances on completed items, while `file_change` events were flowing the whole time.

- [ ] **Step 1: Failing test:** feed the progress tracker a stream of `executor/file_change` events across the threshold window and assert NO `stalled` event fires; control: total silence across the window still fires one.

```js
test('flowing file_change events are progress, not a stall', () => {
  // use the file's existing fake-clock harness; emit file_change every 60s
  // for 6 minutes with a 300s threshold; expect zero stalled events.
});
test('true silence still stalls', () => {
  // no events for 301s -> exactly one stalled event (existing behavior pinned).
});
```

- [ ] **Step 2: Implement:** wherever the progress detector decides which events advance `lastProgressAt` (read :200-240), include `file_change` (and `item_completed`, already counted). Do NOT include heartbeat-ish or start events — only evidence of work product. Keep the judged-liveness path untouched.
- [ ] **Step 3: Full suite green; commit** — `fix(stall-watchdog): a flowing edit is progress, not a stall`.

### Task 7: Environment and docs truths: executor temp dir, run --help, staged-diff landing note (P6 + P7 + P8)

**Files:**
- Modify: `src/run.js` or `src/executor.js` (executor launch env — `env: launchEnv` at executor.js:268; find where launchEnv is composed)
- Modify: `src/args.js` (command help handling at :146) — **mixed CRLF file: byte-preserving edit, verify CR count 134 unchanged**
- Modify: `skills/uroboros/SKILL.md` (landing section)
- Test: `test/args.test.js` (**CRLF: CR count 179 unchanged**), `test/executor.test.js` or `test/run.test.js` (grep which covers launchEnv)

- [ ] **Step 1: P6 failing test:** the executor's child env carries TMP/TEMP/TMPDIR pointing inside the worktree:

```js
test('the executor sandbox owns its temp dir inside the worktree', () => {
  // build launchEnv (or spawn the fake codex) for a run rooted at <dir>;
  // assert env.TMP === env.TEMP === join(<dir>, '.uro-tmp') and the dir exists.
});
```

- [ ] **Step 2: Implement P6:** where the executor's `launchEnv` is composed, add:

```js
const executorTmp = join(cwd, '.uro-tmp');
mkdirSync(executorTmp, { recursive: true });
launchEnv.TMP = executorTmp;
launchEnv.TEMP = executorTmp;
launchEnv.TMPDIR = executorTmp;
```

and add `.uro-tmp/` to Task 1's harness exclude list AND to `HARNESS_ARTIFACT_PATTERNS` (coordinate: Task 1 produced `isHarnessArtifact` — extend its array with `/^\.uro-tmp(\/|\\|$)/`). Add `.uro-tmp` to the git-clean exclusion beside `events.jsonl` at run.js:169 (`'-e', '.uro-tmp'`).

- [ ] **Step 3: P7 failing test** (`test/args.test.js`, byte-preserving): `parseArgs(['run', '--help'])` (and every command + `--help`) returns the help/usage path instead of throwing `Unknown option --help`:

```js
test('every command answers --help with usage instead of an error', () => {
  for (const command of ['run', 'queue', 'batch', 'decompose', 'status', 'doctor']) {
    const opts = parseArgs([command, '--help']);
    assert.equal(opts.command, 'help');
  }
});
```

- [ ] **Step 4: Implement P7** in `src/args.js`: near the existing global help check (:146), before per-command option parsing, treat `--help`/`-h` anywhere in a command's argv as `command = 'help'`. Preserve CRLF bytes: use a node splice script or the Edit tool, then `tr -cd '\r' < src/args.js | wc -c` must still print `134` (and `179` for the test file).
- [ ] **Step 5: P8** — in `skills/uroboros/SKILL.md`'s landing section (grep `landing`), add one sentence: `The loop STAGES the executor's edits — a bare git diff in the run worktree is empty; read the work with git diff --cached --binary.` Run the docs conformance tests (`node --test test/plugin-packaging.test.js test/planner-docs.test.js`) — if SKILL.md text is pinned byte-wise anywhere, update the pin in the same commit.
- [ ] **Step 6: Full suite green; commit** — `fix(env,args,docs): executor-owned temp dir, --help everywhere, staged-diff landing truth`.

### Task 8: A capped seat is summarized at the terminal, and doctor --deep is the documented pre-program check (peer request 2)

**Files:**
- Modify: `src/conversation.js` (finish path ~:228 — the terminal result object)
- Modify: `docs/usage.md` (a sentence in the decompose/queue sections), `skills/uroboros/SKILL.md`
- Test: `test/conversation.test.js`

**Interfaces:**
- Consumes: seat failure error strings now carrying stderr (commit 63c788f) — draft errors recorded in `stormHistory`, review `unavailable: true` rows.
- Produces: the conversation result gains `seatOutages: { cursor?: string }` — present ONLY when every recorded cursor interaction in the run failed and at least one failure message matches `/ActionRequiredError|usage limit|Free plans/i`; the value is the last matching failure message verbatim.

**Background (peer session, live EULR program):** a capped Cursor account takes runs down mid-flight; plain `loop doctor` shows green because it never exercises a launch. The peer needs to PLAN around a cap, not discover it at round 4.

- [ ] **Step 1: Failing test** in `test/conversation.test.js`:

```js
test('an account-capped seat is named in the terminal record', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  seats.draftCursor = async () => {
    throw new Error("cursor draft seat failed to launch: ActionRequiredError: You've hit your usage limit");
  };
  seats.reviewCursor = async () => {
    throw new Error("ActionRequiredError: You've hit your usage limit");
  };
  const result = await runConversation({ runId: 'conv-capped', tier: 'goal', seats, strategy, rounds: 1 });
  assert.match(result.seatOutages.cursor, /usage limit/);
});

test('a seat that worked at all has no outage row', async () => {
  const { seats, strategy } = seatsFor({ proposals: ['GOOD'] });
  const result = await runConversation({ runId: 'conv-not-capped', tier: 'goal', seats, strategy, rounds: 1 });
  assert.equal(result.seatOutages, undefined);
});
```

(Adapt: reviewCursor throwing is caught by `reviewBoth` into `unavailableReview()` — the outage detection must gather failure texts from storm draft errors AND from review-call exceptions; if the engine currently swallows the review exception message, capture it into the unavailable row as `error` while implementing — that error field stays out of events and feeds only the outage summary, keeping scope tight.)

- [ ] **Step 2: Implement** in the finish path: scan `stormHistory` draft errors and collected review failure messages for the cap signature `/ActionRequiredError|usage limit|Free plans/i`; when EVERY cursor interaction failed and ≥1 matches, attach `seatOutages: { cursor: <last matching message> }` to the result object beside `converged`/`reason`. Never attach on partial failure (a seat that answered once is not capped).
- [ ] **Step 3: Docs** — one sentence in `docs/usage.md` near the decompose section and one in `skills/uroboros/SKILL.md`: `Before a long program, run loop doctor --deep — plain doctor checks sign-in, only --deep exercises real seat launches and surfaces an account cap; a capped seat otherwise appears as unavailable reviews and a run that cannot converge.` Run the docs conformance tests and update pins if SKILL.md text is byte-pinned.
- [ ] **Step 4: Full suite green; commit** — `feat(conversation): capped seats are named in the terminal record; doctor --deep is the pre-program check`.

---

## Self-review notes

- Coverage: P1→T5, P2→T1, P3→T1, P4→T6, P5→T5, P6→T7, P7→T7, P8→T7, P9→T5, F12→T3, F13→T2, F14→T4, F17→T4. (F7/F19/F1/F2/F4-residue are deliberately excluded — they are sub-project C's charter, not this wave.)
- Order matters only for T1→T7 (`isHarnessArtifact` array extended by T7); all other tasks are independent.
- Every new bound (repair budget) and every new event pair carries its audit-table row / conformance fixture inside the same task.
