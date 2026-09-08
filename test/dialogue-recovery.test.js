import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deriveMergeContext, MERGE_LEDGER_FILENAME } from '../src/merge.js';
import { run } from '../src/run.js';
import { runPlan } from '../src/plan.js';
import { runQueue } from '../src/queue.js';
import { assertCleanTarget, landQueueDiff } from '../src/queue-runtime.js';
import { resumeRun } from '../src/resume.js';
import { parseArgs } from '../src/args.js';
import { readCheckpoint, saveCheckpoint } from '../src/checkpoint.js';
import { openDialogueJournal } from '../src/dialogue-journal.js';
import { contextLifecycle } from '../src/planning-dialogue.js';
import { spawnCapture } from '../src/spawn.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { scriptedFreshPlanningAdapters, planningApproval } from './fixtures/planning-responses.js';

function envelope(request, action, extra = {}) {
  return { schemaVersion: 1, action, artifactDigest: request.state.artifactDigest,
    contextDigest: request.state.snapshot.digest, replyTo: null, content: 'Fixture response',
    claims: [], issues: [], evidence: [], verifications: [], next: null, ...extra };
}
function invokeResumeWithContinue(runDirectory, adapters = {}) {
  const { command, ...options } = parseArgs(['resume', '--run', runDirectory, '--continue']);
  return resumeRun({ ...options, adapters });
}
function executionApproval(request) {
  const evidence = request.state.evidence.find(item => item.id === 'requirement-briefing');
  readFileSync(evidence.capturedPath);
  const receipt = createInspectionReceipt({ operationId: request.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' });
  return { dialogue: envelope(request, 'approve', {
    claims: [{ id: 'briefing-requirement', kind: 'fact', text: evidence.text, evidenceIds: [evidence.id] }],
    verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id],
      result: 'supports', reason: 'Read the captured current requirement' }],
  }), observations: { evidence: [], receipts: [receipt] }, usage: { inputTokens: 1, outputTokens: 1 } };
}
test('public planning child enforces its supplied remaining allowance before a second launch', async () => {
  const base = mkdtempSync(join(process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(), 'uro-plan-budget-'));
  const target = join(base, 'target'); mkdirSync(target);
  let calls = 0;
  const result = await runPlan(withVerifiedSuperpowers({ target, out: join(base, 'plan'),
    artifactRoot: join(base, 'artifacts'), goal: 'Plan a bounded change', tokenBudget: 5, rounds: 7,
    adapters: { author: request => { calls++;
      return { answer: '<PLAN>Bounded change</PLAN><GATE>[]</GATE>', dialogue: envelope(request, 'propose'),
        usage: { inputTokens: 2, outputTokens: 3 } };
    }, reviewer: () => assert.fail('no allowance remains for review') } }));
  assert.equal(calls, 1);
  assert.equal(result.approved, false);
  assert.equal(result.resources.providerLaunches, 1);
  const saved = readCheckpoint(result.checkpoint.directory);
  assert.equal(saved.continuation.roundsLimit, 7);
  await assert.rejects(() => invokeResumeWithContinue(result.checkpoint.directory), /budget.*exhausted/);
});
async function humanFixture(mode = 'autonomous', kind = 'product', pause = null, tokenBudget = 100, contextFactory) {
  const scratchBase = process.platform === 'win32' ? 'C:/ccc-test' : tmpdir();
  mkdirSync(scratchBase, { recursive: true });
  const base = mkdtempSync(join(scratchBase, 'uro-recovery-')), target = join(base, 'target');
  mkdirSync(target); writeFileSync(join(target, 'source.js'), 'before\n');
  const counter = join(base, 'calls.txt'); writeFileSync(counter, '0');
  const contextRef = contextFactory?.({ target, base });
  const adapters = {
    runExecutor: async request => {
      if (contextRef) assert.match(request.input, /queue-specific compatibility requirement/, 'child must consume retained queue context');
      writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1));
      writeFileSync(join(request.cwd, 'source.js'), 'retained partial implementation\n');
      if (pause === 'uncertain') return { exitCode: 0, lastMessage: 'Unstructured mutating response', usage: { inputTokens: 2, outputTokens: 3 } };
      if (pause === 'reviewer-unavailable') return { exitCode: 0, dialogue: envelope(request, 'propose'), usage: { inputTokens: 2, outputTokens: 3 } };
      return { exitCode: 0, usage: { inputTokens: 2, outputTokens: 3 }, dialogue: envelope(request, 'ask', {
        content: 'Which compatibility policy applies?', issues: [{ id: 'H1', title: 'Compatibility policy',
          status: 'awaiting-answer', blocking: true, kind, needsHuman: true }],
        next: { seat: 'claude', action: 'answer', reason: 'Review the required user decision' } }) };
    }, runReview: pause ? null : () => assert.fail('review launched before human answer'),
  };
  const result = await run(withVerifiedSuperpowers({ target, scratchRoot: join(base, 'scratch'),
    artifactRoot: join(base, 'artifacts'), runId: 'human-recovery', task: 'Preserve compatibility', gate: [],
    mode, debateRounds: 7, tokenBudget, contextRef, adapters }));
  return { base, target, counter, result, adapters };
}

test('public child execution persists queue grounding into its current context and root archive', async () => {
  const { createSharedContext, persistSharedContext } = await import('../src/shared-context.js');
  const { resolveProjectIdentity } = await import('../src/project-memory.js');
  const f = await humanFixture('autonomous', 'product', null, 100, ({ target, base }) => {
    const project = resolveProjectIdentity({ target });
    const snapshot = createSharedContext({ projectId: project.projectId, runId: 'queue-current', unitId: 'queue-current:1',
      phase: 'queue', sourceRevision: 'queue-input', entries: [{ id: 'queue-requirement', kind: 'requirement',
        content: 'queue-specific compatibility requirement', sourceIdentity: 'queue-input', status: 'required', provenance: { origin: 'queue' } }] });
    const path = persistSharedContext({ directory: base, snapshot });
    return { schemaVersion: 1, path, projectId: project.projectId, runId: snapshot.runId, unitId: snapshot.unitId, contextDigest: snapshot.digest };
  });
  assert.equal(f.result.outcome, 'needs-decision', f.result.reason);
  assert.match(JSON.stringify(f.result.dialogue.snapshot.entries), /queue-specific compatibility requirement/);
  const archive = readCheckpoint(f.result.artifacts.directory);
  assert.match(JSON.stringify(archive.continuation.dialogue.snapshot.entries), /queue-specific compatibility requirement/);
});

test('technical CLI continuation is distinct from a human answer and cannot override saved controls', () => {
  assert.deepEqual(parseArgs(['resume', '--run', 'saved', '--continue']), {
    command: 'resume', runDirectory: 'saved', technicalContinue: true });
  assert.throws(() => parseArgs(['resume', '--run', 'saved', '--continue', '--decision-file', 'answer.json']));
  assert.throws(() => parseArgs(['resume', '--run', 'saved', '--continue', '--mode', 'manual']));
});

test('technical continuation reuses completed implementation and accounts only the resumed reviewer launch', async () => {
  const f = await humanFixture('autonomous', 'product', 'reviewer-unavailable');
  assert.equal(f.result.nextAction, 'paused');
  assert.ok(existsSync(join(f.result.dir, 'uro-checkpoint.json')), 'technical pause must be durable');
  const prior = readCheckpoint(f.result.dir);
  const result = await invokeResumeWithContinue(f.result.dir, {
    runExecutor: () => assert.fail('completed writer replayed'),
    runReview: request => {
      const evidence = request.state.evidence.find(item => item.id === 'requirement-briefing');
      readFileSync(evidence.capturedPath);
      const receipt = createInspectionReceipt({ operationId: request.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' });
      return { dialogue: envelope(request, 'approve', {
        claims: [{ id: 'briefing-requirement', kind: 'fact', text: evidence.text, evidenceIds: [evidence.id] }],
        verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id],
          result: 'supports', reason: 'Read the retained requirement' }],
      }), observations: { evidence: [], receipts: [receipt] }, usage: { inputTokens: 7, outputTokens: 11 } };
    },
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.resources.providerLaunches, 2);
  assert.equal(result.resources.knownUsage.inputTokens, 9);
  assert.equal(result.resources.knownUsage.outputTokens, 14);
  assert.equal(result.checkpointState.options.tokenBudget, prior.continuation.options.tokenBudget);
  assert.equal(result.checkpointState.options.debateRounds, 7);
  assert.equal(readFileSync(f.counter, 'utf8'), '1');
  const replay = await invokeResumeWithContinue(f.result.dir, {
    runExecutor: () => assert.fail('writer replay'), runReview: () => assert.fail('review replay') });
  assert.deepEqual(replay.resources, result.resources);
});

test('public continuation refuses an authenticated prepared external operation with no completed receipt', async () => {
  const f = await humanFixture('autonomous', 'product', 'reviewer-unavailable');
  const saved = readCheckpoint(f.result.dir), state = saved.continuation;
  const journal = openDialogueJournal({ directory: state.directory, runId: state.runId, projectId: state.dialogue.projectId });
  journal.prepare({ operationId: `${state.runId}:external-unknown`, effect: 'provider', seat: 'codex', action: 'revise',
    input: 'prepared but unknown external result', artifactDigest: state.dialogue.artifactDigest,
    contextDigest: state.dialogue.snapshot.digest, evidenceIds: [], unreadMessageIds: [] });
  const tail = journal.read().at(-1); journal.close();
  state.journalIdentity = { sequence: tail.sequence, hash: tail.hash };
  state.executionArtifacts = contextLifecycle.manifest({ directory: state.directory, runId: state.runId,
    contextDigest: state.dialogue.snapshot.digest, registeredPaths: state.executionArtifacts.files.map(file => join(state.directory, file.path)) });
  await saveCheckpoint({ directory: f.result.dir, checkpointState: state, previous: saved });
  await assert.rejects(() => invokeResumeWithContinue(f.result.dir, {
    runExecutor: () => assert.fail('uncertain operation replay'), runReview: () => assert.fail('review before reconciliation'),
  }), /uncertain prepared external effect/);
  assert.equal(readCheckpoint(f.result.dir).technicalReceipts?.length ?? 0, 0);
});

test('public planning answer preserves visible recall fallback and promotes a lesson once across replay', async () => {
  const base = mkdtempSync(join(process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(), 'uro-recall-resume-'));
  const target = join(base, 'target'); mkdirSync(target);
  const pending = await runPlan(withVerifiedSuperpowers({ target, out: join(base, 'plan'), goal: 'Preserve compatibility',
    artifactRoot: join(base, 'artifacts'), interactionMode: 'autonomous', searchIndex: () => { throw new Error('optional index offline'); },
    adapters: { author: request => ({ plan: 'Preserve compatibility', gate: [], dialogue: envelope(request, 'propose'),
      usage: { inputTokens: 1, outputTokens: 1 } }), reviewer: request => ({ dialogue: envelope(request, 'ask', {
      issues: [{ id: 'H1', title: 'Policy', kind: 'product', needsHuman: true, blocking: true, status: 'awaiting-answer' }] }),
      usage: { inputTokens: 1, outputTokens: 1 } }) } }));
  const saved = readCheckpoint(pending.checkpoint.directory), decisionFile = join(base, 'answer.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: saved.pending.questions.map(q => ({ id: q.id, answer: 'Preserve compatibility' })) }));
  let calls = 0;
  const adapters = { author: () => assert.fail('completed proposal replay'), reviewer: request => {
    calls++; assert.match(request.input, /optional index offline/);
    assert.equal(request.state.snapshot.entries.find(e => e.id === 'requirements').status, 'required');
    const response = planningApproval(request);
    response.dialogue.issues = [{ id: 'H1', title: 'Policy', status: 'resolved',
      disposition: { kind: 'accepted', reason: 'Current captured briefing supports direction', claimIds: ['briefing-requirement'] } }];
    response.dialogue.memoryProposals = [{ id: 'compatibility-lesson', kind: 'lesson', content: 'Preserve compatibility',
      claimIds: ['briefing-requirement'], tags: [] }];
    return { ...response, usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const result = await resumeRun({ runDirectory: pending.checkpoint.directory, decisionFile, adapters });
  assert.equal(result.approved, true, result.reason); assert.equal(result.recall.status, 'fallback');
  const entries = join(result.checkpointState.memoryDirectory, 'entries');
  assert.equal(readdirSync(entries).length, 1);
  await resumeRun({ runDirectory: pending.checkpoint.directory, decisionFile, adapters });
  assert.equal(calls, 1); assert.equal(readdirSync(entries).length, 1);
});

test('technical continuation refuses ambiguous completed writer bytes before another effect', async () => {
  const f = await humanFixture('autonomous', 'product', 'uncertain');
  assert.ok(existsSync(join(f.result.dir, 'uro-checkpoint.json')), 'uncertain retained pause must be durable');
  await assert.rejects(() => invokeResumeWithContinue(f.result.dir, {
    runExecutor: () => assert.fail('uncertain writer replay'), runReview: () => assert.fail('uncertain reviewer launch'),
  }), /uncertain|reconcil|unreadable|safe/i);
  assert.equal(readFileSync(f.counter, 'utf8'), '1');
});

test('public native recovery reuses completed mutation with exact materialized reviewer support and no extra usage', async () => {
  const base = mkdtempSync(join(process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(), 'uro-mutation-resume-'));
  const target = join(base, 'target'); mkdirSync(target);
  const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@local');
  writeFileSync(join(target, 'work.js'), 'module.exports = function work() {\n  return 1;\n};\n');
  writeFileSync(join(target, 'work.test.cjs'), "require('./work.js');\n"); git('add', '.'); git('commit', '-m', 'baseline');
  let reviews = 0, mutationCalls = 0;
  const pending = await run(withVerifiedSuperpowers({ target, task: 'Preserve compatibility', mode: 'autonomous',
    gate: [{ bin: process.execPath, args: ['--test', 'work.test.cjs'] }], runId: 'mutation-public',
    scratchRoot: join(base, 'scratch'), artifactRoot: join(base, 'artifacts'),
    mutation: { concurrency: 1, budget: 1, tests: { command: { bin: process.execPath, args: ['work.test.cjs'] } } },
    adapters: {
      runExecutor: request => { writeFileSync(join(request.cwd, 'work.js'), 'module.exports = function work() {\n  return 2;\n};\n');
        return { dialogue: envelope(request, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } }; },
      runMutationSeat: (_bin, _args, options) => { mutationCalls++; return spawnCapture(process.execPath, ['-e',
        `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({verdict:'gap',reasoning:'Review surviving deletion'})}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));});`], options); },
      runReview: request => {
        if (++reviews === 1) {
          const response = executionApproval(request);
          const bundle = { version: 1, conclusion: 'clean', report: 'Verify with the captured reviewer support.', tests: [
            { path: 'tests/current.test.cjs', content: "require('../../work.js'); const sibling='./helper.cjs'; require(sibling);" },
            { path: 'tests/helper.cjs', content: "module.exports='verified support';" } ] };
          return { ...response, resultSeen: true, resultUsable: true, materializationDeferred: true,
            answer: `${JSON.stringify(bundle)}\n<UROBOROS_DIALOGUE>${JSON.stringify(response.dialogue)}</UROBOROS_DIALOGUE>` };
        }
        return { dialogue: envelope(request, 'ask', { issues: [{ id: 'H1', title: 'Policy', status: 'awaiting-answer',
          kind: 'product', needsHuman: true, blocking: true }] }), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    } }));
  assert.equal(pending.outcome, 'needs-decision', pending.reason);
  const saved = readCheckpoint(pending.dir), analysis = saved.continuation.mutation.analysis;
  assert.equal(analysis.selection.testSupportFiles.length, 2);
  const decisionFile = join(base, 'answer.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: saved.pending.questions.map(q => ({ id: q.id, answer: 'Preserve compatibility' })) }));
  const result = await resumeRun({ runDirectory: pending.dir, decisionFile, adapters: {
    runExecutor: () => assert.fail('completed implementation replay'),
    runMutationSeat: () => assert.fail('completed mutation inference replay'),
    runReview: request => { const response = executionApproval(request);
      response.dialogue.issues = [{ id: 'H1', title: 'Policy', status: 'resolved', disposition: { kind: 'accepted',
        reason: 'Current captured briefing supports this direction', claimIds: ['briefing-requirement'] } }]; return response; },
  } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.checkpointState.mutation.analysis.operationId, analysis.operationId);
  assert.deepEqual(result.checkpointState.mutation.analysis.selection.testSupportFiles, analysis.selection.testSupportFiles);
  assert.equal(result.resources.providerLaunches, pending.resources.providerLaunches + 1);
  assert.equal(result.resources.knownUsage.inputTokens, pending.resources.knownUsage.inputTokens + 1);
  assert.equal(mutationCalls, 4);
});

test('technical continuation rejects an exhausted saved budget without consuming a receipt', async () => {
  const f = await humanFixture('autonomous', 'product', 'reviewer-unavailable', 5);
  await assert.rejects(() => invokeResumeWithContinue(f.result.dir, {
    runExecutor: () => assert.fail('writer under exhausted budget'), runReview: () => assert.fail('reviewer under exhausted budget'),
  }), /budget-exhausted|budget.*exhausted/);
  assert.equal(readCheckpoint(f.result.dir).technicalReceipts?.length ?? 0, 0);
  assert.equal(readFileSync(f.counter, 'utf8'), '1');
});

test('required journal corruption rejects a native answer before providers', async () => {
  const f = await humanFixture();
  const saved = readCheckpoint(f.result.dir), decisionFile = join(f.base, 'answers.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: saved.runId,
    artifactDigest: saved.artifactDigest, answers: [{ id: saved.pending.questions[0].id, answer: 'keep compatibility' }] }));
  writeFileSync(join(saved.continuation.directory, '__uro_dialogue', 'journal.jsonl'), '{}\n');
  await assert.rejects(() => resumeRun({ runDirectory: f.result.dir, decisionFile, adapters: {
    runExecutor: () => assert.fail('writer after corrupt journal'), runReview: () => assert.fail('review after corrupt journal'),
  } }), /journal|manifest|corrupt|changed/);
  assert.equal(readCheckpoint(f.result.dir).receipts.length, 0, 'invalid required input must not accept an answer');
  assert.equal(readFileSync(f.counter, 'utf8'), '1');
});

for (const manualArtifact of [false, true]) test(`public retained planning ${manualArtifact ? 'manual artifact approval' : 'scoped answer'} resumes the selected phase and only remaining execution`, async () => {
  const base = mkdtempSync(join(process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(), 'uro-retained-resume-'));
  const target = join(base, 'target'); mkdirSync(target); writeFileSync(join(target, 'source.js'), 'before\n');
  let writes = 0, reviews = 0, drafts = 0, planningReviews = 0;
  const adapters = scriptedFreshPlanningAdapters({
    runExecutor: request => {
      if (writes) assert.equal(readFileSync(join(request.cwd, 'source.js'), 'utf8'), 'retained\n');
      writeFileSync(join(request.cwd, 'source.js'), ++writes === 1 ? 'retained\n' : 'completed\n');
      return { exitCode: 0, dialogue: envelope(request, request.action), usage: { inputTokens: 1, outputTokens: 1 } };
    },
    runReview: request => ++reviews === 1 ? { dialogue: envelope(request, 'replan', {
      content: 'Remaining work requires a revised compatibility strategy',
      issues: [{ id: 'R1', title: 'Remaining strategy', blocking: true, status: 'open' }],
      replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'Retained implementation exposes a remaining strategy decision' },
    }), usage: { inputTokens: 1, outputTokens: 1 } } : executionApproval(request),
    draftPlanCandidate: () => { drafts++; return { plan: 'Finish only the remaining compatibility work.\n', gate: [],
      agree: true, readable: true, usage: { inputTokens: 1, outputTokens: 1 } }; },
    reviewPlanCandidate: request => ++planningReviews === 1 ? { dialogue: envelope(request, manualArtifact ? 'decide' : 'ask', {
      content: 'Which compatibility policy should the remaining plan use?',
      issues: [manualArtifact ? { id: 'P1', title: 'Remaining policy', blocking: true, status: 'disputed' }
        : { id: 'P1', title: 'Remaining policy', kind: 'product', needsHuman: true, blocking: true, status: 'awaiting-answer' }],
    }), usage: { inputTokens: 1, outputTokens: 1 } } : { ...planningApproval(request),
      dialogue: { ...planningApproval(request).dialogue, issues: [{ id: 'P1', title: 'Remaining policy', status: 'resolved',
        disposition: { kind: 'accepted', reason: 'The current captured compatibility requirement supports the remaining policy', claimIds: ['briefing-requirement'] } }] },
      usage: { inputTokens: 1, outputTokens: 1 } },
  });
  const pending = await run(withVerifiedSuperpowers({ target, task: 'Preserve compatibility', gate: [],
    mode: manualArtifact ? 'manual' : 'autonomous', scratchRoot: join(base, 'scratch'), artifactRoot: join(base, 'artifacts'),
    runId: 'retained-public', pivotCandidates: 1, adapters }));
  assert.equal(pending.outcome, 'needs-decision', pending.reason);
  assert.equal(pending.checkpointState.phase, 'planning');
  assert.ok(existsSync(join(pending.dir, 'uro-checkpoint.json')), 'retained planning checkpoint must be durable');
  const saved = readCheckpoint(pending.dir), decisionFile = join(base, 'answers.json');
  assert.equal(writes, 1); assert.equal(drafts, 1);
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: [{ id: saved.pending.questions[0].id, answer: manualArtifact ? 'approve: preserve compatibility' : 'Preserve old input compatibility' }] }));
  const result = await resumeRun({ runDirectory: pending.dir, decisionFile, adapters });
  assert.equal(result.approved, true, result.reason);
  assert.equal(writes, 2); assert.equal(drafts, 1); assert.equal(planningReviews, manualArtifact ? 1 : 2);
  assert.equal(result.resources.providerLaunches, manualArtifact ? 6 : 7);
  assert.equal(result.dir, pending.dir);
  assert.equal(result.artifacts.directory, pending.artifacts.directory, 'retained child phase must refresh the root archive');
  const archived = readCheckpoint(result.artifacts.directory);
  assert.equal(archived.receipts.at(-1).status, 'applied');
  assert.equal(readFileSync(join(result.dir, 'source.js'), 'utf8'), 'completed\n');
});

for (const interruption of ['log', 'return']) test(`native queue public ${interruption === 'log' ? 'answer' : 'technical continuation'} preserves edits landing and exact debits after ${interruption} loss`, async () => {
  const base = mkdtempSync(join(process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(), 'uro-native-queue-'));
  const target = join(base, 'target'); mkdirSync(target); writeFileSync(join(target, 'source.js'), 'before\n');
  const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@local');
  git('add', '.'); git('commit', '-m', 'baseline');
  writeFileSync(join(base, 'plan.md'), 'Preserve compatibility'); writeFileSync(join(base, 'gate.json'), '[]');
  const file = join(base, 'queue.json');
  writeFileSync(file, JSON.stringify([{ name: 'first', task: 'plan.md', gate: 'gate.json', tokenBudget: 30 },
    { name: 'second', task: 'plan.md', gate: 'gate.json', tokenBudget: 30 }]));
  let writes = 0, launches = 0, judgements = 0, landings = 0, faulted = false, pending;
  const review = request => {
    const result = executionApproval(request);
    if (request.state.issues.H1) result.dialogue.issues = [{ id: 'H1', title: 'Policy', status: 'resolved',
      disposition: { kind: 'accepted', reason: 'Current requirement supports the human policy', claimIds: ['briefing-requirement'] } }];
    return result;
  };
  const writer = request => { writes++; writeFileSync(join(request.cwd, 'source.js'), `value-${writes}\n`);
    return { dialogue: envelope(request, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } }; };
  const dependencies = { assertCleanTarget,
    launchRun: async controls => { launches++;
      pending = await run(withVerifiedSuperpowers({ target, task: 'Preserve compatibility', gate: [], mode: 'autonomous',
        contextRef: controls.contextRef, tokenBudget: controls.tokenBudget, debateRounds: controls.rounds,
        runId: `native-queue-${launches}`, scratchRoot: join(base, 'scratch'), artifactRoot: join(base, 'artifacts'),
        adapters: { runExecutor: writer, runReview: launches !== 2 ? review : interruption === 'return' ? null
          : request => ({ dialogue: envelope(request, 'ask', { issues: [{ id: 'H1', title: 'Policy', kind: 'product', needsHuman: true,
            status: 'awaiting-answer', blocking: true }] }), usage: { inputTokens: 1, outputTokens: 1 } }) } }));
      return { runDirectory: pending.dir };
    }, readRunFacts: async () => pending,
    judgeLanding: async () => { judgements++; return { approved: true, usage: { inputTokens: 1, outputTokens: 1 } }; },
    landDiff: async request => { landings++; const result = await landQueueDiff(request);
      if (request.runId === 'native-queue-2' && interruption === 'return' && !faulted) { faulted = true; throw new Error('lost native landing return'); }
      return result;
    }, appendLog: (path, row) => {
      if (row.runId === 'native-queue-2' && row.landed && interruption === 'log' && !faulted) { faulted = true; throw new Error('lost native landing log'); }
      appendFileSync(path, JSON.stringify(row) + '\n');
    } };
  await runQueue({ file, target, tokenBudget: 100, rounds: 7, dependencies });
  const saved = readCheckpoint(pending.dir);
  assert.equal(saved.queue?.unitIndex, 2, 'both human and technical pauses retain their queue');
  const decisionFile = join(base, 'answer.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: saved.pending.questions.map(q => ({ id: q.id, answer: 'Preserve compatibility' })) }));
  const resume = () => resumeRun({ runDirectory: pending.dir, ...(interruption === 'log' ? { decisionFile } : { technicalContinue: true }),
    adapters: { runExecutor: () => assert.fail('completed edit replay'), runReview: review }, queueDependencies: dependencies });
  if (interruption === 'log') await assert.rejects(resume(), /lost native landing log/);
  const done = await resume();
  assert.equal(done.approved, true, done.reason);
  assert.equal(done.queueResult.landedCount, 2, done.queueResult.stop?.reason);
  assert.equal(done.queueResult.totalTokens.total, interruption === 'log' ? 14 : 12);
  assert.equal(done.queueResult.resources.providerLaunches, interruption === 'log' ? 7 : 6);
  assert.equal(writes, 2); assert.equal(launches, 2); assert.equal(judgements, 2); assert.equal(landings, 2); assert.equal(faulted, true);
  assert.equal(git('rev-list', '--count', 'HEAD'), '3');
  const rows = readFileSync(join(base, 'queue-log.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(row => row.landed);
  assert.equal(rows.length, 2); assert.notEqual(rows[0].operationId, rows[1].operationId);
  assert.deepEqual((await resume()).queueResult.resources, done.queueResult.resources);
});

test('native preparation continuation selects saved alternatives without replaying drafts or completed edits', async () => {
  const base = mkdtempSync(join(process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(), 'uro-preparation-resume-'));
  const target = join(base, 'target'); mkdirSync(target); writeFileSync(join(target, 'source.js'), 'before\n');
  let writes = 0, reviews = 0, drafts = 0, selections = 0;
  const adapters = scriptedFreshPlanningAdapters({
    runExecutor: request => { writeFileSync(join(request.cwd, 'source.js'), ++writes === 1 ? 'retained\n' : 'complete\n');
      return { dialogue: envelope(request, request.action), usage: { inputTokens: 1, outputTokens: 1 } }; },
    runReview: request => ++reviews === 1 ? { dialogue: envelope(request, 'replan', {
      issues: [{ id: 'R1', title: 'Remaining strategy', status: 'open', blocking: true }],
      replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'Remaining strategy needs alternatives' } }),
      usage: { inputTokens: 1, outputTokens: 1 } } : executionApproval(request),
    draftPlanCandidate: request => { drafts++; return { plan: `Remaining strategy ${request.candidateId}`, gate: [],
      usage: { inputTokens: 1, outputTokens: 1 } }; },
    reviewPlanCandidate: request => ({ ...planningApproval(request), usage: { inputTokens: 1, outputTokens: 1 } }),
  });
  const pending = await run(withVerifiedSuperpowers({ target, task: 'Preserve compatibility', gate: [], mode: 'autonomous',
    runId: 'preparation-public', pivotCandidates: 3, tokenBudget: 100,
    scratchRoot: join(base, 'scratch'), artifactRoot: join(base, 'artifacts'), adapters }));
  assert.equal(writes, 1); assert.equal(drafts, 3);
  assert.ok(existsSync(join(pending.dir, 'uro-checkpoint.json')), pending.reason);
  const saved = readCheckpoint(pending.dir);
  assert.equal(saved.continuation.dialogue, undefined, 'preparation is not a fabricated selected dialogue');
  assert.equal(saved.continuation.candidateState.selectedCandidateId, null);
  const result = await invokeResumeWithContinue(pending.dir, { ...adapters,
    draftPlanCandidate: () => assert.fail('saved draft replay'),
    selectPlanCandidate: request => { selections++; return { selectedCandidateId: 'candidate-2',
      dialogue: envelope(request, 'verify'), usage: { inputTokens: 1, outputTokens: 1 } }; },
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(writes, 2); assert.equal(drafts, 3); assert.equal(selections, 1);
  assert.equal(result.resources.providerLaunches, 9);
  assert.equal(result.resources.knownUsage.inputTokens, 9);
  assert.equal(result.dir, pending.dir);
});

test('native disputed replan answer is reassessed before any old replan or implementation is replayed', async () => {
  const base = mkdtempSync(join(process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(), 'uro-replan-answer-'));
  const target = join(base, 'target'); mkdirSync(target); writeFileSync(join(target, 'source.js'), 'before\n');
  const pending = await run(withVerifiedSuperpowers({ target, task: 'Preserve compatibility', gate: [], mode: 'manual',
    runId: 'disputed-replan', scratchRoot: join(base, 'scratch'), artifactRoot: join(base, 'artifacts'), adapters: {
      runExecutor: request => { writeFileSync(join(request.cwd, 'source.js'), 'retained\n'); return {
        dialogue: envelope(request, request.action), usage: { inputTokens: 1, outputTokens: 1 } }; },
      runReview: request => ({ dialogue: envelope(request, 'replan', {
        issues: [{ id: 'R1', title: 'Remaining scope disputed', status: 'disputed', blocking: true }],
        replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'Scope needs user clarification' },
      }), usage: { inputTokens: 1, outputTokens: 1 } }),
  } }));
  const saved = readCheckpoint(pending.dir), decisionFile = join(base, 'answer.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: [{ id: saved.pending.questions[0].id, answer: 'approve: preserve current compatibility' }] }));
  let reviews = 0;
  const result = await resumeRun({ runDirectory: pending.dir, decisionFile, adapters: {
    runExecutor: () => assert.fail('old implementation replayed'), draftPlanCandidate: () => assert.fail('old replan followed'),
    runReview: request => {
      reviews++; assert.equal(request.state.terminalAction, null); assert.equal(request.state.approval, null);
      assert.equal(request.state.snapshot.parentDigest, saved.continuation.dialogue.snapshot.digest);
      const response = executionApproval(request);
      response.dialogue.issues = [{ id: 'R1', title: 'Remaining scope disputed', status: 'resolved',
        disposition: { kind: 'accepted', reason: 'Current captured requirement and human direction agree', claimIds: ['briefing-requirement'] } }];
      return response;
    },
  } });
  assert.equal(reviews, 1); assert.equal(result.approved, true, result.reason);
  assert.equal(result.dialogue.issues.R1.disposition.by, 'claude');
  assert.equal(readFileSync(join(result.dir, 'source.js'), 'utf8'), 'retained\n');
});

test('native conflicting-intent merge requires an answer and reviewer before any conclude clear or advance', async () => {
  const base = mkdtempSync(join(process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(), 'uro-merge-answer-'));
  const target = join(base, 'target'); mkdirSync(target);
  const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
  const commit = message => { git('add', '-A'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  writeFileSync(join(target, 'shared.txt'), 'base\n'); const initial = commit('base'), parents = [];
  for (const name of ['left', 'right']) {
    git('checkout', '-b', name, initial); writeFileSync(join(target, 'shared.txt'), `${name}\n`);
    parents.push({ unitId: name, branch: name, commit: commit(name) });
  }
  git('checkout', 'main');
  const merge = await deriveMergeContext({ repository: target, parents });
  let writes = 0, reviews = 0;
  const pending = await run(withVerifiedSuperpowers({ target, task: 'Integrate parent intent', gate: [], mode: 'autonomous',
    runId: 'merge-answer', baseRef: parents[0].commit, unitKind: 'merge', merge,
    scratchRoot: join(base, 'scratch'), artifactRoot: join(base, 'artifacts'), adapters: {
      runExecutor: request => {
        writes++; writeFileSync(join(request.cwd, 'retained.txt'), 'useful work');
        writeFileSync(join(request.cwd, MERGE_LEDGER_FILENAME), JSON.stringify({ status: 'conflicting-intent',
          resolutions: [{ path: 'shared.txt', chosen: 'Unresolved for human', reason: 'Parent intents conflict' }] }));
        return { dialogue: envelope(request, request.action), usage: { inputTokens: 1, outputTokens: 1 } };
      }, runReview: () => assert.fail('review before human answer'),
    } }));
  const saved = readCheckpoint(pending.dir), decisionFile = join(base, 'answer.json');
  assert.equal(saved.pending.questions.length, 1, 'structured merge conflict is a human question');
  await assert.rejects(() => invokeResumeWithContinue(pending.dir), /human|decision/);
  const ledger = readFileSync(join(pending.dir, MERGE_LEDGER_FILENAME), 'utf8');
  const head = execFileSync('git', ['-C', pending.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: [{ id: saved.pending.questions[0].id, answer: 'Use the compatible left behavior; review before changing merge state' }] }));
  writeFileSync(join(pending.dir, MERGE_LEDGER_FILENAME), JSON.stringify({ status: 'resolved', resolutions: [] }));
  await assert.rejects(() => resumeRun({ runDirectory: pending.dir, decisionFile, adapters: {
    runExecutor: () => assert.fail('writer on substituted ledger'), runReview: () => assert.fail('review on substituted ledger'),
  } }), /merge.*(identity|ledger|changed)/);
  assert.equal(readCheckpoint(pending.dir).receipts.length, 0);
  writeFileSync(join(pending.dir, MERGE_LEDGER_FILENAME), ledger);
  const result = await resumeRun({ runDirectory: pending.dir, decisionFile, adapters: {
    runExecutor: () => assert.fail('merge writer before reassessment'),
    runReview: request => {
      reviews++; assert.equal(readFileSync(join(request.cwd, MERGE_LEDGER_FILENAME), 'utf8'), ledger);
      assert.equal(execFileSync('git', ['-C', request.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
      assert.equal(request.state.mergeProgress.nextParentIndex, 1);
      assert.equal(request.state.approval, null);
      return { dialogue: envelope(request, 'stop', { content: 'Retain conflict for explicit follow-up' }), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } });
  assert.equal(writes, 1); assert.equal(reviews, 1); assert.equal(result.approved, false);
  assert.equal(readFileSync(join(result.dir, MERGE_LEDGER_FILENAME), 'utf8'), ledger);
});

for (const mode of ['manual', 'autonomous']) test(`native ${mode} human pause saves retained code and blocks technical continuation`, async () => {
  const f = await humanFixture(mode);
  assert.equal(f.result.outcome, 'needs-decision', f.result.reason);
  assert.ok(existsSync(join(f.result.dir, 'uro-checkpoint.json')), 'native human checkpoint must be durable');
  const saved = readCheckpoint(f.result.dir);
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.interactionMode, mode);
  assert.equal(saved.continuation.dialogue.interactionMode, mode);
  assert.equal(saved.continuation.options.debateRounds, 7);
  assert.equal(saved.continuation.options.tokenBudget, 100);
  assert.equal(saved.pending.questions[0].id, `${saved.continuation.dialogue.pendingDecision.messageId}:decision`);
  await assert.rejects(() => invokeResumeWithContinue(f.result.dir, f.adapters), /human|decision/i);
  assert.equal(readFileSync(f.counter, 'utf8'), '1');
  assert.equal(readFileSync(join(f.result.dir, 'source.js'), 'utf8'), 'retained partial implementation\n');
});

for (const kind of ['product', 'permission']) test(`native ${kind} answer is current reviewer input even when its text says approve`, async () => {
  const f = await humanFixture('autonomous', kind);
  const saved = readCheckpoint(f.result.dir), before = saved.continuation.dialogue;
  const decisionFile = join(f.base, 'answers.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: saved.runId,
    artifactDigest: saved.artifactDigest, interactionMode: 'manual', tokenBudget: 999,
    answers: [{ id: saved.pending.questions[0].id, answer: 'approve' }] }));
  let reviews = 0;
  const result = await resumeRun({ runDirectory: f.result.dir, decisionFile, adapters: {
    runExecutor: () => assert.fail('completed writer replayed'),
    runReview: request => {
      reviews++;
      assert.equal(request.state.interactionMode, 'autonomous');
      assert.equal(request.state.artifactDigest, before.artifactDigest);
      assert.equal(request.state.snapshot.parentDigest, before.snapshot.digest);
      assert.deepEqual(request.state.scope, before.scope);
      assert.deepEqual(request.state.limits, before.limits);
      assert.equal(request.state.approval, null);
      assert.equal(request.state.pendingDecision, null);
      assert.equal(request.state.issues.H1.status, 'awaiting-answer');
      assert.match(request.input, /approve/);
      return { dialogue: envelope(request, 'stop', { content: 'User direction needs no further implementation' }),
        usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } });
  assert.equal(reviews, 1);
  assert.equal(result.approved, false);
  assert.equal(readFileSync(f.counter, 'utf8'), '1');
  await resumeRun({ runDirectory: f.result.dir, decisionFile, adapters: {
    runExecutor: () => assert.fail('replayed writer'), runReview: () => assert.fail('replayed reviewer') } });
});
