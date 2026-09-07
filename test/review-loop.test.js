import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { run as executeRun } from '../src/run.js';
import * as execution from '../src/run.js';
import { runQueue } from '../src/queue.js';
import { planningArtifactDigest } from '../src/conversation.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { materializeReviewBundle, reviewDigest } from '../src/review.js';

function filesIn(root) {
  const files = new Map();
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        files.set(relative(root, path).split(sep).join('/'), readFileSync(path));
      }
    }
  };
  visit(root);
  return files;
}

async function captureWorktreeSnapshot({ cwd }) {
  return { cwd, files: filesIn(cwd) };
}

async function restoreWorktreeSnapshot({ snapshot, scope, prefix }) {
  const current = filesIn(snapshot.cwd);
  const changed = [...new Set([...snapshot.files.keys(), ...current.keys()])]
    .filter((path) => {
      const inside = path === prefix || path.startsWith(`${prefix}/`);
      return scope === 'inside' ? inside : !inside;
    })
    .filter((path) => {
      const before = snapshot.files.get(path);
      const after = current.get(path);
      return before === undefined || after === undefined || !before.equals(after);
    })
    .sort();
  for (const path of changed) {
    const target = join(snapshot.cwd, path);
    const before = snapshot.files.get(path);
    if (before === undefined) rmSync(target, { recursive: true, force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, before);
    }
  }
  return { restoredPaths: changed };
}

function harness(runId, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), `uro-${runId}-`));
  const target = join(root, 'target');
  const scratchRoot = join(root, 'scratch');
  mkdirSync(target, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });
  writeFileSync(join(target, 'seed.js'), 'export const seed = true;\n');

  const baseAdapters = {
    isolate: async () => ({
      dir: target,
      isRepo: true,
      source: 'repository',
      baseRef: 'HEAD',
      baseCommit: 'a'.repeat(40),
      branch: `uro/${runId}`,
    }),
    diffText: async () => 'diff --git a/seed.js b/seed.js\n',
    captureWorktreeSnapshot,
    restoreWorktreeSnapshot,
    runExecutor: async ({ cwd }) => {
      writeFileSync(join(cwd, 'implementation.js'), 'implemented\n');
      return { changedFiles: ['implementation.js'], lastMessage: 'implemented' };
    },
    runGate: async () => ({ passed: true, results: [] }),
    runReview: async () => ({ launchFailed: false, timedOut: false }),
    runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
  };
  return {
    root,
    target,
    options: withVerifiedSuperpowers({
      task: 'Implement the requested change.',
      target,
      gate: [{ bin: 'node', args: ['--test', 'test/original.test.js'] }],
      gateRetries: 0,
      scratchRoot,
      artifactRoot: join(root, 'artifacts'),
      runId,
      debateRounds: 5,
      adapters: { ...baseAdapters, ...overrides.adapters },
      ...overrides.options,
    }),
  };
}

async function currentReview(options, { findings = '', tests = [], dispositions = [] } = {}) {
  const bundle = { version: 1, report: findings || 'No blocking findings after checking requirements.', tests, dispositions };
  return { provider: 'claude', role: 'execution-reviewer', launchFailed: false, timedOut: false,
    answer: JSON.stringify(bundle), artifact: await materializeReviewBundle({ ...options, bundle }) };
}
const blocker = '## F1\nSeverity: blocking\nDescription: Branch drops valid input.\nTest: __uro_review/tests/f1.test.js\n';
const proof = { path: 'tests/f1.test.js', content: 'throw new Error("branch evidence");\n' };

for (const change of ['correction', 'unrelated', 'diff', 'evidence']) test(`human rulings preserve ${change} work for actual review`, async t => {
  let resumed = false;
  const fixture = harness(`human-${change}`, { options: { debateRounds: 4 }, adapters: {
    runExecutor: async () => ({ exitCode: 0, changedFiles: ['implementation.js'], lastMessage: JSON.stringify({
      findingResponses: [{ id: 'F1', disposition: 'dispute', reason: 'Excluded input.' }] }) }),
    diffText: async () => resumed && change === 'diff' ? 'changed implementation diff' : 'original implementation diff',
    runGate: async () => ({ results: [{ bin: 'node', args: ['test.js'], code: resumed && change === 'evidence' ? 2 : 1,
      outputTail: resumed && change === 'evidence' ? 'New different failure evidence' : 'Original failure evidence' }] }),
    runReview: async options => currentReview(options, { findings: blocker + (resumed && change === 'unrelated'
      ? '\n## F2\nSeverity: blocking\nDescription: Another required branch fails.\nTest: __uro_review/tests/f2.test.js\n' : ''),
      tests: [proof, ...(resumed && change === 'unrelated' ? [{ path: 'tests/f2.test.js', content: 'throw Error("another");' }] : [])],
      dispositions: [{ id: 'F1', status: 'upheld', reason: 'Still supporting original position.' }] }),
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const pending = await executeRun(fixture.options);
  assert.equal(pending.outcome, 'needs-decision');
  resumed = true;
  const done = await execution.continueExecution({ checkpointState: pending.checkpointState,
    humanRuling: { decisionId: 'test-ruling', artifactDigest: 'test-artifact', answers: [{ id: 'F1',
      answer: change === 'correction' ? 'Require a correction' : 'Accept Codex rebuttal' }] }, adapters: fixture.options.adapters });
  assert.notEqual(done.outcome, 'review-ready', change);
  assert.equal(done.approved, false);
  assert.ok(done.debate.openFindings.some(finding => finding.id === (change === 'unrelated' ? 'F2' : 'F1')));
});

test('queue accepts the real execution receipt only while its persisted diff is current and reviewed', async (t) => {
  for (const state of ['reviewed', 'skipped', 'changed']) {
    const fixture = harness(`queue-receipt-${state}`, { adapters: {
      runReview: state === 'skipped' ? null : currentReview,
    } });
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const facts = await executeRun(fixture.options);
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(facts.approved, state !== 'skipped');
    if (state !== 'skipped') assert.equal(facts.approval.artifactDigest,
      reviewDigest(readFileSync(join(facts.dir, 'CHANGES.diff'))));
    if (state === 'changed') writeFileSync(join(facts.dir, 'CHANGES.diff'), 'unreviewed change');
    writeFileSync(join(fixture.root, 'plan.md'), 'Implement requested change');
    writeFileSync(join(fixture.root, 'gate.json'), '[]');
    const file = join(fixture.root, 'queue.json');
    writeFileSync(file, JSON.stringify([{ task: 'plan.md', gate: 'gate.json' }]));
    let judged = 0;
    let landed = 0;
    await runQueue({ file, target: fixture.target, dependencies: {
      assertCleanTarget: async () => {},
      launchRun: async () => ({ runDirectory: facts.dir }),
      readRunFacts: async () => JSON.parse(readFileSync(join(facts.dir, 'uro-runfacts.json'), 'utf8')),
      judgeLanding: async () => { judged++; return { approved: true }; },
      landDiff: async () => { landed++; return { commit: 'fixture' }; },
    } });
    assert.equal(judged, state === 'reviewed' ? 1 : 0, state);
    assert.equal(landed, state === 'reviewed' ? 1 : 0, state);
  }
});

test('a deliberately skipped embedding reviewer is not reported as a Claude invocation', async (t) => {
  const fixture = harness('review-skipped', { adapters: { runReview: null } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = await executeRun(fixture.options);
  assert.equal(Object.hasOwn(result.participation, 'claude'), false);
  assert.equal(result.messages.some((message) => message.speaker === 'claude'), false);
});

test('manual execution dispute reaches human after Codex rebuttal and Claude reply', async (t) => {
  let implementations = 0;
  const requests = [];
  const fixture = harness('manual-debate', { adapters: {
    runExecutor: async () => ({ changedFiles: ['implementation.js'], lastMessage: ++implementations === 1 ? 'Initial implementation.'
      : JSON.stringify({ findingResponses: [{ id: 'F1', disposition: 'dispute', reason: 'The requested input is expressly excluded.' }] }) }),
    runReview: async (options) => {
      requests.push(options.request);
      return currentReview(options, { findings: blocker, tests: [proof],
        dispositions: requests.length === 1 ? [] : [{ id: 'F1', status: 'upheld', reason: 'The original task includes that input.' }] });
    },
    runArbiter: async () => { throw new Error('must not ask Claude for a third vote'); },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(implementations, 2);
  assert.match(JSON.stringify(requests[1].messages), /expressly excluded/);
  assert.equal(facts.checkpointState.stage, 'execution-dispute');
  assert.equal(facts.checkpointState.openFindings[0].id, 'F1');
  assert.equal(facts.checkpointState.workspace.dir, fixture.target);
  assert.equal(facts.checkpointState.interactionMode, 'manual');
  assert.match(JSON.stringify(facts.checkpointState.messages), /original task includes/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(facts.checkpointState)));
});

test('omitting a prior blocker never manufactures closure', async (t) => {
  let reviews = 0;
  const fixture = harness('omitted-finding', { options: { debateRounds: 2 }, adapters: {
    runReview: async (options) => currentReview(options, ++reviews === 1 ? { findings: blocker, tests: [proof] } : {}),
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.notEqual(facts.outcome, 'review-ready');
  assert.deepEqual(facts.debate.resolvedFindingIds, []);
  assert.equal(facts.debate.openFindings[0].id, 'F1');
});

for (const shape of [{}, 'dispute', null]) test(`malformed Codex replies ${JSON.stringify(shape)} preserve the open issue and complete checkpoint`, async t => {
  const raw = JSON.stringify({ findingResponses: shape });
  const requests = [];
  const fixture = harness('malformed-reply', { options: { debateRounds: 3 }, adapters: {
    runExecutor: async () => ({ exitCode: 0, changedFiles: ['implementation.js'], lastMessage: raw }),
    runReview: async options => { requests.push(options.request); return currentReview(options, {
      findings: blocker, tests: [proof], dispositions: [{ id: 'F1', status: 'upheld', reason: 'The test still proves this defect.' }] }); },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = await executeRun(fixture.options);
  assert.notEqual(result.outcome, 'review-ready');
  assert.deepEqual(result.debate.resolvedFindingIds, []);
  assert.equal(result.debate.openFindings[0].id, 'F1');
  assert.ok(result.messages.some(message => message.speaker === 'codex' && message.content === raw));
  assert.ok(requests[1].messages.some(message => message.speaker === 'codex' && message.content === raw));
  assert.equal(result.checkpointState.openFindings[0].id, 'F1');
});

test('new reviewer test output reaches Codex and Claude before closure', async (t) => {
  const executorPrompts = [], reviewRequests = [];
  const fixture = harness('review-evidence-delivery', { adapters: {
    runExecutor: async ({ plan }) => { executorPrompts.push(plan); return { changedFiles: ['implementation.js'], lastMessage: 'Evidence reviewed; failure is a fixture issue.' }; },
    runGate: async ({ commands }) => ({ results: commands.map((command) => ({ ...command,
      code: command.harness ? 1 : 0, outputTail: command.harness ? 'unique independent failure evidence' : '' })) }),
    runReview: async (options) => { reviewRequests.push(options.request); return currentReview(options, { tests: [proof] }); },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.outcome, 'review-ready');
  assert.equal(reviewRequests.length, 2);
  assert.match(executorPrompts[1], /unique independent failure evidence/);
  assert.match(JSON.stringify(reviewRequests[1].evidence), /unique independent failure evidence/);
  assert.match(JSON.stringify(reviewRequests[1].messages), /fixture issue/);
});

test('a stale report or stale artifact cannot approve the current invocation', async (t) => {
  let previous;
  const fixture = harness('stale-review', { adapters: {
    runReview: async (options) => {
      if (!previous) { previous = await currentReview(options, { findings: blocker, tests: [proof] }); return previous; }
      return { ...previous, answer: '{malformed' };
    },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.outcome, 'verifier-failed');
});

test('autonomous Claude withdrawal answers Codex and closes the explicit finding', async (t) => {
  let reviews = 0;
  const fixture = harness('autonomous-disposition', { options: { mode: 'autonomous' }, adapters: {
    runExecutor: async () => ({ changedFiles: ['implementation.js'], lastMessage: 'The contract excludes that case; see original task.' }),
    runReview: async (options) => currentReview(options, ++reviews === 1 ? { findings: blocker, tests: [proof] }
      : { dispositions: [{ id: 'F1', status: 'withdrawn', reason: 'Codex correctly identifies the excluded case in the original task.' }] }),
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.outcome, 'review-ready');
  assert.deepEqual(facts.debate.resolvedFindingIds, ['F1']);
  assert.equal(facts.authority, 'claude');
  assert.deepEqual(facts.debate.openFindings, []);
});

test('fresh execution replans inherit both models and refuse unapproved candidates before resetting the branch', async (t) => {
  let planningRequest, branches = 0, rounds = 0;
  const fixture = harness('fresh-approval', { options: { mode: 'autonomous', arbiterModel: 'claude-selected', executorModel: 'codex-selected', executorEffort: 'high' }, adapters: {
    runReview: async (options) => currentReview(options, { findings: blocker, tests: [proof] }),
    detectCircling: () => ++rounds >= 2,
    runArbiter: async ({ request }) => request.type === 'pivot' ? { decision: 'fresh', reason: 'Current approach cannot satisfy the input contract.' } : { verdict: 'UNVERIFIED' },
    createFreshPivotBranch: async () => { branches++; return { branch: 'fresh' }; },
    runPlanCandidateSet: async (options) => { planningRequest = options; return { approved: false, selected: null,
      selectedCandidateId: 'tempting', candidates: [{ id: 'tempting', plan: 'Unapproved replacement', gate: [] }],
      checkpointState: { phase: 'planning', proposal: { plan: 'Unapproved replacement', gate: [] } } }; },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(branches, 0);
  assert.notEqual(facts.outcome, 'review-ready');
  assert.equal(planningRequest.interactionMode, 'autonomous');
  assert.equal(planningRequest.mode, 'fresh');
  assert.equal(planningRequest.claudeModel, 'claude-selected');
  assert.equal(planningRequest.codexModel, 'codex-selected');
  assert.equal(planningRequest.codexEffort, 'high');
});

test('manual continuation attaches to the saved copied workspace and delivers the human ruling to both agents', async (t) => {
  let isolates = 0, reviews = 0;
  const plans = [], requests = [];
  const fixture = harness('same-workspace', { options: { debateRounds: 9, executorTimeout: 123456 }, adapters: {
    runExecutor: async ({ plan }) => { plans.push(plan); return { exitCode: 0, changedFiles: ['implementation.js'],
      lastMessage: JSON.stringify({ findingResponses: [{ id: 'F1', disposition: 'dispute', reason: 'Input excluded by contract.' }] }) }; },
    runReview: async (options) => {
      requests.push(options.request);
      return currentReview(options, ++reviews < 3 ? { findings: blocker, tests: [proof],
        dispositions: [{ id: 'F1', status: 'upheld', reason: 'Required input remains unsupported.' }] }
        : { tests: [proof], dispositions: [{ id: 'F1', status: 'withdrawn', reason: 'Human confirmed the exclusion, and the implementation meets it.' }] });
    },
  } });
  const isolate = fixture.options.adapters.isolate;
  fixture.options.adapters.isolate = async (...args) => { isolates++; return { ...await isolate(...args), isRepo: false }; };
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const pending = await executeRun(fixture.options);
  assert.equal(pending.outcome, 'needs-decision');
  assert.equal(pending.checkpointState.stageTimeouts.executor, 123456);
  assert.equal(pending.checkpointState.options.debateRounds, 9);
  assert.equal(typeof execution.continueExecution, 'function');
  const done = await execution.continueExecution({ checkpointState: JSON.parse(JSON.stringify(pending.checkpointState)),
    humanRuling: { answers: [{ id: 'F1', answer: 'The input is excluded. Keep the current behavior.' }] }, adapters: fixture.options.adapters });
  assert.equal(done.outcome, 'review-ready');
  assert.equal(done.dir, pending.dir);
  assert.equal(isolates, 1);
  assert.equal(plans.length, 3);
  assert.match(plans[2], /The input is excluded/);
  assert.match(JSON.stringify(requests[2].messages), /The input is excluded/);
  assert.equal(done.debate.roundsRun, 3);
  assert.equal(done.limits.timeoutsMs.executor, 123456);
  assert.equal(done.messages.filter((message) => message.speaker === 'human').length, 1);
});

test('an unavailable autonomous challenge reviewer never changes authority to the human', async (t) => {
  const fixture = harness('autonomous-unavailable', { options: { mode: 'autonomous', challengeRounds: 1 }, adapters: {
    diffText: async () => '',
    runExecutor: async ({ cwd }) => {
      writeFileSync(join(cwd, 'DECISION.md'), '## Q1\nKind: technical\nQuestion: Which behavior?\nOptions: A, B\nRecommendation: A\n');
      return { exitCode: 0, changedFiles: ['DECISION.md'], lastMessage: 'Question needs a reviewer answer.' };
    },
    runArbiter: async () => ({ verdict: 'UNVERIFIED', launchFailed: true, answer: 'quota exhausted' }),
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = await executeRun(fixture.options);
  assert.notEqual(result.outcome, 'needs-decision');
  assert.equal(result.authority, 'claude');
  assert.equal(result.checkpointState, undefined);
  assert.match(result.debate.stopReason, /unavailable|limit/);
});

test('autonomous authority questions use Claude merits without operator-presence evidence', async (t) => {
  let attempts = 0;
  const fixture = harness('autonomous-authority', { options: { mode: 'autonomous' }, adapters: {
    diffText: async () => attempts === 1 ? '' : 'diff --git a/a b/a\n+done\n',
    runExecutor: async ({ cwd }) => {
      if (++attempts === 1) writeFileSync(join(cwd, 'DECISION.md'), '## Q1\nKind: authority\nQuestion: Which allowed approach?\nOptions: A, B\nRecommendation: A\n');
      return { exitCode: 0, changedFiles: ['implementation.js'], lastMessage: 'Executed allowed approach.' };
    },
    runArbiter: async () => ({ answer: 'B', reason: 'B meets the original acceptance requirements.' }),
    runReview: async (options) => currentReview(options),
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = await executeRun(fixture.options);
  assert.equal(result.outcome, 'review-ready');
  assert.equal(result.decision.answeredBy, 'claude');
  assert.equal(result.escalation, undefined);
});

test('fresh planning executes the approved revised proposal, preserving planning usage and the new gate', async (t) => {
  let rounds = 0, reviews = 0;
  const plans = [], gates = [];
  const revised = { plan: 'Approved revised approach uses a bounded parser.', gate: [{ bin: 'node', args: ['approved-gate.js'] }] };
  const requirement = 'Implement the requested change.';
  const digest = planningArtifactDigest(requirement, revised);
  const fixture = harness('approved-revision', { options: { mode: 'autonomous' }, adapters: {
    runExecutor: async ({ plan }) => { plans.push(plan); return { changedFiles: ['implementation.js'], lastMessage: 'Implemented approved approach.' }; },
    runGate: async ({ commands }) => { gates.push(commands); return { results: [] }; },
    runReview: async (options) => currentReview(options, ++reviews <= 2 ? { findings: blocker, tests: [proof] }
      : { tests: [proof], dispositions: [{ id: 'F1', status: 'resolved', reason: 'Revised approach corrects the defect.' }] }),
    detectCircling: () => ++rounds === 2,
    runArbiter: async () => ({ decision: 'fresh', reason: 'A parser revision is required.' }),
    createFreshPivotBranch: async () => ({ branch: 'fresh' }),
    runPlanCandidateSet: async () => ({ approved: true, artifactDigest: digest, approval: { artifactDigest: digest, decidedBy: 'codex' },
      selected: { id: 'candidate-1', ...revised }, candidates: [{ id: 'candidate-1', plan: 'Original draft, never approved', gate: [] }],
      tokens: { total: { inputTokens: 42, outputTokens: 11 } }, messages: [{ speaker: 'claude', content: 'Drafted and revised.' }] }),
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = await executeRun(fixture.options);
  assert.equal(result.outcome, 'review-ready');
  assert.match(plans[2], /Approved revised approach/);
  assert.doesNotMatch(plans[2], /Original draft, never approved/);
  assert.deepEqual(gates.at(-1)[0], revised.gate[0]);
  assert.equal(result.tokens.total.inputTokens, 42);
});

function writeReview(cwd, { id, severity = 'blocking', testFile }) {
  mkdirSync(join(cwd, '__uro_review', 'tests'), { recursive: true });
  if (testFile) writeFileSync(join(cwd, testFile), `proof for ${id}\n`);
  writeFileSync(join(cwd, '__uro_review', 'REVIEW.md'), `
## ${id}
Severity: ${severity}
Category: correctness
Description: ${id} proves the implementation is broken.
${testFile ? `Test: ${testFile}` : ''}
`);
}

test('review scope violations are restored and retained in events and run facts', async () => {
  const events = [];
  const fixture = harness('review-scope-facts', {
    options: { reporter: (event) => events.push(event) },
    adapters: {
      runReview: async ({ cwd }) => {
        writeFileSync(join(cwd, 'implementation.js'), 'reviewer changed implementation\n');
        writeFileSync(join(cwd, 'reviewer-extra.js'), 'outside scope\n');
        writeReview(cwd, { id: 'F1', severity: 'suggestion' });
        return { launchFailed: false, timedOut: false };
      },
    },
  });
  try {
    const facts = await executeRun(fixture.options);
    assert.equal(readFileSync(join(fixture.target, 'implementation.js'), 'utf8'), 'implemented\n');
    assert.equal(existsSync(join(fixture.target, 'reviewer-extra.js')), false);
    assert.deepEqual(facts.reviewProtection.reviewerRestorations[0].paths,
      ['implementation.js', 'reviewer-extra.js']);
    const violation = events.find((event) => event.type === 'scope_violation');
    assert.deepEqual(violation.paths, ['implementation.js', 'reviewer-extra.js']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a throwing review pass still restores and records its out-of-scope writes', async () => {
  const fixture = harness('review-throw-restores', {
    adapters: {
      runReview: async ({ cwd }) => {
        writeFileSync(join(cwd, 'implementation.js'), 'reviewer edit before failure\n');
        throw new Error('reviewer crashed');
      },
    },
  });
  try {
    const facts = await executeRun(fixture.options);
    assert.equal(facts.outcome, 'verifier-failed');
    assert.equal(facts.debate.stopReason, 'review-failed');
    assert.equal(readFileSync(join(fixture.target, 'implementation.js'), 'utf8'), 'implemented\n');
    assert.deepEqual(facts.reviewProtection.reviewerRestorations[0].paths,
      ['implementation.js']);
    assert.match(facts.iterations[0].reviewer.error, /reviewer crashed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('executor review-file restoration and reviewer tests accumulate across rounds', async () => {
  const gateCommands = [];
  let executorCall = 0;
  let reviewRound = 0;
  const fixture = harness('review-accumulates', {
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCall++;
        writeFileSync(join(cwd, 'implementation.js'), `implementation ${executorCall}\n`);
        if (executorCall === 2) {
          rmSync(join(cwd, '__uro_review', 'tests', 'f1.test.js'));
        }
        return { changedFiles: ['implementation.js'], lastMessage: 'implemented' };
      },
      runReview: async ({ cwd }) => {
        reviewRound++;
        if (reviewRound === 1) {
          writeReview(cwd, {
            id: 'F1', testFile: '__uro_review/tests/f1.test.js',
          });
        } else if (reviewRound === 2) {
          writeReview(cwd, {
            id: 'F2', testFile: '__uro_review/tests/f2.test.js',
          });
        } else writeReview(cwd, { id: 'F3', severity: 'suggestion' });
        return { launchFailed: false, timedOut: false, dispositions: reviewRound >= 3
          ? ['F1', 'F2'].map((id) => ({ id, status: 'resolved', reason: 'The correction and reviewer tests cover the finding.' })) : [] };
      },
      runGate: async ({ commands }) => {
        gateCommands.push(commands.map((command) => ({ ...command, args: [...command.args] })));
        return { passed: true, results: [] };
      },
    },
  });
  try {
    const facts = await executeRun(fixture.options);
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(readFileSync(
      join(fixture.target, '__uro_review', 'tests', 'f1.test.js'), 'utf8'), 'proof for F1\n');
    assert.deepEqual(facts.reviewProtection.executorRestorations[0].paths,
      ['__uro_review/tests/f1.test.js']);
    assert.deepEqual(facts.reviewProtection.accumulatedTestFiles, [
      '__uro_review/tests/f1.test.js',
      '__uro_review/tests/f2.test.js',
    ]);
    assert.equal(gateCommands.length, 5);
    assert.deepEqual(gateCommands[0], [
      { bin: 'node', args: ['--test', 'test/original.test.js'] },
    ]);
    assert.deepEqual(gateCommands[1].at(-1), {
      bin: 'node',
      args: ['--test', 'test/original.test.js', '__uro_review/tests/f1.test.js'],
      harness: 'uro-review-tests',
    });
    assert.deepEqual(gateCommands[3].at(-1), {
      bin: 'node',
      args: [
        '--test', 'test/original.test.js',
        '__uro_review/tests/f1.test.js', '__uro_review/tests/f2.test.js',
      ],
      harness: 'uro-review-tests',
    });
    assert.deepEqual(gateCommands[4].at(-1), gateCommands[3].at(-1),
      'the reviewed implementation retains evidence from every accumulated reviewer test');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a failing reviewer test is evidence fed back to the executor through the debate', async () => {
  const plans = [];
  let gateCall = 0;
  let reviewRound = 0;
  const fixture = harness('review-gate-feedback', {
    options: { gateRetries: 1 },
    adapters: {
      runExecutor: async ({ cwd, plan }) => {
        plans.push(plan);
        writeFileSync(join(cwd, 'implementation.js'), `implementation ${plans.length}\n`);
        return { changedFiles: ['implementation.js'], lastMessage: 'implemented' };
      },
      runReview: async ({ cwd }) => {
        reviewRound++;
        if (reviewRound === 1) {
          writeReview(cwd, {
            id: 'F1', severity: 'blocking', testFile: '__uro_review/tests/f1.test.js',
          });
        } else if (reviewRound === 2) {
          // The reviewer's f1 test just exited 9; a second blocking finding
          // drives the fix round whose plan must carry that evidence.
          writeReview(cwd, {
            id: 'F2', severity: 'blocking', testFile: '__uro_review/tests/f2.test.js',
          });
        } else writeReview(cwd, { id: 'F3', severity: 'suggestion' });
        return { launchFailed: false, timedOut: false, dispositions: reviewRound >= 3
          ? ['F1', 'F2'].map((id) => ({ id, status: 'resolved', reason: 'The correction and reviewer tests cover the finding.' })) : [] };
      },
      runGate: async ({ commands }) => {
        gateCall++;
        if (gateCall !== 2) return { passed: true, results: [] };
        const reviewerCommand = commands.at(-1);
        return {
          passed: false,
          results: [{ ...reviewerCommand, code: 9, outputTail: 'reviewer proof failed' }],
        };
      },
    },
  });
  try {
    const facts = await executeRun(fixture.options);
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(plans.length, 3);
    // The round-2 fix plan carries the reviewer test's non-zero exit as
    // evidence — name, code and tail — in front of the executor.
    assert.match(plans[1], /Previous gate attempt failed/);
    assert.match(plans[1], /__uro_review\/tests\/f1[.]test[.]js/);
    assert.match(plans[1], /reviewer proof failed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
