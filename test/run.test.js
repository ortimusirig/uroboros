import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/args.js';
import {
  DEFAULT_EXECUTOR_EFFORT,
  DEFAULT_EXECUTOR_MODEL,
  EXECUTOR_PREAMBLE,
} from '../src/executor.js';
import {
  HARNESS_ARTIFACTS,
  run as executeRun,
  diffText,
  resolveDebateRounds,
} from '../src/run.js';
import { VERIFIED_SUPERPOWERS, withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { PIVOT_CONCLUDE, PIVOT_FRESH } from '../src/debate.js';
import { EMPTY_USAGE } from '../src/usage.js';
import { DEFAULT_ARBITER_MODEL } from '../src/arbiter.js';
import {
  DEFAULT_VERIFIER_MODEL,
  parseVerdictDetail,
  REVIEW_PROMPT,
} from '../src/verifier.js';
import { spawnCapture } from '../src/spawn.js';
import { exitCodeFor } from '../src/exit.js';

const run = (options) => executeRun(withVerifiedSuperpowers(options));

function makeTarget(withFile = true) {
  const d = mkdtempSync(join(tmpdir(), 'tgt-'));
  if (withFile) writeFileSync(join(d, 'seed.txt'), 'seed');
  return d;
}
// Scratch base must satisfy assertSafeScratchRoot: NOT under AppData or OneDrive.
// os.tmpdir() is under AppData on Windows and process.cwd() is under OneDrive for a
// checkout that lives in a synced folder — both are rejected by the guard. Mirror the
// production default from bin/loop.js, which is safe by the same construction.
const SAFE_SCRATCH_BASE = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));
const scratch = () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SAFE_SCRATCH_BASE, '.ccc-test-'));
};

// Executor fake that writes a file into the isolated dir, so the diff is non-empty.
const writingExecutor = async ({ cwd }) => {
  writeFileSync(join(cwd, 'new.txt'), 'content');
  return { changedFiles: ['new.txt'], lastMessage: 'wrote new.txt' };
};
const noopExecutor = async () => ({ changedFiles: [], lastMessage: 'nothing to do' });
const freshPlanningAdapters = {
  draftPlanCandidate: async ({ candidateId }) => ({
    plan: `Fresh implementation plan from ${candidateId}.\n`,
    gate: [],
  }),
  
  selectPlanCandidate: async () => ({ selectedCandidateId: 'candidate-1' }),
};

const DECISION_CONTENT = `
## Q1
Kind: technical
Question: Should this follow the existing implementation convention?
Options: follow the task literally, follow the existing convention
Recommendation: follow the existing convention
`;

const AUTHORITY_DECISION_CONTENT = `
## Q1
Kind: authority
Question: May the executor choose on the operator's behalf?
Options: halt, follow the isolated-worktree recommendation
Recommendation: follow the isolated-worktree recommendation
`;

test('one holistic review report carries correctness and intent findings into the record', async () => {
  const scr = scratch();
  const reviewCalls = [];
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'f1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runReview: reviewerForRounds([
        `${suggestionReview('F1')}\n## F2\nSeverity: suggestion\nCategory: intent\nDescription: The shared-scope requirement was dropped.\n`,
      ], reviewCalls),
    },
  });
  assert.equal(facts.outcome, 'review-ready');
  const round = facts.debate.roundHistory[0];
  assert.deepEqual(round.findingIds, ['F1', 'F2']);
  assert.equal(round.findings[1].category, 'intent');
  assert.equal(round.findings[1].description, 'The shared-scope requirement was dropped.');
  // The two-seat verdict surface is gone from the facts entirely.
  for (const gone of ['verdict', 'correctnessVerdict', 'intentVerdict',
    'verifierFindings', 'intentVerifierFindings']) {
    assert.equal(Object.hasOwn(facts, gone), false, `${gone} must not exist`);
  }
  assert.equal(facts.baseRef, 'HEAD');
  assert.match(facts.baseCommit, /^[0-9a-f]{40,64}$/);
  assert.equal(facts.branch, 'uro/f1');
  assert.equal(reviewCalls.length, 1, 'one seat, one report');
  assert.equal(reviewCalls[0].prompt, REVIEW_PROMPT,
    'a clean evidence trail appends nothing to the review prompt');
  rmSync(scr, { recursive: true, force: true });
});

test('debate fix rounds accumulate usage and model overrides reach both agents and run facts', async () => {
  const scr = scratch();
  const executorCalls = [];
  const verifierCalls = [];
  let executorCall = 0;
  let gateCall = 0;
  const executorUsages = [
    { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2,
      reasoningOutputTokens: 1, cacheWriteTokens: 0 },
    { inputTokens: 20, cachedInputTokens: 10, outputTokens: 3,
      reasoningOutputTokens: 2, cacheWriteTokens: 1 },
  ];
  const roundOneUsage = { inputTokens: 18, cachedInputTokens: 9, outputTokens: 14,
    reasoningOutputTokens: 0, cacheWriteTokens: 5 };
  const roundTwoUsage = { inputTokens: 18, cachedInputTokens: 9, outputTokens: 14,
    reasoningOutputTokens: 0, cacheWriteTokens: 5 };
  const cliOpts = parseArgs(['run', '--task', 'do the task', '--target', makeTarget(),
    '--gate', 'unused-gate.json', '--gate-retries', '1',
    '--executor-model', 'executor-override', '--executor-effort', 'medium',
    '--verifier-model', 'verifier-override']);
  const facts = await run({
    ...cliOpts, gate: [],
    scratchRoot: scr, runId: 'usage-models',
    adapters: {
      runExecutor: async (opts) => {
        executorCalls.push(opts);
        writeFileSync(join(opts.cwd, 'new.txt'), 'content');
        return { changedFiles: ['new.txt'], lastMessage: `attempt ${executorCall + 1}`,
          usage: executorUsages[executorCall++] };
      },
      runGate: async () => { gateCall++; return { passed: true, results: [] }; },
      // Round one's report files a blocking finding to force a fix round;
      // round two's report is clean, so the debate converges.
      runReview: (() => {
        const reviewer = reviewerForRounds([blockingReview(), null], verifierCalls);
        let round = 0;
        return async (opts) => {
          const result = await reviewer(opts);
          round++;
          return { ...result, usage: round === 1 ? roundOneUsage : roundTwoUsage };
        };
      })(),
    },
  });
  assert.equal(executorCalls.length, 2, 'initial execution plus one debate fix round');
  for (const call of executorCalls) {
    assert.equal(call.model, 'executor-override');
    assert.equal(call.effort, 'medium');
  }
  assert.equal(verifierCalls.length, 2, 'two rounds, one reviewer each');
  for (const call of verifierCalls) assert.equal(call.model, 'verifier-override');
  assert.deepEqual(verifierCalls.map((call) => call.prompt),
    [REVIEW_PROMPT, REVIEW_PROMPT]);
  assert.deepEqual(facts.model, {
    executor: 'executor-override', executorEffort: 'medium', verifier: 'verifier-override',
    arbiter: DEFAULT_ARBITER_MODEL,
  });
  assert.deepEqual(facts.iterations[0].executorUsage, executorUsages[0]);
  assert.deepEqual(facts.iterations[1].executorUsage, executorUsages[1]);
  assert.deepEqual(facts.tokens, {
    executor: { inputTokens: 30, cachedInputTokens: 15, outputTokens: 5,
      reasoningOutputTokens: 3, cacheWriteTokens: 1 },
    verifier: { inputTokens: 36, cachedInputTokens: 18, outputTokens: 28,
      reasoningOutputTokens: 0, cacheWriteTokens: 10 },
    arbiter: EMPTY_USAGE,
    total: { inputTokens: 66, cachedInputTokens: 33, outputTokens: 33,
      reasoningOutputTokens: 3, cacheWriteTokens: 11 },
  });
  assert.equal(facts.debate.roundsRun, 2);
  assert.deepEqual(facts.debate.findingsPerRound, [['F1'], []]);
  assert.equal(Object.hasOwn(facts, 'verdictSource'), false);
  assert.equal(Object.hasOwn(facts, 'gateFailure'), false);
  rmSync(scr, { recursive: true, force: true });
});

// The retained-evidence verdict-consistency surface died with the verdict
// passes; checkVerdictConsistency remains covered in verifier.test.js where
// the transport lives.
test('a token invariant violation is reported without failing a completed run', async () => {
  const scr = scratch();
  const target = makeTarget();
  try {
    const facts = await run({
      task: 'do the task', target, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'usage-disagreement',
      adapters: {
        runExecutor: async (opts) => {
          await writingExecutor(opts);
          return {
            changedFiles: ['new.txt'],
            lastMessage: 'wrote new.txt',
            usage: {
              inputTokens: 10,
              cachedInputTokens: 30,
              outputTokens: 2,
              reasoningOutputTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        },
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => ({
          verdict: 'NO_BLOCKERS', launchFailed: false, usage: EMPTY_USAGE,
        }),
      },
    });

    assert.equal(facts.outcome, 'review-ready', 'accounting diagnostics must not fail the run');
    assert.equal(facts.usageConsistency.status, 'disagreement');
    const violation = facts.usageConsistency.checks.find((check) => (
      check.seat === 'executor' && check.status === 'disagreement'
    ));
    assert.ok(violation, 'the executor violation must be retained in run facts');
    assert.equal(violation.invariant, 'cachedInputTokens <= inputTokens');
    assert.equal(violation.inputTokens, 10);
    assert.equal(violation.cachedInputTokens, 30);

    const persisted = JSON.parse(readFileSync(join(facts.dir, 'uro-runfacts.json'), 'utf8'));
    assert.equal(persisted.usageConsistency.status, 'disagreement');
    const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
    assert.match(report, /token accounting bookkeeping disagreement/i);
    assert.match(report, /input 10, cached input 30/i);
  } finally {
    rmSync(scr, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('omitted model flags travel through the CLI path to both agents and run-fact defaults', async () => {
  const scr = scratch();
  const executorCalls = [];
  const verifierCalls = [];
  const cliOpts = parseArgs(['run', '--task', 'do the task', '--target', makeTarget(),
    '--gate', 'unused-gate.json']);
  const facts = await run({
    ...cliOpts, gate: [], scratchRoot: scr, runId: 'default-models',
    adapters: {
      runExecutor: async (opts) => {
        executorCalls.push(opts);
        return writingExecutor(opts);
      },
      runGate: async () => ({ passed: true, results: [] }),
      runReview: reviewerForRounds([null], verifierCalls),
    },
  });

  assert.equal(executorCalls[0].model, DEFAULT_EXECUTOR_MODEL);
  assert.equal(executorCalls[0].effort, DEFAULT_EXECUTOR_EFFORT);
  assert.equal(Object.hasOwn(executorCalls[0], 'superpowersDir'), false);
  assert.deepEqual(verifierCalls.map((call) => call.model), [DEFAULT_VERIFIER_MODEL]);
  assert.deepEqual(verifierCalls.map((call) => call.superpowersDir),
    [VERIFIED_SUPERPOWERS.seats.cursor.path]);
  assert.deepEqual(facts.model, {
    executor: DEFAULT_EXECUTOR_MODEL,
    executorEffort: DEFAULT_EXECUTOR_EFFORT,
    verifier: DEFAULT_VERIFIER_MODEL,
    arbiter: DEFAULT_ARBITER_MODEL,
  });
  assert.equal(facts.skills, VERIFIED_SUPERPOWERS.seats.cursor.path);
  assert.deepEqual(facts.superpowers, VERIFIED_SUPERPOWERS);
  rmSync(scr, { recursive: true, force: true });
});

test('TASK.md is written before execution, excluded from the diff, and the reviewer launches', async () => {
  let launches = 0;
  const scr = scratch();
  const plan = 'Implement the exact requested behavior.\nDo not narrow shared scope.\n';
  const composedPlan = `${EXECUTOR_PREAMBLE}\n\n${plan}`;
  const target = makeTarget();
  const facts = await run({
    task: plan, target, gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'g1',
    adapters: {
      runExecutor: async ({ cwd, plan: received }) => {
        assert.ok(received.startsWith(EXECUTOR_PREAMBLE));
        assert.equal(received.slice(EXECUTOR_PREAMBLE.length + 2), plan,
          'the operator plan must survive byte-for-byte after the preamble');
        assert.equal(received, composedPlan);
        assert.equal(readFileSync(join(cwd, 'TASK.md'), 'utf8'), received,
          'TASK.md must exactly match the text sent to the executor');
        return writingExecutor({ cwd });
      },
      runGate: async () => ({ passed: true, results: [] }),
      runReview: (() => {
        const reviewer = reviewerForRounds([null]);
        return async (opts) => { launches++; return reviewer(opts); };
      })(),
    },
  });
  assert.equal(facts.outcome, 'review-ready');
  assert.equal(launches, 1);
  assert.ok(existsSync(join(facts.dir, 'CHANGES.diff')), 'CHANGES.diff handed to the reviewer');
  const diff = readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8');
  assert.match(diff, /new[.]txt/);
  assert.doesNotMatch(diff, /TASK[.]md/);
  assert.equal(existsSync(join(target, 'TASK.md')), false, 'the target must remain untouched');
  rmSync(scr, { recursive: true, force: true });
});

test('run reads an existing .txt task file instead of executing its path string', async () => {
  const scr = scratch();
  const taskDir = mkdtempSync(join(tmpdir(), 'run-task-'));
  const taskPath = join(taskDir, 'plan.txt');
  const plan = 'Use the contents of the text task file.\n';
  const composedPlan = `${EXECUTOR_PREAMBLE}\n\n${plan}`;
  writeFileSync(taskPath, plan);
  const facts = await run({
    task: taskPath, target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'txt-task',
    adapters: {
      runExecutor: async ({ cwd, plan: received }) => {
        assert.equal(received, composedPlan,
          'the executor must receive framed file contents, not the .txt path');
        assert.equal(readFileSync(join(cwd, 'TASK.md'), 'utf8'), received);
        return noopExecutor();
      },
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { throw new Error('no-op must not launch a reviewer'); },
    },
  });
  assert.equal(facts.outcome, 'no-op');
  rmSync(taskDir, { recursive: true, force: true });
  rmSync(scr, { recursive: true, force: true });
});

test('the first call is verbatim and a fix round carries the failing evidence', async () => {
  const scr = scratch();
  const plan = 'Implement the requested behavior exactly.\nKeep the original plan unchanged.\n';
  const composedPlan = `${EXECUTOR_PREAMBLE}\n\n${plan}`;
  const executorPlans = [];
  let gateCall = 0;
  const failure = {
    bin: 'node', args: ['--test', 'test/repair.test.js'], code: 7,
    outputTail: '[stdout]\nrepair test failed\n[stderr]\nexpected true but received false',
  };
  const facts = await run({
    task: plan, target: makeTarget(), gate: [], gateRetries: 1,
    scratchRoot: scr, runId: 'retry-context',
    adapters: {
      runExecutor: async (opts) => {
        executorPlans.push(opts.plan);
        return writingExecutor(opts);
      },
      runGate: async () => gateCall++ === 0
        ? { passed: false, results: [failure] }
        : { passed: true, results: [] },
      // The fix round is driven by a finding; the failing command travels with it.
      runReview: reviewerForRounds([blockingReview(), null]),
    },
  });

  assert.equal(executorPlans.length, 2);
  assert.equal(executorPlans[0], composedPlan,
    'the initial executor prompt must frame the verbatim plan');
  assert.match(executorPlans[1], /Previous gate attempt failed/);
  assert.match(executorPlans[1], /"bin":"node"/);
  assert.match(executorPlans[1], /"--test","test\/repair[.]test[.]js"/);
  assert.match(executorPlans[1], /Exit code: 7/);
  assert.ok(executorPlans[1].includes(failure.outputTail));
  assert.equal(readFileSync(join(facts.dir, 'TASK.md'), 'utf8'), executorPlans[1],
    'TASK.md must match the final fix text the executor received');
  rmSync(scr, { recursive: true, force: true });
});

test('each fix round receives only the immediately preceding failing evidence', async () => {
  const scr = scratch();
  const plan = 'Repair the implementation.';
  const composedPlan = `${EXECUTOR_PREAMBLE}\n\n${plan}`;
  const executorPlans = [];
  const firstFailure = {
    bin: 'node', args: ['--test', 'test/first.test.js'], code: 11,
    outputTail: '[stdout]\nFIRST_FAILURE_ONLY\n[stderr]\nfirst stack',
  };
  const secondFailure = {
    bin: 'npm', args: ['run', 'second-check'], code: 22,
    outputTail: '[stdout]\nSECOND_FAILURE_ONLY\n[stderr]\nsecond stack',
  };
  const gateResults = [
    { passed: false, results: [firstFailure] },
    { passed: false, results: [secondFailure] },
    { passed: true, results: [] },
  ];
  const facts = await run({
    task: plan, target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'fresh-retry-context',
    adapters: {
      runExecutor: async (opts) => {
        executorPlans.push(opts.plan);
        return writingExecutor(opts);
      },
      runGate: async () => gateResults.shift(),
      // Two rounds of findings drive two fix rounds; the third review is clean.
      runReview: reviewerForRounds([blockingReview('F1'), blockingReview('F2'), null]),
    },
  });

  assert.equal(executorPlans.length, 3);
  assert.equal(executorPlans[0], composedPlan);
  assert.ok(executorPlans[1].includes('FIRST_FAILURE_ONLY'));
  assert.ok(!executorPlans[1].includes('SECOND_FAILURE_ONLY'));
  assert.match(executorPlans[1], /Exit code: 11/);
  assert.ok(executorPlans[2].includes('SECOND_FAILURE_ONLY'));
  assert.ok(!executorPlans[2].includes('FIRST_FAILURE_ONLY'),
    'the second retry must not accumulate the first failure');
  assert.match(executorPlans[2], /"bin":"npm"/);
  assert.match(executorPlans[2], /Exit code: 22/);
  rmSync(scr, { recursive: true, force: true });
});

test('a green first gate never augments the executor prompt', async () => {
  const scr = scratch();
  const plan = 'Make one focused change.\n';
  const composedPlan = `${EXECUTOR_PREAMBLE}\n\n${plan}`;
  const executorPlans = [];
  const facts = await run({
    task: plan, target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'green-no-retry-context',
    adapters: {
      runExecutor: async (opts) => {
        executorPlans.push(opts.plan);
        return writingExecutor(opts);
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.outcome, 'review-ready');
  assert.deepEqual(executorPlans, [composedPlan]);
  assert.doesNotMatch(executorPlans[0], /Previous gate attempt failed/);
  rmSync(scr, { recursive: true, force: true });
});

test('a reviewer launch failure yields verifier-failed', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'vf1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { throw new Error('reviewer CLI would not start'); },
    },
  });
  assert.equal(facts.outcome, 'verifier-failed');
  assert.equal(facts.debate.stopReason, 'review-failed');
  assert.match(facts.iterations[0].reviewer.error, /reviewer CLI would not start/);
  rmSync(scr, { recursive: true, force: true });
});

test('a reviewer that runs but writes no report yields verifier-failed', async () => {
  // Silence is not consent in execution either: a seat that launched and
  // produced no REVIEW.md did not review, and the run says so.
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'vf2',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => ({ launchFailed: false, timedOut: false }),
    },
  });
  assert.equal(facts.outcome, 'verifier-failed');
  assert.equal(facts.debate.stopReason, 'unreviewed');
  rmSync(scr, { recursive: true, force: true });
});

test('empty diff → verifier is NOT launched (no-op)', async () => {
  let launches = 0;
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'e1',
    adapters: {
      runExecutor: noopExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { launches++; return { launchFailed: false, timedOut: false }; },
    },
  });
  assert.equal(launches, 0, 'no diff means nothing to review');
  assert.equal(facts.outcome, 'no-op');
  assert.equal(readFileSync(join(facts.dir, 'TASK.md'), 'utf8'),
    `${EXECUTOR_PREAMBLE}\n\ndo the task`);
  assert.equal(await diffText(facts.dir), '',
    'TASK.md and generated report artifacts must not turn a no-op into a change');
  rmSync(scr, { recursive: true, force: true });
});

// The UNVERIFIED marker died with the verdict passes. A seat that cannot
// review now surfaces as a launch failure, a timeout, or a missing report —
// all covered above.
test('a failing verifier preflight probe stops before executor dispatch', async () => {
  let executorCalled = false;
  const target = makeTarget();
  try {
    await assert.rejects(
      () => run({
        task: 'do the task', target, gate: [], gateRetries: 0,
        scratchRoot: 'unused-because-preflight-fails', runId: 'probe-failed',
        adapters: {
          probeVerifier: async () => ({
            ok: false,
            reason: 'verifier liveness probe failed for agent: tried "agent --version"; exited 9',
          }),
          runExecutor: async () => {
            executorCalled = true;
            return { changedFiles: [], lastMessage: 'must not run' };
          },
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
        },
      }),
      /agent.*agent --version.*exited 9/i,
    );
    assert.equal(executorCalled, false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('a passing verifier preflight probe leaves executor dispatch unchanged', async () => {
  const scr = scratch();
  let executorCalled = false;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'probe-passed',
    adapters: {
      probeVerifier: async () => ({ ok: true, reason: null }),
      runExecutor: async () => {
        executorCalled = true;
        return { changedFiles: [], lastMessage: 'nothing to do' };
      },
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { throw new Error('no-op must not verify'); },
    },
  });

  assert.equal(executorCalled, true);
  assert.equal(facts.outcome, 'no-op');
  rmSync(scr, { recursive: true, force: true });
});

test('a sentinel-only executor challenge needs a decision in manual mode', async () => {
  const scr = scratch();
  const events = [];
  let gateCalls = 0;
  let verifierCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'manual-decision', mode: 'manual',
    reporter: (event) => events.push(event),
    adapters: {
      runExecutor: async ({ cwd }) => {
        writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
        return { changedFiles: ['DECISION.md'], lastMessage: 'need a decision', exitCode: 0 };
      },
      runGate: async () => {
        gateCalls++;
        return { passed: true, results: [] };
      },
      runReview: async () => {
        verifierCalls++;
        throw new Error('reviewer must not launch for a challenge');
      },
    },
  });

  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(gateCalls, 0);
  assert.equal(verifierCalls, 0);
  assert.equal(facts.decision.questions.length, 1);
  assert.equal(facts.decision.questions[0].id, 'Q1');
  assert.equal(facts.decision.mode, 'manual');
  assert.equal(facts.decision.challengeRound, 1);
  assert.equal(events.filter((event) => (
    event.stage === 'decision' && event.type === 'challenged'
  )).length, 1);
  rmSync(scr, { recursive: true, force: true });
});

test('a clean executor run is unchanged in every mode', async () => {
  const scr = scratch();
  for (const mode of ['manual', 'autonomous']) {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: `${mode}-noop`, mode,
      decisionResolver: async () => { throw new Error('no challenge must not resolve'); },
      adapters: {
        runExecutor: async () => ({ changedFiles: [], lastMessage: 'nothing', exitCode: 0 }),
        runGate: async () => ({ passed: true, results: [] }),
        runReview: async () => { throw new Error('verifier must not launch for no-op'); },
      },
    });
    assert.equal(facts.outcome, 'no-op');
    assert.equal(facts.decision, undefined);
  }
  rmSync(scr, { recursive: true, force: true });
});

test('a sentinel plus substantive files follows the normal gate and verifier path', async () => {
  const scr = scratch();
  let gateCalls = 0;
  let verifierCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'decision-with-work', mode: 'manual',
    adapters: {
      runExecutor: async ({ cwd }) => {
        writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
        writeFileSync(join(cwd, 'new.txt'), 'substantive work');
        return {
          changedFiles: ['DECISION.md', 'new.txt'],
          lastMessage: 'wrote a sentinel and real work',
          exitCode: 0,
        };
      },
      runGate: async () => {
        gateCalls++;
        return { passed: true, results: [] };
      },
      runReview: (() => {
        const reviewer = reviewerForRounds([null]);
        return async (opts) => { verifierCalls++; return reviewer(opts); };
      })(),
    },
  });

  assert.equal(facts.outcome, 'review-ready');
  assert.equal(gateCalls, 1);
  assert.equal(verifierCalls, 1);
  assert.equal(facts.decision, undefined);
  rmSync(scr, { recursive: true, force: true });
});

test('autonomous mode resolves a sentinel challenge and reruns the executor', async () => {
  const scr = scratch();
  const events = [];
  const executorPlans = [];
  const resolverCalls = [];
  let executorCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'autonomous-decision', mode: 'autonomous',
    reporter: (event) => events.push(event),
    decisionResolver: async (input) => {
      resolverCalls.push(input);
      return { answers: [{ id: 'Q1', answer: 'Follow the existing convention.' }] };
    },
    adapters: {
      runExecutor: async ({ cwd, plan }) => {
        executorCalls++;
        executorPlans.push(plan);
        if (executorCalls === 1) {
          writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
          return { changedFiles: ['DECISION.md'], lastMessage: 'need a decision', exitCode: 0 };
        }
        writeFileSync(join(cwd, 'new.txt'), 'resolved work');
        return { changedFiles: ['new.txt'], lastMessage: 'implemented the answer', exitCode: 0 };
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.outcome, 'review-ready');
  assert.equal(executorCalls, 2);
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].plan, 'do the task');
  assert.equal(resolverCalls[0].task, 'do the task');
  assert.equal(executorPlans[0], `${EXECUTOR_PREAMBLE}\n\ndo the task`);
  assert.ok(executorPlans[1].startsWith(`${EXECUTOR_PREAMBLE}\n\ndo the task`),
    'the challenge rerun must retain the same framed plan');
  assert.match(executorPlans[1], /## Decision — resolved autonomously/);
  assert.match(executorPlans[1], /Answer: Follow the existing convention\./);
  assert.equal(readFileSync(join(facts.dir, 'TASK.md'), 'utf8'), executorPlans[1]);
  assert.equal(existsSync(join(facts.dir, 'DECISION.md')), false);
  const resolved = events.find((event) => (
    event.stage === 'decision' && event.type === 'resolved'
  ));
  assert.equal(resolved.answeredBy, 'planner');
  assert.equal(facts.decision.answeredBy, 'planner');
  rmSync(scr, { recursive: true, force: true });
});

test('an authority answer is rejected while operator-presence evidence is present', async () => {
  const scr = scratch();
  let executorCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'authority-present', mode: 'autonomous',
    decisionResolver: async () => ({
      answers: [{ id: 'Q1', answer: 'follow the recommendation' }],
      escalation: 'operator-absent',
      presenceEvidence: { ttyAttached: true, invocation: 'interactive' },
      reasoning: 'The operator is actually present.',
    }),
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCalls++;
        writeFileSync(join(cwd, 'DECISION.md'), AUTHORITY_DECISION_CONTENT);
        return { changedFiles: ['DECISION.md'], lastMessage: 'need authority', exitCode: 0 };
      },
      runGate: async () => { throw new Error('gate must not run'); },
      runReview: async () => { throw new Error('verifier must not run'); },
    },
  });

  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(executorCalls, 1);
  assert.equal(facts.decision.questions[0].kind, 'authority');
  rmSync(scr, { recursive: true, force: true });
});

test('an authority question with no TTY is recorded as an operator-absent assumption', async () => {
  const scr = scratch();
  const events = [];
  let executorCalls = 0;
  const presenceEvidence = {
    ttyAttached: false,
    invocation: 'non-interactive',
    operatorWait: 'not-acknowledged',
  };
  const reasoning = 'No TTY was attached, so there was no operator available to answer.';
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'authority-absent', mode: 'autonomous',
    reporter: (event) => events.push(event),
    decisionResolver: async () => ({
      answers: [{ id: 'Q1', answer: 'follow the isolated-worktree recommendation' }],
      escalation: 'operator-absent',
      presenceEvidence,
      reasoning,
    }),
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCalls++;
        if (executorCalls === 1) {
          writeFileSync(join(cwd, 'DECISION.md'), AUTHORITY_DECISION_CONTENT);
          return { changedFiles: ['DECISION.md'], lastMessage: 'need authority', exitCode: 0 };
        }
        writeFileSync(join(cwd, 'new.txt'), 'resolved authority work');
        return { changedFiles: ['new.txt'], lastMessage: 'continued safely', exitCode: 0 };
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.outcome, 'review-ready');
  assert.equal(executorCalls, 2);
  assert.equal(facts.decision.escalation, 'operator-absent');
  assert.equal(facts.escalation, 'operator-absent');
  assert.equal(facts.decision.answeredBy, 'planner');
  assert.deepEqual(facts.decision.presenceEvidence, presenceEvidence);
  assert.equal(facts.decision.reasoning, reasoning);
  const assumed = events.find((event) => (
    event.stage === 'decision' && event.type === 'assumed'
  ));
  assert.deepEqual(assumed.questions, facts.decision.questions);
  assert.deepEqual(assumed.answers, facts.decision.answers);
  assert.deepEqual(assumed.presenceEvidence, presenceEvidence);
  assert.equal(assumed.reasoning, reasoning);
  const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
  assert.match(report, /This was decided without you/);
  assert.ok(report.indexOf('This was decided without you') < report.indexOf('## What changed'));
  assert.match(report, /TTY attached: no; invocation: non-interactive/);
  rmSync(scr, { recursive: true, force: true });
});

test('challenge-round exhaustion halts instead of starting another executor', async () => {
  const scr = scratch();
  let executorCalls = 0;
  let resolverCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'challenge-exhaustion', mode: 'autonomous', challengeRounds: 2,
    decisionResolver: async () => {
      resolverCalls++;
      return { answers: [{ id: 'Q1', answer: 'follow the recommendation' }] };
    },
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCalls++;
        writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
        return { changedFiles: ['DECISION.md'], lastMessage: 'challenge again', exitCode: 0 };
      },
      runGate: async () => { throw new Error('gate must not run'); },
      runReview: async () => { throw new Error('verifier must not run'); },
    },
  });

  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(facts.decision.challengeRound, 2);
  assert.equal(executorCalls, 2);
  assert.equal(resolverCalls, 1);
  rmSync(scr, { recursive: true, force: true });
});

test('a resolver returning no answers halts without rerunning the executor', async () => {
  const scr = scratch();
  let executorCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'empty-resolution', mode: 'autonomous',
    decisionResolver: async () => ({ answers: [] }),
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCalls++;
        writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
        return { changedFiles: ['DECISION.md'], lastMessage: 'need a decision', exitCode: 0 };
      },
      runGate: async () => { throw new Error('gate must not run'); },
      runReview: async () => { throw new Error('verifier must not run'); },
    },
  });

  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(executorCalls, 1);
  assert.equal(existsSync(join(facts.dir, 'DECISION.md')), true);
  rmSync(scr, { recursive: true, force: true });
});

// The old "challenge during a gate retry" scenario has no equivalent in the
// evidence flow: a debate fix round presupposes a substantive diff, and
// routeChallenges deliberately ignores a sentinel beside one (a challenge
// presupposes none). Both surviving behaviours are covered by their own tests:
// "a sentinel-only executor challenge needs a decision in manual mode" and
// "a sentinel plus substantive files follows the normal gate and verifier path".

test('--mode accepts manual or autonomous and rejects other values', () => {
  const base = ['run', '--task', 'p', '--target', 't', '--gate', 'g'];
  assert.equal(parseArgs([...base, '--mode', 'manual']).mode, 'manual');
  assert.equal(parseArgs([...base, '--mode', 'autonomous']).mode, 'autonomous');
  assert.throws(() => parseArgs([...base, '--mode', 'interactive']), /invalid --mode/i);
});

test('non-zero executor exit with an empty diff is executor-failed', async () => {
  let verifierCalls = 0;
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'executor-failed-empty-diff',
    adapters: {
      runExecutor: async () => ({
        changedFiles: [], lastMessage: 'executor aborted before making changes', exitCode: 1,
      }),
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => {
        verifierCalls++;
        throw new Error('an empty diff must not launch a reviewer');
      },
    },
  });
  assert.equal(facts.outcome, 'executor-failed',
    'a non-zero executor exit with no diff must be reported as executor-failed');
  assert.equal(verifierCalls, 0, 'an empty diff must not launch a verifier');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  rmSync(scr, { recursive: true, force: true });
});

test('zero executor exit with an empty diff remains a successful no-op', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'clean-empty-diff',
    adapters: {
      runExecutor: async () => ({ changedFiles: [], lastMessage: 'nothing to do', exitCode: 0 }),
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { throw new Error('a no-op must not launch a verifier'); },
    },
  });
  assert.equal(facts.outcome, 'no-op');
  assert.equal(exitCodeFor(facts.outcome), 0);
  rmSync(scr, { recursive: true, force: true });
});

test('an approval-request message names the advisory no-op reason without changing status', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'Implement the requested behavior.', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'approval-request-no-op',
    adapters: {
      runExecutor: async () => ({
        changedFiles: [],
        agentMessages: ['I reviewed the design.', "Approve this design and I'll implement it."],
        lastMessage: "Approve this design and I'll implement it.",
        exitCode: 0,
      }),
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => { throw new Error('a no-op must not launch a verifier'); },
    },
  });

  assert.equal(facts.noOpReason, 'approval-requested');
  assert.equal(facts.outcome, 'no-op');
  assert.equal(exitCodeFor(facts.outcome), 0);
  const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
  assert.match(report, /approval-requested/);
  assert.match(report, /DECISION[.]md/);
  rmSync(scr, { recursive: true, force: true });
});

test('unrelated executor prose does not label an empty successful pass as approval-requested',
  async () => {
    const scr = scratch();
    const facts = await run({
      task: 'Implement the requested behavior.', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'ordinary-no-op',
      adapters: {
        runExecutor: async () => ({
          changedFiles: [],
          agentMessages: ['The approved design is already implemented; no changes are needed.'],
          lastMessage: 'The approved design is already implemented; no changes are needed.',
          exitCode: 0,
        }),
        runGate: async () => ({ passed: true, results: [] }),
        runReview: async () => { throw new Error('a no-op must not launch a verifier'); },
      },
    });

    assert.equal(facts.outcome, 'no-op');
      assert.equal(exitCodeFor(facts.outcome), 0);
    assert.equal(Object.hasOwn(facts, 'noOpReason'), false);
    assert.doesNotMatch(readFileSync(join(facts.dir, 'uro-report.md'), 'utf8'),
      /approval-requested/);
    rmSync(scr, { recursive: true, force: true });
  });

test('a non-zero exit is evidence in front of the seats, never a verdict', async () => {
  // "No green, no red." The command ran once, its exit code and output are on
  // the record, and the reviewer is told in one argv-safe line and asked to
  // judge. With the reviewer satisfied the run converges — nothing anywhere
  // branches on the exit code, and no gateStatus or gateFailure field exists.
  let gateCalls = 0;
  const prompts = [];
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'r1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async ({ onEvidence }) => {
        gateCalls++;
        onEvidence?.({
          bin: 'node', args: ['--test'], code: 1,
          stdout: 'failed assertion', stderr: 'stack trace',
        });
        return { passed: false, results: [{
          bin: 'node', args: ['--test'], code: 1,
          outputTail: '[stdout]\nfailed assertion\n[stderr]\nstack trace',
        }] };
      },
      runReview: (() => {
        const reviewer = reviewerForRounds([null]);
        return async (opts) => { prompts.push(opts.prompt); return reviewer(opts); };
      })(),
    },
  });
  assert.equal(facts.outcome, 'review-ready',
    'the reviewer satisfied means converged; an exit code cannot veto it');
  assert.equal(prompts.length, 1, 'the reviewer reviews, whatever the exit');
  for (const prompt of prompts) {
    assert.match(prompt, /EVIDENCE: node exited 1/);
    assert.match(prompt, /indicts the change or the command itself/);
    assert.doesNotMatch(prompt, /"/, 'the evidence note must stay argv-safe');
  }
  assert.equal(gateCalls, 1, 'commands run once as evidence — the retry loop is gone');
  assert.equal(Object.hasOwn(facts, 'gateStatus'), false, 'no verdict field survives');
  assert.equal(Object.hasOwn(facts, 'gateFailure'), false);
  assert.equal(facts.evidence.filter((entry) => entry.code !== 0).length, 1);
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out executor stops the run, is recorded, and maps to a non-zero process exit', async () => {
  const scr = scratch();
  let gateCalls = 0;
  let verifierCalls = 0;
  const facts = await run({
    task: 'Implement the requested timeout behavior.', target: makeTarget(), gate: [],
    gateRetries: 2, scratchRoot: scr, runId: 'executor-timeout',
    adapters: {
      runExecutor: async () => ({ changedFiles: [], lastMessage: 'partial work',
        timedOut: true, timeoutMs: 25, exitCode: -1 }),
      runGate: async () => { gateCalls++; return { passed: true, results: [] }; },
      runReview: async () => { verifierCalls++; return { launchFailed: false, timedOut: false }; },
    },
  });
  assert.equal(facts.outcome, 'timed-out');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.equal(gateCalls, 0, 'a timed-out executor must not advance to the gate');
  assert.equal(verifierCalls, 0);
  assert.equal(facts.iterations[0].executor.timedOut, true);
  assert.deepEqual(facts.timeoutEvents, [
    { stage: 'executor', iteration: 1, attempt: 1, timeoutMs: 25 },
  ]);
  assert.match(readFileSync(join(facts.dir, 'uro-report.md'), 'utf8'),
    /executor: timed out after 25 ms/i);
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out executor commits partial work and writes an artifact-free diff before kill', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'Preserve partial work before timeout.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'partial-timeout', reporter: () => {},
    adapters: {
      runExecutor: async (opts) => {
        writeFileSync(join(opts.cwd, 'partial.js'), 'export const partial = true;\n');
        writeFileSync(join(opts.cwd, 'events.jsonl'), '{"harness":true}\n');
        await opts.beforeKill({
          kind: 'deadline', timeoutMs: 25, gapMs: 25,
          lastEvent: { stage: 'executor', type: 'start', attempt: opts.attempt },
          setting: 'URO_STALL_THRESHOLD_MS',
        });
        return {
          changedFiles: ['partial.js'], lastMessage: 'partial work', timedOut: true,
          timeoutMs: 25, exitCode: -1,
          timeoutReason: {
            kind: 'deadline', gapMs: 25,
            lastEvent: { stage: 'executor', type: 'start', attempt: opts.attempt },
            setting: 'URO_STALL_THRESHOLD_MS',
          },
        };
      },
      runGate: async () => { throw new Error('timed-out executor must not run the gate'); },
      runReview: async () => { throw new Error('timed-out executor must not verify'); },
    },
  });

  assert.equal(facts.outcome, 'timed-out');
  const diff = readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8');
  assert.match(diff, /partial[.]js/);
  for (const artifact of HARNESS_ARTIFACTS) {
    assert.doesNotMatch(diff, new RegExp(artifact.replace('.', '[.]')));
  }
  const committed = await spawnCapture('git', [
    '-C', facts.dir, 'show', '--pretty=', '--name-only', 'HEAD',
  ]);
  assert.equal(committed.code, 0, committed.stderr);
  assert.match(committed.stdout, /partial[.]js/);
  assert.doesNotMatch(committed.stdout, /events[.]jsonl/);
  assert.equal(facts.timeoutEvents[0].gapMs, 25);
  assert.equal(facts.timeoutEvents[0].lastEvent.type, 'start');
  assert.equal(facts.timeoutEvents[0].setting, 'URO_STALL_THRESHOLD_MS');
  rmSync(scr, { recursive: true, force: true });
});

test('a failed partial-work commit is non-fatal and cannot suppress the timeout outcome', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'Keep timeout outcome when preservation fails.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'partial-commit-fails', reporter: () => {},
    adapters: {
      runExecutor: async (opts) => {
        writeFileSync(join(opts.cwd, 'partial.js'), 'export const incomplete = true;\n');
        const refDirectory = join(opts.cwd, '.git', 'refs', 'heads', 'uro');
        mkdirSync(refDirectory, { recursive: true });
        writeFileSync(join(refDirectory, 'partial-commit-fails.lock'),
          'force the commit ref update to fail\n');
        await opts.beforeKill({ kind: 'liveness', timeoutMs: 50, gapMs: 50,
          setting: 'URO_STALL_THRESHOLD_MS' });
        return { changedFiles: ['partial.js'], lastMessage: 'partial work', timedOut: true,
          timeoutMs: 25, exitCode: -1,
          timeoutReason: {
            kind: 'liveness', timeoutMs: 50, gapMs: 50,
            setting: 'URO_STALL_THRESHOLD_MS',
          } };
      },
      runGate: async () => { throw new Error('timed-out executor must not run the gate'); },
      runReview: async () => { throw new Error('timed-out executor must not verify'); },
    },
  });

  assert.equal(facts.outcome, 'timed-out');
  assert.equal(facts.timeoutEvents[0].timeoutMs, 50,
    'the silence threshold is the recorded limit');
  assert.equal(facts.timeoutEvents[0].gapMs, 50);
  assert.equal(facts.timeoutEvents[0].setting, 'URO_STALL_THRESHOLD_MS');
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /partial[.]js/,
    'positive control: staging and diff production succeeded before git commit failed');
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out reviewer cannot produce a successful outcome', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'Implement the requested timeout behavior.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'verifier-timeout',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runReview: async () => ({ launchFailed: false, timedOut: true,
        timeoutReason: { timeoutMs: 40 } }),
    },
  });
  assert.equal(facts.outcome, 'timed-out');
  assert.equal(facts.debate.stopReason, 'review-timed-out');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.deepEqual(facts.timeoutEvents, [
    { stage: 'verifier', pass: 'review', iteration: 1, timeoutMs: 40 },
  ]);
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out gate command is distinguishable in run facts and the report', async () => {
  const scr = scratch();
  let verifierCalls = 0;
  const facts = await run({
    task: 'Implement the requested timeout behavior.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'gate-timeout',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: false, results: [{
        bin: 'node', args: ['--test'], code: -1, timedOut: true, timeoutMs: 60,
        outputTail: '[stdout]\npartial test output\n[stderr]\n',
      }] }),
      runReview: async () => { verifierCalls++; return { launchFailed: false, timedOut: false }; },
    },
  });
  assert.equal(facts.outcome, 'timed-out');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.equal(verifierCalls, 0);
  assert.deepEqual(facts.timeoutEvents, [{
    stage: 'gate', iteration: 1, attempt: 1, timeoutMs: 60,
    bin: 'node', args: ['--test'],
  }]);
  const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
  assert.match(report, /Stage timeouts/);
  assert.match(report, /60 ms/);
  rmSync(scr, { recursive: true, force: true });
});

test('diffText throws when git fails (non-git dir)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'nogit-'));
  await assert.rejects(() => diffText(d), /git (add|diff) failed/);
});

function writeHarnessArtifact(directory, artifact, content) {
  if (artifact.endsWith('/')) {
    const artifactDirectory = join(directory, artifact);
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(join(artifactDirectory, 'REVIEW.md'), content);
    return;
  }
  writeFileSync(join(directory, artifact), content);
}

test('diffText unstages every pre-staged harness artifact and retains real changes', async () => {
  const d = makeTarget();
  await spawnCapture('git', ['-C', d, 'init', '-b', 'main']);
  await spawnCapture('git', ['-C', d, 'add', '-A']);
  await spawnCapture('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-m', 'baseline']);
  writeFileSync(join(d, 'feature.js'), 'export const enabled = true;\n');
  for (const artifact of HARNESS_ARTIFACTS) {
    writeHarnessArtifact(d, artifact, `harness-only ${artifact}\n`);
  }
  const staged = await spawnCapture('git', ['-C', d, 'add', '-A']);
  assert.equal(staged.code, 0, staged.stderr);
  const stagedNames = await spawnCapture('git', ['-C', d, 'diff', '--cached', '--name-only']);
  const stagedPaths = stagedNames.stdout.split(/\r?\n/);
  assert.ok(HARNESS_ARTIFACTS.every((artifact) => artifact.endsWith('/')
    ? stagedPaths.some((path) => path.startsWith(artifact))
    : stagedPaths.includes(artifact)),
    'positive control: every harness artifact must be staged before diffText runs');

  const diff = await diffText(d);
  assert.match(diff, /feature[.]js/);
  for (const artifact of HARNESS_ARTIFACTS) {
    assert.doesNotMatch(diff, new RegExp(artifact.replace('.', '[.]')));
  }
  rmSync(d, { recursive: true, force: true });
});

test('diffText succeeds when gitignore lists every harness artifact', async () => {
  const d = makeTarget();
  await spawnCapture('git', ['-C', d, 'init', '-b', 'main']);
  writeFileSync(join(d, '.gitignore'), `${HARNESS_ARTIFACTS.join('\n')}\n`);
  await spawnCapture('git', ['-C', d, 'add', '-A']);
  await spawnCapture('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-m', 'baseline']);
  writeFileSync(join(d, 'feature.js'), 'export const ignoredArtifactsStayIgnored = true;\n');
  for (const artifact of HARNESS_ARTIFACTS) {
    writeHarnessArtifact(d, artifact, `ignored harness-only ${artifact}\n`);
  }
  const ignored = await spawnCapture('git', ['-C', d, 'check-ignore', ...HARNESS_ARTIFACTS]);
  assert.equal(ignored.code, 0, ignored.stderr);
  assert.deepEqual(ignored.stdout.trim().split(/\r?\n/).sort(), [...HARNESS_ARTIFACTS].sort(),
    'positive control: git must ignore every harness artifact');

  const diff = await diffText(d);
  assert.match(diff, /feature[.]js/);
  assert.match(diff, /ignoredArtifactsStayIgnored/);
  for (const artifact of HARNESS_ARTIFACTS) {
    assert.doesNotMatch(diff, new RegExp(artifact.replace('.', '[.]')));
  }
  rmSync(d, { recursive: true, force: true });
});

// mergeVerifierVerdicts and reviewOutcomeFor died with the verdict passes:
// there is one review report now, and seat availability is measured by launch,
// timeout, and report presence — covered by the reviewer-failure tests above.
const blockingReview = (id = 'F1') => `
## ${id}
Severity: blocking
Category: correctness
Description: ${id} demonstrates a reproducible defect.
Test: __uro_review/tests/test_${id.toLowerCase()}.py
`;

const suggestionReview = (id = 'F1') => `
## ${id}
Severity: suggestion
Category: maintainability
Description: ${id} would make the implementation easier to maintain.
`;

function reviewerForRounds(reports, calls = null) {
  let round = 0;
  return async (opts) => {
    calls?.push(opts);
    const report = reports[round++] ?? null;
    mkdirSync(join(opts.cwd, '__uro_review'), { recursive: true });
    writeFileSync(join(opts.cwd, '__uro_review', 'REVIEW.md'),
      report === null ? 'Reviewed. No findings this round.\n' : report);
    return { launchFailed: false, timedOut: false };
  };
}

test('debate regression control converges after one clean review round', async () => {
  const scr = scratch();
  const events = [];
  try {
    let executorCalls = 0;
    let gateCalls = 0;
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-clean',
      reporter: (event) => events.push(event),
      adapters: {
        runExecutor: async (opts) => { executorCalls++; return writingExecutor(opts); },
        runGate: async () => { gateCalls++; return { passed: true, results: [] }; },
        runReview: reviewerForRounds([null]),
      },
    });

    assert.equal(facts.outcome, 'review-ready');
    assert.equal(executorCalls, 1);
    assert.equal(gateCalls, 1);
    assert.equal(facts.debate.roundsRun, 1);
    assert.deepEqual(facts.debate.findingsPerRound, [[]]);
    assert.equal(facts.debate.stopReason, 'converged');
    assert.equal(facts.debate.pivotCount, 0);
    assert.equal(facts.debate.finalPivotDecision, null);
    assert.equal(events.some((event) => event.stage === 'debate' && event.type === 'pivot'), false);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('one blocking finding is fixed by the executor and converges in round two', async () => {
  const scr = scratch();
  try {
    let executorCalls = 0;
    let gateCalls = 0;
    const plans = [];
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-fixed',
      adapters: {
        runExecutor: async (opts) => {
          executorCalls++;
          plans.push(opts.plan);
          return writingExecutor(opts);
        },
        runGate: async () => { gateCalls++; return { passed: true, results: [] }; },
        runReview: reviewerForRounds([blockingReview(), null]),
      },
    });

    assert.equal(facts.outcome, 'review-ready');
    assert.equal(executorCalls, 2);
    assert.equal(gateCalls, 2);
    assert.equal(facts.debate.roundsRun, 2);
    assert.deepEqual(facts.debate.findingsPerRound, [['F1'], []]);
    assert.deepEqual(facts.debate.resolvedFindingIds, ['F1']);
    assert.match(plans[1], /# Fix Plan/);
    assert.match(plans[1], /F1 \(blocking\)/);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('a finding persistent across three rounds detects circling and retries an amended plan', async () => {
  const scr = scratch();
  const events = [];
  const plans = [];
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-circling', debateRounds: 4,
      reporter: (event) => events.push(event),
      adapters: {
        runExecutor: async (opts) => {
          plans.push(opts.plan);
          return writingExecutor(opts);
        },
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([
          blockingReview(), blockingReview(), blockingReview(), null,
        ]),
      },
    });

    assert.equal(facts.debate.roundsRun, 4);
    assert.equal(facts.debate.circlingDetected, true);
    assert.equal(facts.debate.pivotCount, 1);
    assert.equal(facts.debate.finalPivotDecision, 'amend');
    assert.equal(facts.debate.stopReason, 'converged');
    assert.equal(facts.outcome, 'review-ready');
    assert.ok(events.some((event) => event.stage === 'debate' && event.type === 'circling'));
    assert.ok(events.some((event) => event.stage === 'debate'
      && event.type === 'pivot' && event.decision === 'amend'));
    assert.equal(plans.length, 4);
    assert.match(plans[3], /## Pivot amendment/);
    assert.match(plans[3], /The prior fix approach is circling/);
    assert.match(plans[3], /Recurring blockers: F1/);
    assert.match(plans[3], /Round 3: F1/);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('circling on the final round suppresses an amend that cannot run', async () => {
  const scr = scratch();
  const events = [];
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-final-amend', debateRounds: 3,
      reporter: (event) => events.push(event),
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([blockingReview(), blockingReview(), blockingReview()]),
      },
    });

    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 3);
    assert.equal(facts.debate.circlingDetected, true);
    assert.equal(facts.debate.stopReason, 'rounds-exhausted');
    assert.equal(facts.debate.finalPivotDecision, null);
    assert.equal(facts.debate.pivotCount, 0);
    assert.ok(events.some((event) => event.stage === 'debate' && event.type === 'circling'));
    assert.equal(events.some((event) => event.stage === 'debate' && event.type === 'pivot'), false);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('the fresh pivot still acts when circling is detected on the final round', async () => {
  const scr = scratch();
  const events = [];
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-final-fresh', debateRounds: 3,
      reporter: (event) => events.push(event),
      adapters: {
        ...freshPlanningAdapters,
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([
          blockingReview(), blockingReview(), blockingReview(), blockingReview(),
        ]),
        shouldPivot: (pivotCount) => pivotCount === 0 ? PIVOT_FRESH : PIVOT_CONCLUDE,
      },
    });

    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 4);
    assert.equal(facts.debate.stopReason, 'pivot');
    assert.equal(facts.debate.finalPivotDecision, 'conclude');
    assert.equal(facts.debate.pivotCount, 2);
    assert.deepEqual(facts.debate.ledger.rounds.map((round) => round.findingIds), [
      ['F1'], ['F1'], ['F1'], ['F1'],
    ]);
    assert.equal(facts.debate.pivotHistory[0].decision, PIVOT_FRESH);
    assert.equal(facts.debate.pivotHistory[0].selectedCandidateId, 'candidate-1');
    assert.ok(events.some((event) => event.stage === 'debate'
      && event.type === 'pivot' && event.decision === 'fresh'));
    assert.ok(events.some((event) => event.stage === 'pivot'
      && event.type === 'selected' && event.candidateId === 'candidate-1'));
    assert.notEqual(exitCodeFor(facts.outcome), 0);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('a fresh pivot replans and continued circling concludes with the complete ledger', async () => {
  const scr = scratch();
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-fresh',
      adapters: {
        ...freshPlanningAdapters,
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([
          blockingReview(), blockingReview(), blockingReview(), blockingReview(),
          blockingReview(),
        ]),
      },
    });

    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 5);
    assert.equal(facts.debate.pivotCount, 3);
    assert.equal(facts.debate.finalPivotDecision, 'conclude');
    assert.equal(facts.debate.stopReason, 'pivot');
    assert.deepEqual(facts.debate.pivotHistory.map((pivot) => pivot.decision), [
      'amend', 'fresh', 'conclude',
    ]);
    assert.equal(facts.debate.pivotHistory[1].selectedCandidateId, 'candidate-1');
    assert.deepEqual(facts.debate.ledger.allFindingIds, ['F1']);
    assert.deepEqual(facts.debate.ledger.recurredFindingIds, ['F1']);
    assert.equal(facts.debate.ledger.rounds.length, 5);
    assert.notEqual(exitCodeFor(facts.outcome), 0);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('the conclude pivot stops without reporting success', async () => {
  const scr = scratch();
  const events = [];
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-conclude', debateRounds: 3,
      reporter: (event) => events.push(event),
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([blockingReview(), blockingReview(), blockingReview()]),
        shouldPivot: () => PIVOT_CONCLUDE,
      },
    });

    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 3);
    assert.equal(facts.debate.stopReason, 'pivot');
    assert.equal(facts.debate.finalPivotDecision, 'conclude');
    assert.equal(facts.debate.pivotCount, 1);
    assert.ok(events.some((event) => event.stage === 'debate'
      && event.type === 'pivot' && event.decision === 'conclude'));
    assert.notEqual(exitCodeFor(facts.outcome), 0);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('URO_DEBATE_ROUNDS exhaustion stops honestly with unresolved findings', async () => {
  const scr = scratch();
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-exhausted',
      env: { URO_DEBATE_ROUNDS: '1' },
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([blockingReview()]),
      },
    });

    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 1);
    assert.equal(facts.debate.stopReason, 'rounds-exhausted');
    const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
    assert.match(report, /Debate rounds:\*\* 1/);
    assert.match(report, /Debate stopped:\*\* rounds-exhausted/);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('a non-zero fix-round exit keeps the debate alive, and the seats decide', async () => {
  // A red fix-round exit is evidence in front of round 2's reviewer; nothing
  // ends the run for it.
  const scr = scratch();
  try {
    let gateCall = 0;
    let verifierCalls = 0;
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-fix-gate-failed',
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ++gateCall === 1
          ? { passed: true, results: [] }
          : { passed: false, results: [{ bin: 'node', args: ['--test'], code: 7,
              outputTail: 'review regression failed' }] },
        runReview: (() => {
          const reviewer = reviewerForRounds([blockingReview(), null]);
          return async (options) => {
            verifierCalls++;
            return reviewer(options);
          };
        })(),
      },
    });

    // The exit-7 command is evidence in front of round 2's seats; they judged
    // it not worth blocking on, so the run converges. Nothing branched on it.
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(verifierCalls, 2,
      'a non-zero fix-round exit must NOT prevent the next review round');
    assert.equal(facts.debate.roundsRun, 2);
    assert.equal(Object.hasOwn(facts, 'gateFailure'), false);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

// The UNVERIFIED round died with the verdict marker: a reviewer that
// cannot produce a report now stops the run as unreviewed, proved above.
test('suggestions alone converge without another executor or gate round', async () => {
  const scr = scratch();
  try {
    let executorCalls = 0;
    let gateCalls = 0;
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-suggestion',
      adapters: {
        runExecutor: async (opts) => { executorCalls++; return writingExecutor(opts); },
        runGate: async () => { gateCalls++; return { passed: true, results: [] }; },
        runReview: reviewerForRounds([suggestionReview()]),
      },
    });

    assert.equal(facts.outcome, 'review-ready');
    assert.equal(executorCalls, 1);
    assert.equal(gateCalls, 1);
    assert.equal(facts.debate.roundsRun, 1);
    assert.deepEqual(facts.debate.roundHistory[0].suggestionFindingIds, ['F1']);
    assert.deepEqual(facts.debate.ledger.rounds[0].findingIds, []);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('debate rounds are unbounded by default and accept any positive operator bound', () => {
  assert.equal(resolveDebateRounds({}), undefined);
  assert.equal(resolveDebateRounds({ URO_DEBATE_ROUNDS: '50' }), 50);
  assert.throws(() => resolveDebateRounds({ URO_DEBATE_ROUNDS: '0' }), /positive integer/);
  assert.throws(() => resolveDebateRounds({ URO_DEBATE_ROUNDS: '2.5' }), /positive integer/);
});

test('circling triggers Claude to read the change itself, and its view reaches everyone', async () => {
  // The owner's rule: once the debate has gone on for some time — the measured
  // circling signal, never a round count — Claude stops refereeing the other
  // seats' claims and reviews the diff first-hand. Its stance and findings are
  // recorded, handed to the pivot judgement, and put in front of Codex.
  const scr = scratch();
  try {
    const arbiterRequests = [];
    const executorPlans = [];
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-independent-review',
      adapters: {
        runExecutor: async (options) => {
          executorPlans.push(options.plan);
          return writingExecutor(options);
        },
        runGate: async () => ({ passed: true, results: [] }),
        runReview: reviewerForRounds([
          blockingReview(), blockingReview(), blockingReview(), null,
        ]),
        runArbiter: async ({ request }) => {
          arbiterRequests.push(request);
          if (request.type === 'finding') return { verdict: 'valid' };
          if (request.type === 'review') {
            return {
              stance: 'mixed',
              findings: [{ id: 'C1', severity: 'P0', text: 'the recurring objection is real at line 4' }],
              reasoning: 'read the diff first-hand',
            };
          }
          if (request.type === 'pivot') return { decision: 'amend', reason: 'the review shows it is fixable' };
          return { verdict: 'valid' };
        },
      },
    });

    assert.equal(facts.outcome, 'review-ready', 'the amended round converges');
    const reviewRequest = arbiterRequests.find((request) => request.type === 'review');
    assert.ok(reviewRequest, 'circling must trigger an independent review before the pivot');
    assert.match(String(reviewRequest.diff), /diff --git/);
    const pivotRequest = arbiterRequests.find((request) => request.type === 'pivot');
    assert.equal(pivotRequest.independentReview.stance, 'mixed',
      'the pivot must be judged WITH the first-hand view in hand');
    assert.equal(facts.debate.independentReviews.length, 1);
    assert.deepEqual(facts.debate.independentReviews[0].findings,
      [{ id: 'C1', severity: 'P0', text: 'the recurring objection is real at line 4' }]);
    const amendedPlan = executorPlans.find((plan) => plan.includes('Claude independent review'));
    assert.ok(amendedPlan, 'the amended fix plan must carry the first-hand findings to Codex');
    assert.match(amendedPlan, /C1 P0: the recurring objection is real at line 4/);
    // Severity travels verbatim; nothing filtered it on the way through.
    assert.equal(facts.debate.independentReviews[0].findings[0].severity, 'P0');
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('every command run in the worktree leaves whole evidence on disk', async () => {
  // "No green, no red" starts here: the harness executes as a stenographer.
  // Full stdout/stderr per command goes to __uro_evidence/ files the seats can
  // read; the facts carry a tail excerpt plus the paths. Nothing may branch on
  // these records — they are transcript, not verdict.
  const scr = scratch();
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'evidence-run',
      adapters: {
        runExecutor: writingExecutor,
        runGate: async ({ onEvidence }) => {
          onEvidence?.({
            bin: 'node', args: ['--test'], code: 0, timedOut: false, attempt: 1,
            stdout: `${'noise line\n'.repeat(200)}tests 823 pass 823 fail 0\n`,
            stderr: '',
          });
          return { passed: true, results: [] };
        },
        runVerifier: async () => ({ verdict: 'NO_BLOCKERS' }),
      },
    });

    assert.equal(facts.evidence.length, 1);
    const record = facts.evidence[0];
    assert.equal(record.code, 0);
    // The excerpt keeps the TAIL — the end of a run is where it says why it
    // stopped — and the full text lives on disk, untruncated.
    assert.match(record.excerpt, /tests 823 pass 823 fail 0/);
    assert.ok(record.excerpt.length <= 500);
    const full = readFileSync(join(facts.dir, record.outFile), 'utf8');
    assert.match(full, /^noise line/, 'the file must hold the WHOLE output, head included');
    assert.equal((full.match(/noise line/g) ?? []).length, 200);
    assert.equal(Object.hasOwn(record, 'passed'), false,
      'an evidence record must never carry a verdict field');
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});
