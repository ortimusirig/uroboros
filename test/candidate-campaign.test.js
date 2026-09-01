import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCampaign as executeCampaign } from '../src/campaign.js';
import { exitCodeFor } from '../src/exit.js';
import { spawnCapture } from '../src/spawn.js';

const SAFE_SCRATCH_BASE = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

const VERIFIED_SUPERPOWERS = {
  ok: true,
  seats: {
    codex: { seat: 'codex', verified: true, evidence: 'registry', version: '6.3.0' },
    cursor: { seat: 'cursor', verified: true, evidence: 'manifest', version: '6.0.2' },
    claude: { seat: 'claude', verified: true, evidence: 'manifest', version: '6.0.2' },
  },
};
const runCampaign = (options) => executeCampaign({
  verifySuperpowers: async () => VERIFIED_SUPERPOWERS,
  ...options,
});

async function gitOk(cwd, ...args) {
  const result = await spawnCapture('git', ['-C', cwd, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

const usage = (inputTokens = 0, outputTokens = 0) => ({
  inputTokens,
  cachedInputTokens: 0,
  outputTokens,
  reasoningOutputTokens: 0,
  cacheWriteTokens: 0,
});

function adapterFacts(runId, outcome = 'review-ready') {
  return {
    runId,
    outcome,
    verdict: outcome === 'executor-failed' ? null : 'NO_BLOCKERS',
    verdictSource: outcome === 'executor-failed' ? null : 'result',
    verifierConsistency: outcome === 'executor-failed' ? null : { status: 'consistent' },
    intentVerdict: outcome === 'executor-failed' ? null : 'NO_BLOCKERS',
    intentVerdictSource: outcome === 'executor-failed' ? null : 'assistant',
    intentVerifierConsistency: outcome === 'executor-failed' ? null : { status: 'consistent' },
    evidence: outcome === 'executor-failed'
      ? [{ source: 'command', bin: 'node', args: ['--test'], code: 1, timedOut: false,
          round: 1, excerpt: 'failing alternative', outFile: '__uro_evidence/round-1-01.out.txt',
          errFile: '__uro_evidence/round-1-01.err.txt' }]
      : [],
    branch: `ccc/${runId}`,
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    dir: join(SAFE_SCRATCH_BASE, runId, 'w'),
    testCountDelta: runId.endsWith('one') ? 1 : 2,
    tokens: { total: usage(7, 3) },
  };
}

test('Mode A candidates overlap from one repository and base while retaining distinct results', async () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  const scratchRoot = mkdtempSync(join(SAFE_SCRATCH_BASE, '.candidate-mode-'));
  const target = mkdtempSync(join(tmpdir(), 'candidate-mode-target-'));
  writeFileSync(join(target, 'seed.txt'), 'one shared starting tree\n');
  const events = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  let releaseExecutors;
  const allExecutorsStarted = new Promise((resolve) => { releaseExecutors = resolve; });
  let overlapDeadline;
  const candidateCount = new Map([
    ['candidate-minimal', 11],
    ['candidate-refactor', 12],
    ['candidate-tests', 13],
  ]);
  try {
    const result = await runCampaign({
      campaignId: 'candidate-mode-real',
      tasks: [
        {
          task: 'Implement the minimal candidate.', unitId: 'candidate-minimal',
          unitKind: 'candidate', perspective: 'minimal-change',
        },
        {
          task: 'Implement the refactor candidate.', unitId: 'candidate-refactor',
          unitKind: 'candidate', perspective: 'refactor-first',
        },
        {
          task: 'Implement the testing candidate.', unitId: 'candidate-tests',
          unitKind: 'candidate', perspective: 'test-first',
        },
      ],
      target,
      gate: [],
      concurrency: 3,
      tokenBudget: 10_000,
      scratchRoot,
      reporter: (event) => events.push(event),
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async ({ cwd, runId }) => {
            inFlight++;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
            // Start the safety deadline only after execution begins. Campaign-base and
            // worktree setup can be slow under the full parallel test gate, and must not
            // release this barrier before there is an executor to overlap.
            overlapDeadline ??= setTimeout(releaseExecutors, 15_000);
            if (inFlight === 2) releaseExecutors();
            await allExecutorsStarted;
            const file = `${runId}.txt`;
            writeFileSync(join(cwd, file), `${runId} chose a distinct implementation\n`);
            inFlight--;
            return { changedFiles: [file], lastMessage: runId, usage: usage(4, 1) };
          },
          runGate: async ({ runId }) => ({
            passed: true,
            results: [],
            testCount: runId.endsWith('-candidate-baseline-count')
              ? 10
              : candidateCount.get(runId),
          }),
          captureWorktreeSnapshot: async ({ cwd }) => ({ cwd }),
          restoreWorktreeSnapshot: async () => ({ restoredPaths: [] }),
          runReview: async ({ cwd }) => {
            mkdirSync(join(cwd, '__uro_review'), { recursive: true });
            writeFileSync(join(cwd, '__uro_review', 'REVIEW.md'),
              'Reviewed. No findings.\n');
            return { launchFailed: false, timedOut: false, usage: usage(2, 1) };
          },
        },
      },
    });

    assert.ok(maximumInFlight > 1,
      `candidate executors did not overlap; maximum in flight was ${maximumInFlight}`);
    assert.equal(result.rollup.outcome, 'review-ready');
    assert.equal(result.alternatives.status, 'awaiting-planner-decision');
    assert.match(result.alternatives.statement, /alternatives.*no selection has been made/i);

    const baseCommits = result.units.map((entry) => entry.facts.baseCommit);
    assert.equal(new Set(baseCommits).size, 1,
      `candidates did not share one base commit: ${JSON.stringify(baseCommits)}`);
    const repositories = await Promise.all(result.units.map((entry) => (
      gitOk(entry.facts.dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    )));
    assert.equal(new Set(repositories).size, 1,
      'identical content hashes are insufficient: candidates must share one repository');
    assert.equal(new Set(result.units.map((entry) => entry.facts.branch)).size, 3);

    const diffs = result.units.map((entry) => readFileSync(
      join(entry.facts.dir, 'CHANGES.diff'), 'utf8',
    ));
    assert.equal(new Set(diffs).size, 3, 'each candidate must retain its own distinct diff');
    result.units.forEach((entry, index) => {
      assert.match(diffs[index], new RegExp(`${entry.unitId}[.]txt`));
      assert.equal(entry.facts.perspective, entry.perspective);
      const persisted = JSON.parse(readFileSync(join(entry.facts.dir, 'uro-runfacts.json'), 'utf8'));
      assert.equal(persisted.perspective, entry.perspective);
    });

    const generated = events.filter((event) => event.type === 'candidate_generated');
    assert.deepEqual(generated.map((event) => [event.unitId, event.perspective]), [
      ['candidate-minimal', 'minimal-change'],
      ['candidate-refactor', 'refactor-first'],
      ['candidate-tests', 'test-first'],
    ]);
    const campaignStart = events.find((event) => (
      event.stage === 'campaign' && event.type === 'start'
    ));
    assert.equal(campaignStart.campaignShape, 'candidate-set');
    assert.equal(campaignStart.alternatives, true);
    const reviews = events.filter((event) => event.type === 'review_received');
    assert.equal(reviews.length, 3);
    assert.ok(reviews.every((event) => event.alternative === true && event.perspective));
    assert.ok(reviews.every((event) => event.review.reported === true));
    assert.ok(reviews.every((event) => event.review.blocking === 0));

    assert.deepEqual(result.alternatives.candidates.map((candidate) => ({
      perspective: candidate.perspective,
      reported: candidate.review.reported,
      blocking: candidate.review.blocking,
      delta: candidate.testCountDelta,
    })), [
      { perspective: 'minimal-change', reported: true, blocking: 0, delta: 1 },
      { perspective: 'refactor-first', reported: true, blocking: 0, delta: 2 },
      { perspective: 'test-first', reported: true, blocking: 0, delta: 3 },
    ]);
    assert.ok(result.alternatives.candidates.every((candidate) => candidate.diffPath));
    assert.ok(result.alternatives.candidates.every((candidate) => candidate.branch));
    assert.ok(result.alternatives.candidates.every((candidate) => candidate.tokenCost > 0));
  } finally {
    if (overlapDeadline !== undefined) clearTimeout(overlapDeadline);
    rmSync(target, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('candidate declarations reject missing or duplicate perspectives and every dependency', async () => {
  const cases = [
    {
      name: 'missing perspective',
      tasks: [
        { task: 'one', unitId: 'missing-one', unitKind: 'candidate' },
        {
          task: 'two', unitId: 'missing-two', unitKind: 'candidate', perspective: 'test-first',
        },
      ],
      pattern: /missing-one.*declare a perspective/i,
    },
    {
      name: 'duplicate perspective',
      tasks: [
        {
          task: 'one', unitId: 'duplicate-one', unitKind: 'candidate',
          perspective: 'minimal-change',
        },
        {
          task: 'two', unitId: 'duplicate-two', unitKind: 'candidate',
          perspective: 'MINIMAL-CHANGE',
        },
      ],
      pattern: /duplicate candidate perspective.*minimal-change/i,
    },
    {
      name: 'dependency',
      tasks: [
        {
          task: 'one', unitId: 'dependency-one', unitKind: 'candidate',
          perspective: 'minimal-change',
        },
        {
          task: 'two', unitId: 'dependency-two', unitKind: 'candidate',
          perspective: 'test-first', dependsOn: 'dependency-one',
        },
      ],
      pattern: /dependency-two.*cannot declare dependencies.*alternatives/i,
    },
    {
      name: 'different bases',
      tasks: [
        {
          task: 'one', unitId: 'base-one', unitKind: 'candidate',
          perspective: 'minimal-change', baseRef: 'main',
        },
        {
          task: 'two', unitId: 'base-two', unitKind: 'candidate',
          perspective: 'test-first', baseRef: 'release',
        },
      ],
      pattern: /candidates.*same base ref/i,
    },
  ];
  for (const invalid of cases) {
    let executorLaunches = 0;
    await assert.rejects(runCampaign({
      campaignId: `invalid-candidates-${invalid.name.replaceAll(' ', '-')}`,
      tasks: invalid.tasks,
      target: 'must-not-be-touched',
      gate: [],
      concurrency: 2,
      tokenBudget: 1000,
      runUnit: async () => {
        executorLaunches++;
        return adapterFacts('impossible');
      },
    }), invalid.pattern, invalid.name);
    assert.equal(executorLaunches, 0, `${invalid.name} launched an executor`);
  }
});

test('a failed alternative remains useful evidence while successful candidates complete', async () => {
  const events = [];
  const result = await runCampaign({
    campaignId: 'candidate-partial-failure',
    tasks: [
      {
        task: 'one', unitId: 'candidate-one', unitKind: 'candidate',
        perspective: 'minimal-change',
      },
      {
        task: 'two', unitId: 'candidate-two', unitKind: 'candidate',
        perspective: 'refactor-first',
      },
      {
        task: 'three', unitId: 'candidate-three', unitKind: 'candidate',
        perspective: 'test-first',
      },
    ],
    target: 'adapter-target',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    reporter: (event) => events.push(event),
    runUnit: async ({ runId }) => adapterFacts(
      runId,
      runId === 'candidate-two' ? 'executor-failed' : 'review-ready',
    ),
  });

  assert.deepEqual(result.units.map((entry) => entry.status),
    ['completed', 'completed', 'completed']);
  assert.equal(result.rollup.counts.failed, 1);
  assert.equal(result.rollup.counts.succeeded, 2);
  assert.equal(result.rollup.outcome, 'review-ready',
    'one failed alternative must not make the usable alternatives disappear');
  assert.equal(exitCodeFor(result.rollup.outcome), 0);
  const failed = result.alternatives.candidates.find((candidate) => (
    candidate.unitId === 'candidate-two'
  ));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.outcome, 'executor-failed');
  assert.equal(failed.successful, false);
  assert.match(failed.reason, /node --test exited with code 1/i);
  assert.equal(failed.review.reported, false,
    'a run that never converged has no review report to weigh');
  assert.equal(result.alternatives.candidates[0].status, 'succeeded');
  assert.ok(events.some((event) => (
    event.type === 'review_received'
      && event.unitId === 'candidate-two'
      && event.outcome === 'executor-failed'
  )));

  const forbiddenKeys = [];
  const visit = (value) => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/winner|selection|ranking|score/i.test(key)) forbiddenKeys.push(key);
      visit(child);
    }
  };
  visit(result);
  assert.deepEqual(forbiddenKeys, [],
    'the tool must return evidence without computing a winner, selection, ranking, or score');
});

test('a candidate set where every alternative fails has a non-zero campaign outcome', async () => {
  const result = await runCampaign({
    campaignId: 'candidate-all-failed',
    tasks: [
      {
        task: 'one', unitId: 'failed-one', unitKind: 'candidate', perspective: 'minimal-change',
      },
      {
        task: 'two', unitId: 'failed-two', unitKind: 'candidate', perspective: 'test-first',
      },
    ],
    target: 'adapter-target',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    runUnit: async ({ runId }) => adapterFacts(runId, 'verifier-failed'),
  });

  assert.equal(result.rollup.counts.failed, 2);
  assert.equal(result.rollup.counts.succeeded, 0);
  assert.equal(result.rollup.outcome, 'campaign-failed');
  assert.notEqual(exitCodeFor(result.rollup.outcome), 0);
  assert.ok(result.alternatives.candidates.every((candidate) => candidate.status === 'failed'));
  assert.ok(result.alternatives.candidates.every((candidate) => candidate.reason));
});
