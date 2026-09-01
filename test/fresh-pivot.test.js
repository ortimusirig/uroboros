import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PIVOT_CONCLUDE, PIVOT_FRESH } from '../src/debate.js';
import { createFreshPivotBranch, run } from '../src/run.js';


const TEST_SUPERPOWERS = {
  seats: {
    codex: { verified: true, path: null },
    cursor: { verified: true, path: null },
    claude: { verified: true, path: null },
  },
};

function fixture(name) {
  const root = mkdtempSync(join(process.cwd(), `.ccc-test-${name}-`));
  const target = join(root, 'target');
  const scratchRoot = join(root, 'scratch');
  const worktree = join(scratchRoot, name, 'w');
  mkdirSync(target, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(target, 'seed.txt'), 'seed\n');
  return {
    root, target, scratchRoot, worktree,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const proofBytes = Buffer.from([0, 1, 2, 13, 10, 255, 42]);
const eventBytes = Buffer.from('{"stage":"debate","type":"pivot"}\n');
const reviewText = [
  '## F1',
  'Severity: blocking',
  'Category: correctness',
  'Description: The same boundary defect remains.',
  'Test: __uro_review/tests/f1.test.js',
  '',
].join('\n');

test('fresh branch creation uses the pre-debate commit and restores reviewer bytes', async () => {
  const item = fixture('fresh-branch-unit');
  const reviewDir = join(item.worktree, '__uro_review', 'tests');
  const proof = join(reviewDir, 'f1.test.js');
  const failedAttempt = join(item.worktree, 'failed-attempt.txt');
  const eventsPath = join(item.worktree, 'events.jsonl');
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(proof, proofBytes);
  writeFileSync(failedAttempt, 'discard me\n');
  writeFileSync(eventsPath, eventBytes);
  const gitCalls = [];
  try {
    const result = await createFreshPivotBranch({
      cwd: item.worktree,
      baseCommit: 'pre-debate-commit',
      branch: 'uro/test-fresh-1',
      spawn: async (_bin, args) => {
        gitCalls.push(args);
        if (args.includes('clean')) {
          rmSync(join(item.worktree, '__uro_review'), { recursive: true, force: true });
          rmSync(failedAttempt, { force: true });
        }
        return {
          code: 0,
          stdout: args.includes('rev-parse') ? 'pre-debate-commit\n' : '',
          stderr: '',
        };
      },
    });

    assert.equal(result.branchPoint, 'pre-debate-commit');
    assert.ok(gitCalls.some((args) => args.join(' ').includes(
      'switch --discard-changes -c uro/test-fresh-1 pre-debate-commit',
    )));
    assert.ok(gitCalls.some((args) => args.join(' ').includes(
      'clean -ffd -x -e events.jsonl',
    )));
    assert.equal(existsSync(failedAttempt), false);
    assert.deepEqual(readFileSync(proof), proofBytes);
    assert.deepEqual(readFileSync(eventsPath), eventBytes);
  } finally { item.cleanup(); }
});

async function runFreshScenario({ allCandidatesFail = false, clean = false } = {}) {
  const item = fixture(allCandidatesFail ? 'fresh-exhausted' : clean ? 'fresh-positive' : 'fresh-run');
  const events = [];
  const branchCalls = [];
  const candidateRequests = [];
  const selectionRequests = [];
  const executorPlans = [];
  let pivotCalls = 0;
  let currentBranch = 'uro/original';
  let reviewBytesAtPivot;
  const facts = await run({
    task: 'Implement the approved behavior.',
    target: item.target,
    gate: [],
    gateRetries: 0,
    scratchRoot: item.scratchRoot,
    artifactRoot: join(item.root, 'artifacts'),
    runId: allCandidatesFail ? 'fresh-exhausted' : clean ? 'fresh-positive' : 'fresh-run',
    pivotCandidates: 3,
    superpowers: TEST_SUPERPOWERS,
    reporter: (event) => events.push(event),
    adapters: {
      isolate: async ({ baseRef }) => ({
        dir: item.worktree,
        isRepo: true,
        branch: currentBranch,
        baseRef,
        baseCommit: 'pre-debate-commit',
        cleanup: async () => {},
      }),
      diffText: async () => 'diff --git a/implementation.txt b/implementation.txt\n',
      runExecutor: async ({ plan, cwd }) => {
        executorPlans.push(plan);
        writeFileSync(join(cwd, 'implementation.txt'), plan.includes('fresh candidate-3 plan')
          ? 'fresh implementation\n'
          : 'discarded implementation\n');
        return {
          exitCode: 0,
          changedFiles: ['implementation.txt'],
          lastMessage: 'implemented',
        };
      },
      runGate: async () => ({ passed: true, results: [] }),
      runReview: clean ? null : async ({ cwd }) => {
        const reviewDir = join(cwd, '__uro_review', 'tests');
        mkdirSync(reviewDir, { recursive: true });
        writeFileSync(join(cwd, '__uro_review', 'REVIEW.md'), reviewText);
        writeFileSync(join(reviewDir, 'f1.test.js'), proofBytes);
        return { launchFailed: false, timedOut: false };
      },
      captureWorktreeSnapshot: async () => ({}),
      restoreWorktreeSnapshot: async () => ({ restoredPaths: [] }),
      runVerifier: async ({ prompt }) => ({
        verdict: 'NO_BLOCKERS',
        launchFailed: false,
        findings: prompt === INTENT_PROMPT ? 'Intent is preserved.' : 'Implementation checked.',
      }),
      runArbiter: async ({ request }) => {
        if (request.type === 'finding') return { verdict: 'valid' };
        if (request.type === 'pivot') {
          return pivotCalls++ === 0
            ? { decision: PIVOT_FRESH, reason: 'The current framing has failed repeatedly.' }
            : { decision: PIVOT_CONCLUDE, reason: 'The fresh framing reproduced the blocker.' };
        }
        return { verdict: 'valid' };
      },
      createFreshPivotBranch: async ({ cwd, baseCommit, branch }) => {
        branchCalls.push({ baseCommit, branch });
        reviewBytesAtPivot = readFileSync(join(cwd, '__uro_review', 'tests', 'f1.test.js'));
        rmSync(join(cwd, 'implementation.txt'), { force: true });
        rmSync(join(cwd, 'CHANGES.diff'), { force: true });
        currentBranch = branch;
        return {
          branch,
          branchPoint: baseCommit,
          reviewPaths: ['__uro_review/tests/f1.test.js'],
        };
      },
      // There is no mechanical plan gate any more. A candidate can only fail by
      // its DRAFT failing, so the discard scenarios throw from the draft seat.
      draftPlanCandidate: async (request) => {
        candidateRequests.push(request);
        if (allCandidatesFail || request.candidateId === 'candidate-2') {
          throw new Error(`${request.candidateId} draft failed`);
        }
        return {
          plan: `fresh ${request.candidateId} plan\n`,
          gate: [],
          usage: {
            inputTokens: request.candidateIndex,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            cacheWriteTokens: 0,
          },
        };
      },
      selectPlanCandidate: async (request) => {
        selectionRequests.push(request);
        return {
          selectedCandidateId: 'candidate-3',
          usage: {
            inputTokens: 5,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            cacheWriteTokens: 0,
          },
        };
      },
    },
  });
  return {
    item,
    facts,
    events,
    branchCalls,
    candidateRequests,
    selectionRequests,
    executorPlans,
    reviewBytesAtPivot,
  };
}

test('FRESH replans with ledger-informed candidates, discards failed drafts, and continues', async () => {
  const scenario = await runFreshScenario();
  try {
    const {
      facts, events, branchCalls, candidateRequests, selectionRequests,
      executorPlans, reviewBytesAtPivot,
    } = scenario;
    assert.deepEqual(branchCalls, [{
      baseCommit: 'pre-debate-commit',
      branch: 'uro/original-fresh-1',
    }]);
    assert.deepEqual(reviewBytesAtPivot, proofBytes);
    assert.deepEqual(readFileSync(join(facts.dir, '__uro_review', 'tests', 'f1.test.js')), proofBytes);
    assert.equal(candidateRequests.length, 3);
    assert.equal(new Set(candidateRequests.map((request) => request.perspective)).size, 3);
    // Both verifier seats found this assertion vacuous, and a counterfactual
    // confirmed it: dropping ledgerPrompt entirely left the whole suite green,
    // because 'F1' reaches the prompt by other routes. Assert the ledger block
    // itself, which only ledgerPrompt can produce.
    assert.ok(candidateRequests.every((request) => request.input.includes('F1')));
    assert.ok(candidateRequests.every(
      (request) => request.input.includes('Debate ledger (evidence from the discarded approach):')),
    'requirement 4: the ledger block must reach every candidate prompt');
    // F1 must arrive VIA the ledger, not merely somewhere in the prompt —
    // that distinction is the whole of the seat's finding.
    const ledgerBlockOf = (input) => input.slice(input.indexOf('Debate ledger'));
    assert.ok(candidateRequests.every((request) => ledgerBlockOf(request.input).includes('F1')),
      'requirement 4: the finding ids must reach candidates inside the ledger block');
    // request.perspective is assigned from the hardcoded FRESH_PERSPECTIVES
    // array, so asserting it cannot detect the declaration being dropped from
    // the prompt. Assert the prompt text, as the initial-STORM test does.
    assert.ok(candidateRequests.every((request) => request.input.includes('Declared perspective:')),
      'requirement 3: each FRESH candidate must carry its declared perspective');
    assert.ok(candidateRequests.every((request) => request.input.includes('Discarded implementation framing')));
    assert.deepEqual(selectionRequests[0].candidates.map((candidate) => candidate.id), [
      'candidate-1', 'candidate-3',
    ]);
    assert.ok(executorPlans.some((plan) => plan.includes('fresh candidate-3 plan')));
    assert.equal(facts.branch, 'uro/original-fresh-1');
    assert.equal(facts.debate.finalPivotDecision, PIVOT_CONCLUDE);
    assert.equal(facts.debate.pivotHistory[0].decision, PIVOT_FRESH);
    // Requirement 12: the facts must record each candidate's perspective.
    // Dropping it from planCandidateFacts left the whole suite green.
    const recordedPerspectives = facts.debate.pivotHistory[0].candidates
      .map((candidate) => candidate.perspective);
    assert.equal(recordedPerspectives.filter(Boolean).length, recordedPerspectives.length,
      'requirement 12: every recorded candidate must carry its perspective');
    assert.equal(new Set(recordedPerspectives).size, recordedPerspectives.length,
      'requirement 12: recorded perspectives must stay distinct');
    assert.equal(facts.debate.pivotHistory[0].reason,
      'The current framing has failed repeatedly.');
    assert.equal(facts.debate.pivotHistory[0].branchPoint, 'pre-debate-commit');
    assert.equal(facts.debate.pivotHistory[0].selectedCandidateId, 'candidate-3');
    assert.equal(facts.debate.pivotHistory[0].candidates[1].gatePassed, false);
    assert.equal(facts.debate.pivotHistory[0].candidates[1].selected, false);
    assert.equal(facts.debate.ledger.rounds.length, 4,
      'the post-FRESH finding must extend, not reset, the ledger');
    // Candidates 1 and 3 drafted (usage 1 + 3) plus selection (5). Candidate 2's
    // draft threw, so it has no usage to count — a failed draft costs nothing.
    assert.equal(facts.tokens.executor.inputTokens, 9,
      'candidate drafting and selection must count against the run budget');
    for (const pair of [
      'pivot/replan_start', 'pivot/candidate', 'pivot/selected',
    ]) {
      assert.ok(events.some((event) => `${event.stage}/${event.type}` === pair), pair);
    }
  } finally { scenario.item.cleanup(); }
});

test('every FRESH draft failing escalates honestly to CONCLUDE', async () => {
  const scenario = await runFreshScenario({ allCandidatesFail: true });
  try {
    assert.equal(scenario.facts.outcome, 'needs-pivot');
    assert.equal(scenario.facts.debate.finalPivotDecision, PIVOT_CONCLUDE);
    assert.equal(scenario.facts.debate.stopReason, 'pivot-exhausted');
    const fresh = scenario.facts.debate.pivotHistory[0];
    assert.equal(fresh.exhausted, true);
    assert.equal(fresh.escalatedTo, PIVOT_CONCLUDE);
    assert.equal(fresh.selectedCandidateId, null);
    assert.ok(fresh.candidates.every((candidate) => candidate.gatePassed === false));
    assert.equal(scenario.executorPlans.some((plan) => plan.includes('fresh candidate')), false);
    assert.ok(scenario.events.some((event) => (
      `${event.stage}/${event.type}` === 'pivot/exhausted'
      && event.decision === PIVOT_CONCLUDE
    )));
  } finally { scenario.item.cleanup(); }
});

test('a non-circling run creates no branch and emits no pivot events', async () => {
  const scenario = await runFreshScenario({ clean: true });
  try {
    assert.equal(scenario.facts.outcome, 'review-ready');
    assert.deepEqual(scenario.branchCalls, []);
    assert.equal(scenario.events.some((event) => event.stage === 'pivot'), false);
  } finally { scenario.item.cleanup(); }
});
