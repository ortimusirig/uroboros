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
import { execFileSync } from 'node:child_process';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { planningEnvelope as envelope, planningApproval } from './fixtures/planning-responses.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { materializeReviewBundle, reviewDigest } from '../src/review.js';
import { runReviewPass } from '../src/verifier.js';
import { EventEmitter } from 'node:events';

import { runNestedGate } from './fixtures/nested-gate.js';


const usage = { inputTokens: 1, outputTokens: 1 };
function approval(r, extra = {}) {
  const item = r.state.evidence.find(e => e.id === 'requirement-briefing');
  readFileSync(item.capturedPath);
  const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [item], inspected: true, result: 'read' });
  return { usage, observations: { evidence: [], receipts: [receipt] }, dialogue: envelope(r, 'approve', {
    claims: [{ id: 'briefing-requirement', kind: 'fact', text: item.text, evidenceIds: [item.id] }],
    verifications: [{ claimId: 'briefing-requirement', evidenceIds: [item.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read original requirement' }], ...extra,
  }) };
}
function deferred(r, response = approval(r), bundle = { version: 1, conclusion: 'clean', report: 'Checked current requirements and executed evidence.', tests: [] }) {
  return { ...response, resultSeen: true, resultUsable: true, materializationDeferred: true,
    answer: JSON.stringify(bundle) + '\n<UROBOROS_DIALOGUE>' + JSON.stringify(response.dialogue) + '</UROBOROS_DIALOGUE>' };
}
function harness(runId, overrides = {}) {
  const base = process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'uro-review-')), target = join(root, 'target'); mkdirSync(target);
  writeFileSync(join(target, 'seed.js'), 'module.exports = true;\n');
  mkdirSync(join(target, 'test')); writeFileSync(join(target, 'test/original.test.cjs'), "require('node:assert/strict').ok(true);\n");
  const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'base');
  return { root, target, options: withVerifiedSuperpowers({
    task: 'Implement the requested change.', target, gate: [{ bin: process.execPath, args: ['--test', 'test/original.test.cjs'] }],
    gateRetries: 0, scratchRoot: join(root, 'scratch'), artifactRoot: join(root, 'artifacts'), runId, mode: 'autonomous',
    ...overrides.options, adapters: {
      runGate: runNestedGate,
      runExecutor: r => { if (['propose', 'revise'].includes(r.action)) writeFileSync(join(r.cwd, 'implementation.js'), 'implemented\n');
        return { exitCode: 0, usage, dialogue: envelope(r, r.action) }; },
      runReview: r => deferred(r), ...overrides.adapters,
    },
  }) };
}
const openIssue = r => ({ usage, dialogue: envelope(r, 'ask', {
  issues: [{ id: 'I1', title: 'Possible excluded input', status: 'awaiting-answer', blocking: true }],
  next: { seat: 'codex', action: 'rebut', reason: 'Explain the excluded input' },
}) });
const resolvedIssue = [{ id: 'I1', status: 'resolved', disposition: { kind: 'rejected', reason: 'The briefing excludes it.', claimIds: ['briefing-requirement'] } }];

for (const [name, bundle, approved] of [
  ['missing', { report: 'I could not finish checking the implementation.' }, false],
  ['malformed', { conclusion: true, report: 'Incomplete review.' }, false],
  ['inconclusive', { conclusion: 'inconclusive', report: 'The dependency could not be inspected.' }, false],
  ['issues without findings', { conclusion: 'issues', report: 'An unresolved correctness issue remains.' }, false],
  ['clean with blocker', { conclusion: 'clean', report: '## F1\nSeverity: blocking\nDescription: Wrong behavior.\nTest: __uro_review/tests/f1.test.js' }, false],
  ['clean', { conclusion: 'clean', report: 'Checked the current diff against requirements and command evidence; no blockers remain.' }, true],
]) test(`production bundle-to-controller ${name} conclusion cannot invent approval`, async t => {
  let raw, launches = 0;
  const fixture = harness('bundle-' + name.replaceAll(' ', '-'), { adapters: { runReview: r => {
    const response = deferred(r, approval(r), { version: 1, tests: [], ...bundle }); raw = response.answer;
    return runReviewPass({ ...r, bin: process.execPath, env: {}, spawnProcess: () => {
      launches++; const child = new EventEmitter(); child.pid = 12345;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() {} };
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        result: raw, usage: { input_tokens: 1, output_tokens: 1 } }) + '\n')); child.emit('close', 0); });
      return child;
    } }).then(result => ({ ...result, observations: response.observations }));
  } } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.approved, approved, facts.reason); assert.equal(facts.outcome === 'review-ready', approved);
  assert.equal(launches, 1);
  const journal = readFileSync(join(facts.checkpointState.directory, '__uro_dialogue/journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const invocation = journal.find(event => event.type === 'prepare' && event.seat === 'claude' && event.effect === 'provider');
  const completion = journal.find(event => event.type === 'complete' && event.operationId === invocation.operationId);
  assert.equal(completion.result.answer, raw, 'exact raw review remains in its durable provider result');
  if (approved) {
    assert.equal(facts.approval.artifactDigest, reviewDigest(readFileSync(join(facts.dir, 'CHANGES.diff'))));
    assert.equal(facts.approval.contextDigest, facts.dialogue.snapshot.digest);
    assert.equal(facts.approval.messageId, facts.dialogue.approval.messageId);
    assert.ok(facts.dialogue.executionChecks);
  } else assert.equal(facts.approval, null);
});

for (const malformed of ['missing envelope', 'malformed envelope']) test(`clean bundle cannot rescue ${malformed} on a fresh run`, async t => {
  const fixture = harness('bundle-envelope', { adapters: { runReview: r => {
    const response = deferred(r); response.answer = JSON.stringify({ version: 1, conclusion: 'clean', report: 'No blockers.', tests: [] })
      + (malformed.startsWith('malformed') ? '\n<UROBOROS_DIALOGUE>{bad}</UROBOROS_DIALOGUE>' : '');
    delete response.dialogue; return response;
  } } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options); assert.equal(facts.approved, false); assert.equal(facts.approval, null);
});
test('queue accepts the real execution receipt only while its persisted diff is current and reviewed', async (t) => {
  for (const state of ['reviewed', 'skipped', 'changed']) {
    const fixture = harness(`queue-receipt-${state}`, { adapters: {
      runReview: state === 'skipped' ? null : r => deferred(r),
    } });
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const facts = await executeRun(fixture.options);
    assert.equal(facts.outcome === 'review-ready', state !== 'skipped');
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
  assert.equal(result.approved, false);
  assert.equal(result.resources.providerLaunches, 1);
  const events = readFileSync(join(result.checkpointState.directory, '__uro_dialogue/journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.some(e => e.type === 'prepare' && e.seat === 'claude'), false);
  assert.equal(Object.hasOwn(result.participation, 'claude'), false);
  assert.equal(result.messages.some((message) => message.speaker === 'claude'), false);
});


test('manual execution dispute reaches human after Codex rebuttal and Claude reply', async t => {
  let writes = 0, reviews = 0;
  const fixture = harness('manual-debate', { options: { mode: 'manual' }, adapters: {
    runExecutor: r => {
      if (r.action === 'rebut') return { usage, dialogue: envelope(r, 'rebut', { issues: [{ id: 'I1', status: 'disputed' }], content: 'The input is expressly excluded.' }) };
      writes++; writeFileSync(join(r.cwd, 'implementation.js'), 'implemented\n'); return { usage, dialogue: envelope(r, r.action) };
    },
    runReview: r => {
      if (++reviews === 1) return openIssue(r);
      assert.match(r.input, /expressly excluded/);
      return { usage, dialogue: envelope(r, 'decide', { content: 'The original task includes that input.' }) };
    },
    runArbiter: () => { throw Error('No third vote'); },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.outcome, 'needs-decision', facts.reason); assert.equal(writes, 1); assert.equal(reviews, 2);
  assert.equal(facts.checkpointState.version, 2); assert.equal(facts.dialogue.pendingDecision.authority, 'human');
  assert.equal(facts.dialogue.issues.I1.status, 'disputed'); assert.equal(facts.checkpointState.workspace.dir, facts.dir);
  assert.equal(facts.checkpointState.interactionMode, 'manual'); assert.match(JSON.stringify(facts.dialogue.messages), /original task includes/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(facts.checkpointState)));
});

test('omitting a prior blocker never manufactures closure', async t => {
  let reviews = 0;
  const fixture = harness('omitted-finding', { adapters: { runReview: r => ++reviews === 1 ? openIssue(r) : deferred(r) } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.approved, false); assert.equal(facts.dialogue.approval, null);
  assert.notEqual(facts.dialogue.issues.I1.status, 'resolved'); assert.equal(facts.dialogue.issues.I1.disposition, undefined);
});

for (const shape of [{}, 'dispute', null]) test(`malformed Codex replies ${JSON.stringify(shape)} preserve the open issue and complete checkpoint`, async t => {
  const raw = JSON.stringify({ findingResponses: shape }); let replies = 0, reviews = 0;
  const fixture = harness('malformed-reply', { adapters: {
    runExecutor: r => {
      if (r.action !== 'propose') { replies++; return { usage, exitCode: 0, lastMessage: raw }; }
      writeFileSync(join(r.cwd, 'implementation.js'), 'implemented\n'); return { usage, dialogue: envelope(r, 'propose') };
    },
    runReview: r => { reviews++; return openIssue(r); },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = await executeRun(fixture.options);
  assert.equal(result.approved, false); assert.equal(result.dialogue.approval, null);
  assert.notEqual(result.dialogue.issues.I1.status, 'resolved');
  assert.equal(replies, 2, 'original read-only reply plus the single permitted protocol repair');
  assert.equal(reviews, 1); assert.equal(result.resources.providerLaunches, 4); assert.equal(result.resources.repairLaunches, 1);
  assert.match(JSON.stringify(result.checkpointState), /findingResponses/);
});

test('a stale report or stale artifact cannot approve the current invocation', async t => {
  let saved;
  const fixture = harness('stale-review', { adapters: { runReview: r => {
    if (!saved) { saved = deferred(r, openIssue(r), { version: 1, conclusion: 'clean', report: 'Need clarification.', tests: [] }); return saved; }
    return { ...saved, answer: '{malformed', dialogue: undefined };
  } } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.approved, false); assert.equal(facts.approval, null);
  assert.equal(facts.dialogue.approval, null); assert.notEqual(facts.dialogue.issues.I1.status, 'resolved');
});

test('autonomous Claude withdrawal answers Codex and closes the explicit finding', async t => {
  let reviews = 0, writes = 0;
  const fixture = harness('autonomous-disposition', { adapters: {
    runExecutor: r => {
      if (r.action === 'propose') { writes++; writeFileSync(join(r.cwd, 'implementation.js'), 'implemented\n'); }
      return { usage, dialogue: envelope(r, r.action, r.action === 'rebut' ? { content: 'The contract excludes that case.',
        next: { seat: 'claude', action: 'answer', reason: 'Settle the explicit issue' } } : {}) };
    },
    runReview: r => ++reviews === 1 ? openIssue(r) : (assert.equal(r.action, 'answer'), deferred(r, approval(r, { issues: resolvedIssue }))),
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.approved, true, facts.reason); assert.equal(writes, 1); assert.equal(reviews, 2);
  assert.equal(facts.dialogue.issues.I1.status, 'resolved'); assert.equal(facts.dialogue.issues.I1.disposition.kind, 'rejected');
  assert.equal(facts.authority, 'claude'); assert.equal(facts.resources.providerLaunches, 4);
  assert.equal(facts.approval.messageId, facts.dialogue.messages.at(-1).id);
});

test('an unavailable autonomous challenge reviewer never changes authority to the human', async t => {
  let reviews = 0;
  const fixture = harness('autonomous-unavailable', { adapters: {
    runExecutor: r => { writeFileSync(join(r.cwd, 'partial.txt'), 'retained'); return { usage, dialogue: envelope(r, 'ask', {
      issues: [{ id: 'Q1', kind: 'technical', title: 'Which allowed behavior?', status: 'awaiting-answer', blocking: true }],
      evidence: ['requirement-briefing'], next: { seat: 'claude', action: 'answer', reason: 'Choose on the technical merits' },
    }) }; },
    runReview: () => { reviews++; return { launchFailed: true, answer: 'quota exhausted' }; },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = await executeRun(fixture.options);
  assert.equal(result.approved, false); assert.notEqual(result.outcome, 'needs-decision'); assert.equal(result.authority, 'claude');
  assert.equal(result.dialogue.pendingDecision, null); assert.equal(reviews, 1);
  assert.equal(readFileSync(join(result.dir, 'partial.txt'), 'utf8'), 'retained');
});

test('autonomous authority questions use Claude merits without operator-presence evidence', async t => {
  let attempts = 0, reviews = 0;
  const fixture = harness('autonomous-authority', { adapters: {
    runExecutor: r => {
      if (++attempts === 1) { writeFileSync(join(r.cwd, 'partial.txt'), 'retained'); return { usage, dialogue: envelope(r, 'ask', {
        issues: [{ id: 'Q1', kind: 'technical', title: 'Which allowed approach?', status: 'awaiting-answer', blocking: false }],
        evidence: ['requirement-briefing'], next: { seat: 'claude', action: 'answer', reason: 'Choose allowed approach' },
      }) }; }
      assert.equal(r.remainingWork, true); writeFileSync(join(r.cwd, 'implementation.js'), 'approved B\n');
      return { usage, dialogue: envelope(r, 'propose') };
    },
    runReview: r => ++reviews === 1 ? { usage, dialogue: envelope(r, 'answer', { content: 'B meets the original acceptance requirements.',
      next: { seat: 'codex', action: 'propose', reason: 'Finish remaining work using B' } }) } : deferred(r),
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = await executeRun(fixture.options); assert.equal(result.approved, true, result.reason);
  assert.equal(result.dialogue.pendingDecision, null); assert.equal(result.authority, 'claude'); assert.equal(result.escalation, undefined);
  assert.equal(result.dialogue.messages.filter(m => m.action === 'ask').length, 1);
  assert.equal(result.dialogue.messages.filter(m => m.action === 'answer').length, 1);
  assert.equal(result.dialogue.proposalCycles, 1); assert.match(readFileSync(join(result.dir, 'CHANGES.diff'), 'utf8'), /approved B/);
});
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

function legacyHarness(runId, overrides = {}) {
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

async function currentReview(options, { findings = '', tests = [], dispositions = [], conclusion = findings ? 'issues' : 'clean' } = {}) {
  const bundle = { version: 1, conclusion, report: findings || 'No blocking findings after checking requirements.', tests, dispositions };
  return { provider: 'claude', role: 'execution-reviewer', launchFailed: false, timedOut: false,
    answer: JSON.stringify(bundle), artifact: await materializeReviewBundle({ ...options, bundle }) };
}
const blocker = '## F1\nSeverity: blocking\nDescription: Branch drops valid input.\nTest: __uro_review/tests/f1.test.js\n';
const proof = { path: 'tests/f1.test.js', content: 'throw new Error("branch evidence");\n' };


async function historicalPending(fixture) {
  // Deliberate v1 compatibility-reader input. This is never obtained from a fresh native run.
  const cwd = fixture.target, diff = await fixture.options.adapters.diffText();
  const gateResult = await fixture.options.adapters.runGate({ commands: fixture.options.gate });
  writeFileSync(join(cwd, 'implementation.js'), 'implemented\n');
  mkdirSync(join(cwd, '__uro_review/tests'), { recursive: true });
  writeFileSync(join(cwd, '__uro_review/tests/f1.test.js'), proof.content);
  const finding = { id: 'F1', severity: 'blocking', description: 'Branch drops valid input.', test: '__uro_review/tests/f1.test.js', introducedAt: 0 };
  const checkpointState = {
    version: 1, phase: 'execution', stage: 'execution-dispute', runId: fixture.options.runId, interactionMode: 'manual', authority: 'human',
    workspace: { dir: cwd, targetPath: cwd, isRepo: false, source: 'copied', baseRef: 'HEAD', baseCommit: 'a'.repeat(40),
      branch: 'saved-copy', diff: typeof diff === 'string' ? diff : 'original implementation diff',
      diffDigest: reviewDigest(typeof diff === 'string' ? diff : 'original implementation diff') },
    originalPlan: fixture.options.task, plan: fixture.options.task, commands: fixture.options.gate, originalCommands: fixture.options.gate,
    iteration: 1, debateRound: 0, challengeRound: 0, iterations: [], messages: [{ id: 'saved-codex-rebuttal', speaker: 'codex', phase: 'execution',
      content: 'Input excluded by contract.', response: { exitCode: 0, lastMessage: JSON.stringify({ findingResponses: [{ id: 'F1', disposition: 'dispute', reason: 'Input excluded.' }] }) } }],
    openFindings: [finding], resolvedFindingIds: [], evidence: [], reviewerTests: ['__uro_review/tests/f1.test.js'],
    evidenceTestDigest: reviewDigest(JSON.stringify([['__uro_review/tests/f1.test.js', reviewDigest(proof.content)]])),
    gateResult, decision: { questions: [{ id: 'F1', text: finding.description,
      options: ['Accept Codex rebuttal', 'Require a correction'], recommendation: 'Require a correction' }] },
    stageTimeouts: { executor: fixture.options.executorTimeout ?? 60000, verifier: 60000, arbiter: 60000, gate: 60000 },
    options: { ...fixture.options, adapters: undefined, mode: 'manual', debateRounds: fixture.options.debateRounds ?? 5 },
  };
  return { dir: cwd, checkpointState };
}
for (const conclusion of ['issues', 'inconclusive']) test(`historical v1 human acceptance requires usable current ${conclusion} bundle evidence`, async t => {
  let resumed = false;
  const fixture = legacyHarness(`human-bundle-${conclusion}`, { adapters: {
    runExecutor: async () => ({ exitCode: 0, changedFiles: ['implementation.js'], lastMessage: JSON.stringify({
      findingResponses: [{ id: 'F1', disposition: 'dispute', reason: 'The input is explicitly excluded.' }] }) }),
    runReview: options => {
      const bundle = { version: 1, conclusion: resumed ? conclusion : 'issues', report: blocker, tests: [proof],
        dispositions: [{ id: 'F1', status: 'upheld', reason: 'I retain my objection to the excluded input.' }] };
      return runReviewPass({ ...options, bin: process.execPath, env: {}, spawnProcess: () => {
        const child = new EventEmitter(); child.pid = 12345;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() {} };
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
            result: JSON.stringify(bundle), usage: { input_tokens: 1, output_tokens: 1 } }) + '\n'));
          child.emit('close', 0);
        });
        return child;
      } });
    },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const pending = await historicalPending(fixture);

  resumed = true;
  const done = await execution.continueExecution({ checkpointState: pending.checkpointState,
    humanRuling: { decisionId: 'current-human', artifactDigest: 'current-artifact', answers: [{ id: 'F1', answer: 'Accept Codex rebuttal' }] },
    adapters: fixture.options.adapters });
  assert.equal(done.approved, conclusion === 'issues');
  if (conclusion === 'issues') {
    assert.equal(done.approval.basis, 'human');
    assert.equal(done.approval.decidedBy, 'human');
    assert.equal(done.approval.reviewEvidence.conclusion, 'issues');
    assert.deepEqual(done.approval.rulings.map(ruling => ruling.id), ['F1']);
  } else {
    assert.equal(done.approval, null);
    assert.equal(done.outcome, 'verifier-failed');
    assert.ok(done.messages.some(message => message.content.includes('inconclusive')));
  }
});

for (const change of ['correction', 'unrelated', 'diff', 'evidence']) test(`historical v1 human rulings preserve ${change} work for actual review`, async t => {
  let resumed = false;
  const fixture = legacyHarness(`human-${change}`, { options: { debateRounds: 4 }, adapters: {
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
  const pending = await historicalPending(fixture);

  resumed = true;
  const done = await execution.continueExecution({ checkpointState: pending.checkpointState,
    humanRuling: { decisionId: 'test-ruling', artifactDigest: 'test-artifact', answers: [{ id: 'F1',
      answer: change === 'correction' ? 'Require a correction' : 'Accept Codex rebuttal' }] }, adapters: fixture.options.adapters });
  assert.notEqual(done.outcome, 'review-ready', change);
  assert.equal(done.approved, false);
  assert.ok(done.debate.openFindings.some(finding => finding.id === (change === 'unrelated' ? 'F2' : 'F1')));
});

test('historical v1 manual continuation attaches to the saved copied workspace and delivers the human ruling to both agents', async (t) => {
  let isolates = 0, reviews = 0;
  const plans = [], requests = [];
  const fixture = legacyHarness('same-workspace', { options: { debateRounds: 9, executorTimeout: 123456 }, adapters: {
    runExecutor: async ({ plan }) => { plans.push(plan); return { exitCode: 0, changedFiles: ['implementation.js'],
      lastMessage: JSON.stringify({ findingResponses: [{ id: 'F1', disposition: 'dispute', reason: 'Input excluded by contract.' }] }) }; },
    runReview: async (options) => {
      requests.push(options.request);
      reviews++;
      return currentReview(options, { tests: [proof], dispositions: [{ id: 'F1', status: 'withdrawn', reason: 'Human confirmed the exclusion, and the implementation meets it.' }] });
    },
  } });
  const isolate = fixture.options.adapters.isolate;
  fixture.options.adapters.isolate = async (...args) => { isolates++; return { ...await isolate(...args), isRepo: false }; };
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const pending = await historicalPending(fixture);

  assert.equal(pending.checkpointState.stageTimeouts.executor, 123456);
  assert.equal(pending.checkpointState.options.debateRounds, 9);
  assert.equal(typeof execution.continueExecution, 'function');
  const done = await execution.continueExecution({ checkpointState: JSON.parse(JSON.stringify(pending.checkpointState)),
    humanRuling: { answers: [{ id: 'F1', answer: 'The input is excluded. Keep the current behavior.' }] }, adapters: fixture.options.adapters });
  assert.equal(done.outcome, 'review-ready');
  assert.equal(done.dir, pending.dir);
  assert.equal(isolates, 0);
  assert.equal(plans.length, 1);
  assert.equal(reviews, 1);
  assert.match(plans[0], /The input is excluded/);
  assert.match(JSON.stringify(requests[0].messages), /The input is excluded/);
  assert.equal(done.debate.roundsRun, 1);
  assert.equal(done.limits.timeoutsMs.executor, 123456);
  assert.equal(done.messages.filter((message) => message.speaker === 'human').length, 1);
});


test('fresh execution replans inherit both models and refuse unapproved candidates before resetting the branch', async t => {
  let planningRequest, writes = 0, resets = 0;
  const fixture = harness('fresh-approval', { options: { executorModel: 'codex-selected', executorEffort: 'high', verifierModel: 'claude-selected', arbiterModel: 'claude-selected' }, adapters: {
    runExecutor: r => { writes++; writeFileSync(join(r.cwd, 'implementation.js'), 'retained'); return { usage, dialogue: envelope(r, r.action) }; },
    runReview: r => ({ usage, dialogue: envelope(r, 'replan', { issues: [{ id: 'R1', title: 'Need revised parser', status: 'open', blocking: true }],
      replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'Completed parser reveals remaining input mismatch.' } }) }),
    createFreshPivotBranch: () => { resets++; throw Error('No reset'); },
    runPlanCandidateSet: r => { planningRequest = r; return { approved: false, reason: 'unapproved replacement', selected: null,
      selectedCandidateId: 'tempting', candidates: [{ id: 'tempting', plan: 'Unapproved replacement', gate: [] }] }; },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.approved, false); assert.equal(writes, 1); assert.equal(resets, 0);
  assert.equal(readFileSync(join(facts.dir, 'implementation.js'), 'utf8'), 'retained');
  assert.equal(planningRequest.interactionMode, 'autonomous'); assert.equal(planningRequest.mode, 'fresh');
  assert.equal(planningRequest.claudeModel, 'claude-selected'); assert.equal(planningRequest.codexModel, 'codex-selected');
  assert.equal(planningRequest.codexEffort, 'high');
});

test('fresh planning executes the approved revised proposal, preserving planning usage and the new gate', async t => {
  let reviews = 0, drafts = 0, planReviews = 0; const plans = [];
  const revised = { plan: 'Approved revised approach uses a bounded parser.', gate: [{ bin: process.execPath, args: ['-e', "process.stdout.write('approved-replan-gate')"] }] };
  const fixture = harness('approved-revision', { options: { pivotCandidates: 1 }, adapters: {
    runExecutor: r => { plans.push({ approvedPlan: r.approvedPlan, input: r.input }); if (plans.length > 1) assert.equal(readFileSync(join(r.cwd, 'first.txt'), 'utf8'), 'retained');
      writeFileSync(join(r.cwd, plans.length === 1 ? 'first.txt' : 'remaining.txt'), 'retained'); return { usage, dialogue: envelope(r, r.action) }; },
    runReview: r => ++reviews === 1 ? { usage, dialogue: envelope(r, 'replan', {
      issues: [{ id: 'R1', title: 'Remaining parser work', status: 'open', blocking: true }],
      replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'First work remains useful but the remaining input needs a bounded parser.' },
    }) } : deferred(r),
    draftPlanCandidate: r => ({ usage: { inputTokens: 20, outputTokens: 5 },
      ...(++drafts === 1 ? { plan: 'Original draft, never approved', gate: [] } : revised), dialogue: envelope(r, r.action) }),
    reviewPlanCandidate: r => ++planReviews === 1 ? { usage: { inputTokens: 1, outputTokens: 0 }, dialogue: envelope(r, 'ask', {
      next: { seat: 'claude', action: 'revise', reason: 'Replace the unapproved draft with the bounded parser and its real gate' },
    }) } : { usage: { inputTokens: 1, outputTokens: 1 }, ...planningApproval(r) },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = await executeRun(fixture.options);
  assert.equal(result.approved, true, result.reason); assert.equal(plans.length, 2);
  assert.equal(drafts, 2); assert.equal(planReviews, 2);
  assert.equal(plans[1].approvedPlan, revised.plan + '\n');
  assert.doesNotMatch(plans[1].input.split('Requested codex action:')[0], /Original draft, never approved/);
  assert.match(plans[1].input, /Original draft, never approved/, 'the rejected draft remains historical evidence, not the authorized current task');
  const phases = result.checkpointState.phaseChain; assert.equal(phases.length, 3);
  assert.equal(new Set(phases.map(p => p.runId)).size, 3);
  assert.equal(phases[1].checkpointState.dialogue.approval.seat, 'codex');
  assert.equal(result.resources.knownUsage.inputTokens, 46); assert.equal(result.resources.knownUsage.outputTokens, 15);
  const check = result.dialogue.evidence.find(e => e.kind === 'command' && e.stdout === 'approved-replan-gate');
  assert.equal(check.exitCode, 0); assert.deepEqual(check.argv, [process.execPath, ...revised.gate[0].args]);
  assert.equal(result.approval.contextDigest, result.dialogue.snapshot.digest);
});

async function reviewerCorrection(t, runId) {
  const executorRequests = [], reviewerRequests = []; let writes = 0;
  const code = "const fs=require('node:fs');process.stdout.write('unique independent failure evidence');process.stderr.write('reviewer proof stderr');require('node:assert/strict').equal(fs.readFileSync('implementation.js','utf8'),'corrected\\n');";
  const fixture = harness(runId, { adapters: {
    runExecutor: r => { executorRequests.push(r); writeFileSync(join(r.cwd, 'implementation.js'), ++writes === 1 ? 'broken\n' : 'corrected\n');
      return { usage, dialogue: envelope(r, r.action) }; },
    runReview: r => {
      reviewerRequests.push(r);
      if (reviewerRequests.length === 1) return deferred(r, approval(r), { version: 1, conclusion: 'clean',
        report: 'Run this independent current behavior check.', tests: [{ path: 'tests/f1.test.cjs', content: code }] });
      if (reviewerRequests.length === 2) {
        const failed = r.state.evidence.find(e => e.kind === 'command' && e.exitCode !== 0);
        assert.ok(failed, JSON.stringify(r.state.evidence.filter(e => e.kind === 'command'))); assert.match(failed.stdout, /unique independent failure evidence/);
        return { usage, dialogue: envelope(r, 'ask', { next: { seat: 'codex', action: 'revise', reason: 'Correct the source using failing reviewer evidence' } }) };
      }
      assert.equal(readFileSync(join(r.cwd, 'implementation.js'), 'utf8'), 'corrected\n');
      return deferred(r);
    },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  return { facts: await executeRun(fixture.options), executorRequests, reviewerRequests };
}

test('new reviewer test output reaches Codex and Claude before closure', async t => {
  const { facts, executorRequests, reviewerRequests } = await reviewerCorrection(t, 'review-evidence-delivery');
  assert.equal(facts.approved, true, facts.reason); assert.equal(executorRequests.length, 2); assert.equal(reviewerRequests.length, 3);
  assert.match(executorRequests[1].input, /unique independent failure evidence/);
  assert.match(reviewerRequests[2].input, /unique independent failure evidence/);
  const records = facts.dialogue.evidence.filter(e => e.kind === 'command' && e.argv.some(arg => arg.includes('f1.test.cjs')));
  assert.ok(records.some(e => e.exitCode !== 0)); assert.equal(records.at(-1).exitCode, 0);
  for (const e of records) { assert.equal(e.cwd, facts.dir); assert.ok(e.codeIdentity); assert.match(e.stdout + e.stderr, /reviewer proof stderr/); }
  assert.equal(facts.approval.contextDigest, facts.dialogue.snapshot.digest);
});

test('a failing reviewer test is evidence fed back to the executor through the debate', async t => {
  const { facts, executorRequests } = await reviewerCorrection(t, 'review-gate-feedback');
  assert.equal(facts.approved, true, facts.reason); assert.equal(executorRequests[1].action, 'revise');
  assert.match(executorRequests[1].input, /reviewer proof stderr/);
  assert.equal(readFileSync(join(facts.dir, 'implementation.js'), 'utf8'), 'corrected\n');
  assert.equal(facts.dialogue.proposalCycles, 2); assert.equal(facts.dialogue.correctionCycles, 1);
  const failed = facts.dialogue.evidence.find(e => e.kind === 'command' && e.exitCode !== 0);
  assert.ok(failed); assert.match(failed.stdout, /unique independent failure evidence/);
});

test('review scope violations are restored and retained in events and run facts', async t => {
  const events = [];
  const fixture = harness('review-scope-facts', { options: { reporter: e => events.push(e) }, adapters: {
    runReview: r => { writeFileSync(join(r.cwd, 'implementation.js'), 'unauthorized'); writeFileSync(join(r.cwd, 'reviewer-extra.js'), 'outside');
      return deferred(r); },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.approved, true, facts.reason); assert.equal(readFileSync(join(facts.dir, 'implementation.js'), 'utf8'), 'implemented\n');
  assert.equal(existsSync(join(facts.dir, 'reviewer-extra.js')), false);
  assert.deepEqual(facts.checkpointState.supervision.observations.find(o => o.seat === 'claude').restoration.paths, ['implementation.js', 'reviewer-extra.js']);
  assert.deepEqual(events.find(e => e.type === 'scope_violation' && e.stage === 'verify').paths, ['implementation.js', 'reviewer-extra.js']);
  assert.match(readFileSync(join(facts.dir, '__uro_review/REVIEW.md'), 'utf8'), /Checked current requirements/);
});

test('a throwing review pass still restores and records its out-of-scope writes', async t => {
  let reviews = 0; const events = [];
  const fixture = harness('review-throw-restores', { options: { reporter: e => events.push(e) }, adapters: {
    runReview: r => { reviews++; writeFileSync(join(r.cwd, 'implementation.js'), 'unauthorized'); throw Error('reviewer crashed'); },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options);
  assert.equal(facts.approved, false); assert.equal(reviews, 1);
  assert.equal(readFileSync(join(facts.dir, 'implementation.js'), 'utf8'), 'implemented\n');
  assert.deepEqual(events.find(e => e.type === 'scope_violation' && e.stage === 'verify').paths, ['implementation.js']);
  assert.match(JSON.stringify(facts), /reviewer crashed/); assert.equal(existsSync(join(facts.dir, '__uro_review/REVIEW.md')), false);
});

test('executor review-file restoration and reviewer tests accumulate across rounds', async t => {
  let writes = 0, reviews = 0;
  const events = [];
  const first = "require('node:assert/strict').ok(true);", second = "require('node:assert/strict').equal(2,2);";
  const fixture = harness('review-accumulates', { options: { reporter: e => events.push(e) }, adapters: {
    runExecutor: r => { writes++; writeFileSync(join(r.cwd, 'implementation.js'), 'implementation ' + writes);
      if (writes === 2) rmSync(join(r.cwd, '__uro_review/tests/f1.test.cjs'));
      return { usage, dialogue: envelope(r, r.action) }; },
    runReview: r => {
      reviews++;
      if (reviews === 1 || reviews === 3) return deferred(r, approval(r), { version: 1, conclusion: 'clean', report: 'Current additional check.',
        tests: [{ path: reviews === 1 ? 'tests/f1.test.cjs' : 'tests/f2.test.cjs', content: reviews === 1 ? first : second }] });
      if (reviews === 2) return { usage, dialogue: envelope(r, 'ask', { next: { seat: 'codex', action: 'revise', reason: 'Revise source while keeping independent reviewer checks' } }) };
      return deferred(r);
    },
  } });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const facts = await executeRun(fixture.options); assert.equal(facts.approved, true, facts.reason);
  assert.equal(writes, 2); assert.equal(reviews, 4);
  assert.equal(readFileSync(join(facts.dir, '__uro_review/tests/f1.test.cjs'), 'utf8'), first);
  assert.equal(readFileSync(join(facts.dir, '__uro_review/tests/f2.test.cjs'), 'utf8'), second);
  assert.deepEqual(events.find(e => e.type === 'scope_violation' && e.stage === 'executor').paths, ['__uro_review/tests/f1.test.cjs']);
  assert.deepEqual(facts.checkpointState.supervision.observations.find(o => o.seat === 'codex' && o.restoration?.paths.length).restoration.paths, ['__uro_review/tests/f1.test.cjs']);
  assert.deepEqual(facts.reviewProtection.accumulatedTestFiles, ['__uro_review/tests/f1.test.cjs', '__uro_review/tests/f2.test.cjs']);
  const check = facts.dialogue.evidence.filter(e => e.kind === 'command').at(-1);
  assert.ok(check.argv.includes('__uro_review/tests/f1.test.cjs')); assert.ok(check.argv.includes('__uro_review/tests/f2.test.cjs'));
  assert.equal(check.exitCode, 0); assert.equal(facts.approval.contextDigest, facts.dialogue.snapshot.digest);
});
