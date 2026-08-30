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
  run,
  diffText,
  mergeVerifierVerdicts,
  reviewOutcomeFor,
  resolveDebateRounds,
} from '../src/run.js';
import { PIVOT_CONCLUDE, PIVOT_FRESH } from '../src/debate.js';
import { EMPTY_USAGE } from '../src/usage.js';
import {
  DEFAULT_PROMPT,
  DEFAULT_VERIFIER_MODEL,
  INTENT_PROMPT,
  parseVerdictDetail,
} from '../src/verifier.js';
import { spawnCapture } from '../src/spawn.js';
import { exitCodeFor } from '../src/exit.js';

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

test('correctness and intent findings are separately lifted while verdict is merged', async () => {
  const scr = scratch();
  const verifierCalls = [];
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'f1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async (opts) => {
        verifierCalls.push(opts);
        return opts.prompt === INTENT_PROMPT
          ? { verdict: 'ISSUES', launchFailed: false,
              findings: 'The shared-scope requirement was dropped.', verdictSource: 'assistant' }
          : { verdict: 'NO_BLOCKERS', launchFailed: false,
              findings: 'The implementation is internally correct.', verdictSource: 'result' };
      },
    },
  });
  assert.equal(facts.verdict, 'ISSUES');
  assert.equal(facts.correctnessVerdict, 'NO_BLOCKERS');
  assert.equal(facts.correctnessVerdictSource, 'result');
  assert.equal(facts.verifierFindings, 'The implementation is internally correct.');
  assert.equal(facts.verdictSource, 'result');
  assert.equal(facts.verifierPlan, null);
  assert.equal(facts.intentVerifierFindings, 'The shared-scope requirement was dropped.');
  assert.equal(facts.intentVerdict, 'ISSUES');
  assert.equal(facts.intentVerdictSource, 'assistant');
  assert.equal(facts.intentVerifierPlan, null);
  assert.equal(facts.baseRef, 'HEAD');
  assert.match(facts.baseCommit, /^[0-9a-f]{40,64}$/);
  assert.equal(facts.branch, 'uro/f1');
  assert.deepEqual(verifierCalls.map((call) => call.prompt), [DEFAULT_PROMPT, INTENT_PROMPT]);
  rmSync(scr, { recursive: true, force: true });
});

test('executor retries accumulate usage and model overrides reach both agents and run facts', async () => {
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
  const correctnessUsage = { inputTokens: 7, cachedInputTokens: 4, outputTokens: 6,
    reasoningOutputTokens: 0, cacheWriteTokens: 2 };
  const intentUsage = { inputTokens: 11, cachedInputTokens: 5, outputTokens: 8,
    reasoningOutputTokens: 0, cacheWriteTokens: 3 };
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
      runGate: async () => ({ passed: ++gateCall > 1, results: [] }),
      runVerifier: async (opts) => {
        verifierCalls.push(opts);
        return opts.prompt === INTENT_PROMPT
          ? { verdict: 'NO_BLOCKERS', launchFailed: false, findings: 'Intent is covered.',
              verdictSource: 'result', plan: '# Intent review\n\nNO_BLOCKERS', usage: intentUsage }
          : { verdict: 'ISSUES', launchFailed: false, findings: 'Found it.',
              verdictSource: 'plan', plan: '# Review\n\nISSUES', usage: correctnessUsage };
      },
    },
  });
  assert.equal(executorCalls.length, 2, 'initial execution plus one free retry');
  for (const call of executorCalls) {
    assert.equal(call.model, 'executor-override');
    assert.equal(call.effort, 'medium');
  }
  assert.equal(verifierCalls.length, 2);
  for (const call of verifierCalls) assert.equal(call.model, 'verifier-override');
  assert.deepEqual(verifierCalls.map((call) => call.prompt), [DEFAULT_PROMPT, INTENT_PROMPT]);
  assert.deepEqual(facts.model, {
    executor: 'executor-override', executorEffort: 'medium', verifier: 'verifier-override',
  });
  assert.deepEqual(facts.iterations[0].executorUsage, {
    inputTokens: 30, cachedInputTokens: 15, outputTokens: 5,
    reasoningOutputTokens: 3, cacheWriteTokens: 1,
  });
  assert.deepEqual(facts.tokens, {
    executor: { inputTokens: 30, cachedInputTokens: 15, outputTokens: 5,
      reasoningOutputTokens: 3, cacheWriteTokens: 1 },
    verifier: { inputTokens: 18, cachedInputTokens: 9, outputTokens: 14,
      reasoningOutputTokens: 0, cacheWriteTokens: 5 },
    total: { inputTokens: 48, cachedInputTokens: 24, outputTokens: 19,
      reasoningOutputTokens: 3, cacheWriteTokens: 6 },
  });
  assert.equal(facts.verdictSource, 'plan');
  assert.equal(facts.correctnessVerdict, 'ISSUES');
  assert.equal(facts.correctnessVerdictSource, 'plan');
  assert.equal(facts.verifierPlan, '# Review\n\nISSUES');
  assert.equal(facts.intentVerifierFindings, 'Intent is covered.');
  assert.equal(facts.intentVerdict, 'NO_BLOCKERS');
  assert.equal(facts.intentVerdictSource, 'result');
  assert.equal(facts.intentVerifierPlan, '# Intent review\n\nNO_BLOCKERS');
  assert.equal(facts.gateFailure, null);
  rmSync(scr, { recursive: true, force: true });
});

test('a retained-evidence disagreement is reported without failing a completed run', async () => {
  const scr = scratch();
  const target = makeTarget();
  try {
    const contradictory = parseVerdictDetail(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: 'A blocking defect remains.\n\nISSUES',
    }));
    const clean = parseVerdictDetail(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: 'The intent is satisfied.\n\nNO_BLOCKERS',
    }));
    const facts = await run({
      task: 'do the task', target, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'verdict-disagreement',
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async ({ prompt }) => prompt === INTENT_PROMPT
          ? {
              verdict: clean.verdict,
              verdictSource: clean.source,
              verdictEvidence: clean.evidence,
              launchFailed: false,
            }
          : {
              // Simulate a harness bookkeeping defect: the recorded value does
              // not match the exact retained text, but verification completed.
              verdict: 'NO_BLOCKERS',
              verdictSource: contradictory.source,
              verdictEvidence: contradictory.evidence,
              launchFailed: false,
            },
      },
    });

    assert.equal(facts.outcome, 'review-ready', 'bookkeeping must not fail the run');
    assert.equal(facts.verifierConsistency.status, 'disagreement');
    assert.equal(facts.verifierConsistency.recordedVerdict, 'NO_BLOCKERS');
    assert.equal(facts.verifierConsistency.rederivedVerdict, 'ISSUES');
    const persisted = JSON.parse(readFileSync(join(facts.dir, 'uro-runfacts.json'), 'utf8'));
    assert.equal(persisted.verifierConsistency.status, 'disagreement');
    assert.equal(persisted.iterations[0].verifier.verdictConsistency.status, 'disagreement');
    const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
    assert.match(report, /bookkeeping disagreement/i);
    assert.match(report, /recorded NO_BLOCKERS\/result; re-derived ISSUES\/result/i);
  } finally {
    rmSync(scr, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

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
  const superpowersDir = 'C:/plugins/superpowers/6.3.0';
  const facts = await run({
    ...cliOpts, gate: [], scratchRoot: scr, runId: 'default-models',
    superpowersDir,
    adapters: {
      runExecutor: async (opts) => {
        executorCalls.push(opts);
        return writingExecutor(opts);
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async (opts) => {
        verifierCalls.push(opts);
        return { verdict: 'NO_BLOCKERS', launchFailed: false };
      },
    },
  });

  assert.equal(executorCalls[0].model, DEFAULT_EXECUTOR_MODEL);
  assert.equal(executorCalls[0].effort, DEFAULT_EXECUTOR_EFFORT);
  assert.equal(executorCalls[0].superpowersDir, superpowersDir);
  assert.deepEqual(verifierCalls.map((call) => call.model),
    [DEFAULT_VERIFIER_MODEL, DEFAULT_VERIFIER_MODEL]);
  assert.deepEqual(verifierCalls.map((call) => call.superpowersDir),
    [superpowersDir, superpowersDir]);
  assert.deepEqual(facts.model, {
    executor: DEFAULT_EXECUTOR_MODEL,
    executorEffort: DEFAULT_EXECUTOR_EFFORT,
    verifier: DEFAULT_VERIFIER_MODEL,
  });
  assert.equal(facts.skills, superpowersDir);
  rmSync(scr, { recursive: true, force: true });
});

test('TASK.md is written before execution, excluded from the diff, and both verifiers launch', async () => {
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
      runVerifier: async () => { launches++; return { verdict: 'NO_BLOCKERS', launchFailed: false }; },
    },
  });
  assert.equal(facts.outcome, 'review-ready');
  assert.equal(launches, 2);
  assert.ok(existsSync(join(facts.dir, 'CHANGES.diff')), 'CHANGES.diff handed to verifier');
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
      runVerifier: async () => { throw new Error('no-op must not launch a verifier'); },
    },
  });
  assert.equal(facts.outcome, 'no-op');
  rmSync(taskDir, { recursive: true, force: true });
  rmSync(scr, { recursive: true, force: true });
});

test('first executor call gets the verbatim plan and a retry gets the preceding gate failure', async () => {
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
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.gateStatus, 'passed');
  assert.equal(executorPlans.length, 2);
  assert.equal(executorPlans[0], composedPlan,
    'the initial executor prompt must frame the verbatim plan');
  assert.ok(executorPlans[1].startsWith(composedPlan),
    'retry context must be appended to the same framed plan');
  assert.match(executorPlans[1], /Previous gate attempt failed/);
  assert.match(executorPlans[1], /"bin":"node"/);
  assert.match(executorPlans[1], /"--test","test\/repair[.]test[.]js"/);
  assert.match(executorPlans[1], /Exit code: 7/);
  assert.ok(executorPlans[1].includes(failure.outputTail));
  assert.equal(readFileSync(join(facts.dir, 'TASK.md'), 'utf8'), executorPlans[1],
    'TASK.md must match the final retry text the executor received');
  rmSync(scr, { recursive: true, force: true });
});

test('each retry receives only the immediately preceding distinguishable gate failure', async () => {
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
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.gateStatus, 'passed');
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

  assert.equal(facts.gateStatus, 'passed');
  assert.deepEqual(executorPlans, [composedPlan]);
  assert.doesNotMatch(executorPlans[0], /Previous gate attempt failed/);
  rmSync(scr, { recursive: true, force: true });
});

test('correctness-pass launch failure yields verifier-failed and intent still runs', async () => {
  const scr = scratch();
  const verifier = { verdict: 'ISSUES', exitCode: 1, launchFailed: true, stderr: 'launch failed' };
  const intentVerifier = { verdict: 'NO_BLOCKERS', exitCode: 0, launchFailed: false };
  let calls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'vf1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => calls++ === 0 ? verifier : intentVerifier,
    },
  });
  assert.equal(facts.outcome, 'verifier-failed');
  assert.deepEqual(facts.iterations[0].verifier, verifier);
  assert.deepEqual(facts.iterations[0].intentVerifier, intentVerifier);
  assert.equal(calls, 2, 'intent audit must still run after a correctness launch failure');
  rmSync(scr, { recursive: true, force: true });
});

test('intent-pass launch failure yields verifier-failed', async () => {
  const scr = scratch();
  const verifier = { verdict: 'NO_BLOCKERS', exitCode: 0, launchFailed: false };
  const intentVerifier = { verdict: 'ISSUES', exitCode: 1, launchFailed: true,
    stderr: 'intent launch failed' };
  let calls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'vf2',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => calls++ === 0 ? verifier : intentVerifier,
    },
  });
  assert.equal(facts.outcome, 'verifier-failed');
  assert.deepEqual(facts.iterations[0].verifier, verifier);
  assert.deepEqual(facts.iterations[0].intentVerifier, intentVerifier);
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
      runVerifier: async () => { launches++; return { verdict: 'NO_BLOCKERS' }; },
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

test('an UNVERIFIED seat prevents a review-ready outcome', async () => {
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'unverified-verdict',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async ({ prompt }) => prompt === INTENT_PROMPT
        ? { verdict: 'NO_BLOCKERS', launchFailed: false, verdictSource: 'result' }
        : { verdict: 'UNVERIFIED', launchFailed: false, verdictSource: 'none', findings: '' },
    },
  });

  assert.equal(facts.verdict, 'UNVERIFIED');
  assert.equal(facts.correctnessVerdict, 'UNVERIFIED');
  assert.equal(facts.correctnessVerdictSource, 'none');
  assert.equal(facts.outcome, 'verifier-failed');
  assert.notEqual(facts.outcome, 'review-ready');
  rmSync(scr, { recursive: true, force: true });
});

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
      runVerifier: async () => { throw new Error('no-op must not verify'); },
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
      runVerifier: async () => {
        verifierCalls++;
        throw new Error('verifier must not launch for a challenge');
      },
    },
  });

  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(facts.gateStatus, 'not-run');
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
        runVerifier: async () => { throw new Error('verifier must not launch for no-op'); },
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
      runVerifier: async () => {
        verifierCalls++;
        return { verdict: 'NO_BLOCKERS', launchFailed: false };
      },
    },
  });

  assert.equal(facts.outcome, 'review-ready');
  assert.equal(gateCalls, 1);
  assert.equal(verifierCalls, 2);
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
      runVerifier: async () => { throw new Error('verifier must not run'); },
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
      runVerifier: async () => { throw new Error('verifier must not run'); },
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
      runVerifier: async () => { throw new Error('verifier must not run'); },
    },
  });

  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(executorCalls, 1);
  assert.equal(existsSync(join(facts.dir, 'DECISION.md')), true);
  rmSync(scr, { recursive: true, force: true });
});

test('a sentinel challenge from a gate-retry executor stops before another gate', async () => {
  const scr = scratch();
  let executorCalls = 0;
  let gateCalls = 0;
  let verifierCalls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 1,
    scratchRoot: scr, runId: 'gate-retry-decision', mode: 'manual',
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCalls++;
        if (executorCalls === 2) writeFileSync(join(cwd, 'DECISION.md'), DECISION_CONTENT);
        return {
          changedFiles: executorCalls === 2 ? ['DECISION.md'] : [],
          lastMessage: executorCalls === 2 ? 'need a decision' : 'initial attempt',
          exitCode: 0,
        };
      },
      runGate: async () => {
        gateCalls++;
        return gateCalls === 1
          ? {
              passed: false,
              results: [{ bin: 'node', args: ['--test'], code: 1, outputTail: 'failed' }],
            }
          : { passed: true, results: [] };
      },
      runVerifier: async () => {
        verifierCalls++;
        throw new Error('verifier must not launch for a challenge');
      },
    },
  });

  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(facts.gateStatus, 'not-run');
  assert.equal(executorCalls, 2);
  assert.equal(gateCalls, 1);
  assert.equal(verifierCalls, 0);
  assert.equal(facts.decision.challengeRound, 1);
  rmSync(scr, { recursive: true, force: true });
});

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
      runVerifier: async () => {
        verifierCalls++;
        throw new Error('an empty diff must not launch a verifier');
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
      runVerifier: async () => { throw new Error('a no-op must not launch a verifier'); },
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
      runVerifier: async () => { throw new Error('a no-op must not launch a verifier'); },
    },
  });

  assert.equal(facts.noOpReason, 'approval-requested');
  assert.equal(facts.outcome, 'no-op');
  assert.equal(facts.gateStatus, 'passed');
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
        runVerifier: async () => { throw new Error('a no-op must not launch a verifier'); },
      },
    });

    assert.equal(facts.outcome, 'no-op');
    assert.equal(facts.gateStatus, 'passed');
    assert.equal(exitCodeFor(facts.outcome), 0);
    assert.equal(Object.hasOwn(facts, 'noOpReason'), false);
    assert.doesNotMatch(readFileSync(join(facts.dir, 'uro-report.md'), 'utf8'),
      /approval-requested/);
    rmSync(scr, { recursive: true, force: true });
  });

test('red gate exhausts retries → gate-failed, verifier never launched', async () => {
  let gateCalls = 0, launches = 0;
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'r1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => { gateCalls++; return { passed: false, results: [{
        bin: 'node', args: ['--test'], code: 1,
        outputTail: '[stdout]\nfailed assertion\n[stderr]\nstack trace',
      }] }; },
      runVerifier: async () => { launches++; return { verdict: 'NO_BLOCKERS' }; },
    },
  });
  assert.equal(facts.gateStatus, 'failed');
  assert.equal(facts.outcome, 'gate-failed');
  assert.equal(launches, 0);
  assert.equal(gateCalls, 3, '1 initial + 2 free retries');
  assert.deepEqual(facts.gateFailure, {
    bin: 'node', args: ['--test'], code: 1,
    outputTail: '[stdout]\nfailed assertion\n[stderr]\nstack trace',
  });
  assert.deepEqual(facts.tokens.executor, EMPTY_USAGE);
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
      runVerifier: async () => { verifierCalls++; return { verdict: 'NO_BLOCKERS' }; },
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
      runVerifier: async () => { throw new Error('timed-out executor must not verify'); },
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
        await opts.beforeKill({ kind: 'hard-ceiling', timeoutMs: 50,
          setting: 'URO_EXECUTOR_MAX_MS' });
        return { changedFiles: ['partial.js'], lastMessage: 'partial work', timedOut: true,
          timeoutMs: 25, exitCode: -1,
          timeoutReason: {
            kind: 'hard-ceiling', timeoutMs: 50, setting: 'URO_EXECUTOR_MAX_MS',
          } };
      },
      runGate: async () => { throw new Error('timed-out executor must not run the gate'); },
      runVerifier: async () => { throw new Error('timed-out executor must not verify'); },
    },
  });

  assert.equal(facts.outcome, 'timed-out');
  assert.equal(facts.timeoutEvents[0].timeoutMs, 50,
    'the hard ceiling, not the ordinary interval, is the recorded elapsed limit');
  assert.equal(facts.timeoutEvents[0].setting, 'URO_EXECUTOR_MAX_MS');
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /partial[.]js/,
    'positive control: staging and diff production succeeded before git commit failed');
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out verifier cannot produce a successful outcome', async () => {
  const scr = scratch();
  let calls = 0;
  const facts = await run({
    task: 'Implement the requested timeout behavior.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'verifier-timeout',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => ++calls === 1
        ? { verdict: 'NO_BLOCKERS', launchFailed: false, timedOut: true, timeoutMs: 40 }
        : { verdict: 'NO_BLOCKERS', launchFailed: false, timedOut: false },
    },
  });
  assert.equal(facts.outcome, 'timed-out');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.deepEqual(facts.timeoutEvents, [
    { stage: 'verifier', pass: 'correctness', iteration: 1, timeoutMs: 40 },
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
      runVerifier: async () => { verifierCalls++; return { verdict: 'NO_BLOCKERS' }; },
    },
  });
  assert.equal(facts.outcome, 'timed-out');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.equal(verifierCalls, 0);
  assert.deepEqual(facts.timeoutEvents, [{
    stage: 'gate', iteration: 1, attempt: 1, timeoutMs: 60,
    bin: 'node', args: ['--test'],
  }]);
  assert.equal(facts.gateFailure.timedOut, true);
  const report = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
  assert.match(report, /Gate failure/);
  assert.match(report, /Timed out.*60 ms/i);
  rmSync(scr, { recursive: true, force: true });
});

test('diffText throws when git fails (non-git dir)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'nogit-'));
  await assert.rejects(() => diffText(d), /git (add|diff) failed/);
});

test('diffText unstages every pre-staged harness artifact and retains real changes', async () => {
  const d = makeTarget();
  await spawnCapture('git', ['-C', d, 'init', '-b', 'main']);
  await spawnCapture('git', ['-C', d, 'add', '-A']);
  await spawnCapture('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-m', 'baseline']);
  writeFileSync(join(d, 'feature.js'), 'export const enabled = true;\n');
  for (const artifact of HARNESS_ARTIFACTS) {
    writeFileSync(join(d, artifact), `harness-only ${artifact}\n`);
  }
  const staged = await spawnCapture('git', ['-C', d, 'add', '-A']);
  assert.equal(staged.code, 0, staged.stderr);
  const stagedNames = await spawnCapture('git', ['-C', d, 'diff', '--cached', '--name-only']);
  assert.ok(HARNESS_ARTIFACTS.every((artifact) => stagedNames.stdout.split(/\r?\n/).includes(artifact)),
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
    writeFileSync(join(d, artifact), `ignored harness-only ${artifact}\n`);
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

test('mergeVerifierVerdicts is fail-safe across both passes', () => {
  assert.equal(mergeVerifierVerdicts('NO_BLOCKERS', 'NO_BLOCKERS'), 'NO_BLOCKERS');
  assert.equal(mergeVerifierVerdicts('NO_BLOCKERS', 'ISSUES'), 'ISSUES');
  assert.equal(mergeVerifierVerdicts('ISSUES', 'NO_BLOCKERS'), 'ISSUES');
  assert.equal(mergeVerifierVerdicts('NO_BLOCKERS', 'UNVERIFIED'), 'UNVERIFIED');
  assert.equal(mergeVerifierVerdicts('UNVERIFIED', 'NO_BLOCKERS'), 'UNVERIFIED');
  assert.equal(mergeVerifierVerdicts('ISSUES', 'UNVERIFIED'), 'ISSUES');
});

test('review outcome rejects UNVERIFIED seats as verifier failures', () => {
  const clean = { verdict: 'NO_BLOCKERS', launchFailed: false, timedOut: false };
  const issues = { verdict: 'ISSUES', launchFailed: false, timedOut: false };
  const unverified = { verdict: 'UNVERIFIED', launchFailed: false, timedOut: false };

  assert.equal(reviewOutcomeFor(clean, clean), 'review-ready');
  assert.equal(reviewOutcomeFor(issues, clean), 'review-ready',
    'a parsed ISSUES verdict remains a completed review');
  assert.equal(reviewOutcomeFor(unverified, clean), 'verifier-failed');
  assert.equal(reviewOutcomeFor(clean, unverified), 'verifier-failed');
});

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

function verifierForRounds(correctnessFindings) {
  let correctnessRound = 0;
  return async ({ prompt }) => {
    if (prompt === INTENT_PROMPT) {
      return { verdict: 'NO_BLOCKERS', launchFailed: false, findings: 'Intent is covered.' };
    }
    const findings = correctnessFindings[correctnessRound++] ?? null;
    return findings === null
      ? { verdict: 'NO_BLOCKERS', launchFailed: false, findings: 'No blockers.' }
      : { verdict: 'ISSUES', launchFailed: false, findings };
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
        runVerifier: verifierForRounds([null]),
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
        runVerifier: verifierForRounds([blockingReview(), null]),
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
        runVerifier: verifierForRounds([
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
        runVerifier: verifierForRounds([blockingReview(), blockingReview(), blockingReview()]),
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
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: verifierForRounds([blockingReview(), blockingReview(), blockingReview()]),
        shouldPivot: () => PIVOT_FRESH,
      },
    });

    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 3);
    assert.equal(facts.debate.stopReason, 'pivot');
    assert.equal(facts.debate.finalPivotDecision, 'fresh');
    assert.equal(facts.debate.pivotCount, 1);
    assert.deepEqual(facts.debate.ledger.rounds.map((round) => round.findingIds), [
      ['F1'], ['F1'], ['F1'],
    ]);
    assert.ok(events.some((event) => event.stage === 'debate'
      && event.type === 'pivot' && event.decision === 'fresh'));
    assert.notEqual(exitCodeFor(facts.outcome), 0);
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('the fresh pivot stops with needs-pivot and carries the complete ledger', async () => {
  const scr = scratch();
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-fresh', debateRounds: 4,
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: verifierForRounds([
          blockingReview(), blockingReview(), blockingReview(), blockingReview(),
        ]),
      },
    });

    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 4);
    assert.equal(facts.debate.pivotCount, 2);
    assert.equal(facts.debate.finalPivotDecision, 'fresh');
    assert.equal(facts.debate.stopReason, 'pivot');
    assert.deepEqual(facts.debate.ledger.allFindingIds, ['F1']);
    assert.deepEqual(facts.debate.ledger.recurredFindingIds, ['F1']);
    assert.equal(facts.debate.ledger.rounds.length, 4);
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
        runVerifier: verifierForRounds([blockingReview(), blockingReview(), blockingReview()]),
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
        runVerifier: verifierForRounds([blockingReview()]),
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

test('a fix round that breaks the gate fails like an initial gate failure', async () => {
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
        runVerifier: async (options) => {
          verifierCalls++;
          return verifierForRounds([blockingReview()])(options);
        },
      },
    });

    assert.equal(facts.outcome, 'gate-failed');
    assert.equal(facts.gateStatus, 'failed');
    assert.equal(facts.gateFailure.code, 7);
    assert.equal(verifierCalls, 2, 'the failed fix gate must prevent another review');
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

test('UNVERIFIED is recorded as a round but never converges the debate', async () => {
  const scr = scratch();
  try {
    const facts = await run({
      task: 'do the task', target: makeTarget(), gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'debate-unverified',
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async ({ prompt }) => prompt === INTENT_PROMPT
          ? { verdict: 'NO_BLOCKERS', launchFailed: false }
          : { verdict: 'UNVERIFIED', launchFailed: false },
      },
    });

    assert.equal(facts.outcome, 'verifier-failed');
    assert.equal(facts.debate.roundsRun, 1);
    assert.equal(facts.debate.stopReason, 'unverified');
  } finally {
    rmSync(scr, { recursive: true, force: true });
  }
});

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
        runVerifier: verifierForRounds([suggestionReview()]),
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

test('debate round setting defaults to two and rejects values outside one through five', () => {
  assert.equal(resolveDebateRounds({}), 2);
  assert.equal(resolveDebateRounds({ URO_DEBATE_ROUNDS: '5' }), 5);
  assert.throws(() => resolveDebateRounds({ URO_DEBATE_ROUNDS: '0' }), /between 1 and 5/);
  assert.throws(() => resolveDebateRounds({ URO_DEBATE_ROUNDS: '6' }), /between 1 and 5/);
  assert.throws(() => resolveDebateRounds({ URO_DEBATE_ROUNDS: '2.5' }), /integer between 1 and 5/);
});
