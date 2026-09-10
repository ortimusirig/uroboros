import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { run } from '../src/run.js';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { planningEnvelope as envelope } from './fixtures/planning-responses.js';
import { runNestedGate } from './fixtures/nested-gate.js';

const usage = { inputTokens: 1, outputTokens: 1 };
const blocker = { id: 'F1', title: 'The reviewer objection must be handled.', blocking: true, status: 'open' };

function approve(request, issues = []) {
  const evidence = request.state.evidence.find(item => item.id === 'requirement-briefing');
  readFileSync(evidence.capturedPath);
  const receipt = createInspectionReceipt({ operationId: request.operationId, seat: 'claude',
    evidence: [evidence], inspected: true, result: 'read' });
  return { usage, observations: { evidence: [], receipts: [receipt] }, dialogue: envelope(request, 'approve', {
    issues,
    claims: [{ id: 'briefing-requirement', kind: 'fact', text: evidence.text, evidenceIds: [evidence.id] }],
    verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id],
      inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read the captured requirement.' }],
  }) };
}

function resolveFinding(kind = 'accepted') {
  return [{ id: 'F1', status: 'resolved', disposition: {
    kind, reason: kind === 'rejected' ? 'The captured requirement excludes the objection.' : 'The corrected source passes current checks.',
    claimIds: ['briefing-requirement'],
  } }];
}

function fixture(t, name, overrides = {}) {
  const base = process.platform === 'win32' ? 'C:/ccc-test' : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'arbiter-native-')), target = join(root, 'target');
  mkdirSync(join(target, 'test'), { recursive: true });
  writeFileSync(join(target, 'seed.txt'), 'seed\n');
  writeFileSync(join(target, 'test/base.test.cjs'),
    "require('node:assert/strict').match(require('node:fs').readFileSync('changed.txt','utf8'),/^version [1-4]\\n$/);");
  const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let writes = 0;
  const options = withVerifiedSuperpowers({
    task: 'Implement the approved behavior.', target, mode: 'autonomous',
    gate: [{ bin: process.execPath, args: ['--test', 'test/base.test.cjs'] }],
    scratchRoot: join(root, 'scratch'), artifactRoot: join(root, 'artifacts'), runId: name,
    ...overrides, adapters: {
      runGate: runNestedGate,
      runExecutor: request => {
        if (['propose', 'revise'].includes(request.action)) {
          writeFileSync(join(request.cwd, 'changed.txt'), 'version ' + ++writes + '\n');
        }
        return { usage, dialogue: envelope(request, request.action,
          request.action === 'rebut' ? { content: 'The original requirement excludes this objection.',
            next: { seat: 'claude', action: 'answer', reason: 'Settle F1 after reading the rebuttal' } } : {}) };
      },
      runReview: approve,
      runArbiter: () => { throw new Error('No separate third-seat judgment'); },
      ...overrides.adapters,
    },
  });
  return { options, writes: () => writes };
}

test('Claude cannot overrule its own finding before Codex gets a response turn', async t => {
  let reviews = 0;
  const item = fixture(t, 'response-before-disposition', { adapters: {
    runReview: request => {
      if (++reviews === 1) return { usage, dialogue: envelope(request, 'ask', {
        issues: [{ ...blocker, status: 'awaiting-answer' }],
        next: { seat: 'codex', action: 'rebut', reason: 'Respond to F1 before its disposition' },
      }) };
      assert.equal(request.action, 'answer');
      assert.equal(request.state.messages.at(-1).action, 'rebut');
      assert.match(request.input, /original requirement excludes/);
      return approve(request, resolveFinding('rejected'));
    },
  } });
  const facts = await run(item.options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(item.writes(), 1);
  assert.equal(facts.dialogue.messages.filter(message => message.sender === 'codex').length, 2);
  assert.equal(reviews, 2);
  assert.equal(facts.dialogue.issues.F1.status, 'resolved');
  assert.equal(facts.resources.providerLaunches, 4);
  assert.equal(Object.hasOwn(facts.tokens, 'arbiter'), false);
});

test('a conflicting review severity cannot let the execution controller close a blocker', async t => {
  let reviews = 0;
  const report = '## F1\nSeverity: blocking\nCategory: correctness\nDescription: Still wrong.\nTest: __uro_review/tests/f1.test.cjs\nSeverity: suggestion';
  const item = fixture(t, 'conflicting-review-severity', { adapters: {
    runReview: request => {
      if (++reviews === 1) return { usage, dialogue: envelope(request, 'ask', { issues: [blocker],
        next: { seat: 'codex', action: 'rebut', reason: 'Respond to F1' } }) };
      const response = approve(request, resolveFinding());
      return { ...response, resultSeen: true, resultUsable: true, materializationDeferred: true,
        answer: JSON.stringify({ version: 1, conclusion: 'clean', report,
          tests: [{ path: 'tests/f1.test.cjs', content: "require('node:assert/strict').ok(true);" }] })
          + '\n<UROBOROS_DIALOGUE>' + JSON.stringify(response.dialogue) + '</UROBOROS_DIALOGUE>' };
    },
  } });
  const facts = await run(item.options);
  assert.equal(facts.approved, false);
  assert.equal(facts.approval, null);
  assert.equal(facts.dialogue.issues.F1.status, 'open');
  assert.equal(reviews, 2);
  assert.match(JSON.stringify(facts), /review report/);
});

test('valid and unavailable judgements preserve findings and drive or retain fix work', async t => {
  for (const available of [true, false]) {
    let reviews = 0;
    const item = fixture(t, 'finding-available-' + available, { debateRounds: available ? undefined : 1, adapters: {
      runReview: request => {
        if (++reviews === 1) return { usage, dialogue: envelope(request, 'ask', { issues: [blocker],
          next: { seat: 'codex', action: 'revise', reason: 'Correct F1 using current checks' } }) };
        return approve(request, resolveFinding());
      },
    } });
    const facts = await run(item.options);
    assert.equal(facts.dialogue.issues.F1.status, available ? 'resolved' : 'open');
    assert.equal(facts.approved, available, facts.reason);
    assert.equal(item.writes(), available ? 2 : 1);
    assert.equal(reviews, available ? 2 : 1);
    if (!available) assert.match(facts.reason, /proposal|cycle|limit/);
  }
});

test('an uncapped debate runs past two rounds and current Claude corrections can converge', async t => {
  let reviews = 0;
  const item = fixture(t, 'uncapped-correction', { adapters: {
    runReview: request => ++reviews < 4 ? { usage, dialogue: envelope(request, 'ask', {
      issues: [blocker], next: { seat: 'codex', action: 'revise', reason: 'The latest remedy is promising; correct remaining F1' },
    }) } : approve(request, resolveFinding()),
  } });
  const facts = await run(item.options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(item.writes(), 4);
  assert.equal(reviews, 4);
  assert.equal(facts.dialogue.proposalCycles, 4);
  assert.equal(facts.dialogue.correctionCycles, 3);
  assert.equal(readFileSync(join(facts.dir, 'changed.txt'), 'utf8'), 'version 4\n');
  assert.match(facts.dialogue.messages.at(-2).input ?? JSON.stringify(facts.dialogue.messages), /latest remedy is promising/);
});

test('unavailable current Claude judgment stops without inventing an authority ruling', async t => {
  let reviews = 0;
  const item = fixture(t, 'unavailable-current-review', { adapters: {
    runReview: request => ++reviews < 3 ? { usage, dialogue: envelope(request, 'ask', {
      issues: [blocker], next: { seat: 'codex', action: 'revise', reason: 'Correct F1' },
    }) } : { launchFailed: true, resultSeen: false, usage, answer: 'reviewer unavailable' },
    createFreshPivotBranch: () => { throw new Error('No fallback reset'); },
    draftPlanCandidate: () => { throw new Error('No inferred replacement planning'); },
  } });
  const facts = await run(item.options);
  assert.equal(facts.approved, false);
  assert.equal(item.writes(), 3);
  assert.equal(reviews, 3);
  assert.equal(facts.dialogue.issues.F1.status, 'open');
  assert.equal(facts.dialogue.pendingDecision, null);
  assert.equal(facts.authority, 'claude');
  assert.equal(facts.resources.providerLaunches, 6);
  assert.equal(readFileSync(join(facts.dir, 'changed.txt'), 'utf8'), 'version 3\n');
});

test('the token budget is checked before dispatching a debate round', async t => {
  const item = fixture(t, 'budget-before-review', { tokenBudget: 5, adapters: {
    runExecutor: request => {
      writeFileSync(join(request.cwd, 'changed.txt'), 'version 1\n');
      return { usage: { inputTokens: 5, outputTokens: 0 }, dialogue: envelope(request, 'propose') };
    },
    runReview: () => { throw new Error('Budget must stop before review'); },
  } });
  const facts = await run(item.options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /budget-exhausted/);
  assert.equal(facts.resources.providerLaunches, 1);
  assert.equal(facts.resources.knownUsage.inputTokens, 5);
  assert.equal(facts.resources.knownUsage.outputTokens, 0);
  assert.equal(facts.dialogue.messages.some(message => message.sender === 'claude'), false);
  assert.equal(readFileSync(join(facts.dir, 'changed.txt'), 'utf8'), 'version 1\n');
});

test('autonomous challenges use Claude merits and unavailable review preserves a technical pause', async t => {
  for (const available of [true, false]) {
    let calls = 0, reviews = 0;
    const item = fixture(t, 'technical-merits-' + available, { adapters: {
      runExecutor: request => {
        if (++calls === 1) {
          writeFileSync(join(request.cwd, 'partial.txt'), 'retained');
          return { usage, dialogue: envelope(request, 'ask', { evidence: ['requirement-briefing'],
            issues: [{ id: 'Q1', kind: 'technical', title: 'Which option A or B?', status: 'awaiting-answer', blocking: false }],
            next: { seat: 'claude', action: 'answer', reason: 'Choose the option on its merits' } }) };
        }
        assert.equal(request.remainingWork, true);
        assert.match(request.input, /B fits the plan/);
        writeFileSync(join(request.cwd, 'changed.txt'), 'version 1\n');
        return { usage, dialogue: envelope(request, 'propose') };
      },
      runReview: request => {
        if (++reviews === 1) return available ? { usage, dialogue: envelope(request, 'answer', {
          content: 'B fits the plan.', next: { seat: 'codex', action: 'propose', reason: 'Finish only remaining work using B' },
        }) } : { launchFailed: true, resultSeen: false, usage, answer: 'reviewer unavailable' };
        return approve(request);
      },
    } });
    const facts = await run(item.options);
    assert.equal(facts.approved, available, facts.reason);
    assert.equal(calls, available ? 2 : 1);
    assert.equal(reviews, available ? 2 : 1);
    assert.equal(facts.dialogue.pendingDecision, null);
    assert.equal(facts.authority, 'claude');
    assert.equal(readFileSync(join(facts.dir, 'partial.txt'), 'utf8'), 'retained');
    if (available) assert.equal(facts.dialogue.proposalCycles, 1);
  }
});
