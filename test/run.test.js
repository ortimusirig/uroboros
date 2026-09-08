import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseArgs } from '../src/args.js';
import {
  DEFAULT_EXECUTOR_EFFORT,
  DEFAULT_EXECUTOR_MODEL,
} from '../src/executor.js';
import {
  HARNESS_ARTIFACTS,
  run as executeRun,
  diffText,
  resolveDebateRounds,
} from '../src/run.js';
import { VERIFIED_SUPERPOWERS, withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { DEFAULT_ARBITER_MODEL } from '../src/arbiter.js';
import {
  DEFAULT_VERIFIER_MODEL,
} from '../src/verifier.js';
import { spawnCapture } from '../src/spawn.js';
import { exitCodeFor } from '../src/exit.js';
import { reviewDigest, materializeReviewBundle } from '../src/review.js';
import { captureEvidence, createInspectionReceipt } from '../src/context-evidence.js';
import { planningEnvelope, planningApproval } from './fixtures/planning-responses.js';
import { execFileSync, spawn } from 'node:child_process';
import { deriveMergeContext, MERGE_LEDGER_FILENAME } from '../src/merge.js';
import { landQueueDiff } from '../src/queue-runtime.js';
import { isolate } from '../src/isolation.js';

import { runNestedGate } from './fixtures/nested-gate.js';
const run = (options) => executeRun(withVerifiedSuperpowers({ ...options, adapters: { runGate: runNestedGate, ...options.adapters } }));

function executionEnvelope(request, action, extra = {}) {
  return { schemaVersion: 1, action, artifactDigest: request.state.artifactDigest,
    contextDigest: request.state.snapshot.digest, replyTo: null, content: 'Current execution dialogue',
    claims: [], issues: [], evidence: [], verifications: [], next: null, ...extra };
}

function nativeApproval(r, extra = {}) {
  const item = r.state.evidence.find(e => e.id === 'requirement-briefing');
  readFileSync(item.capturedPath);
  const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [item], inspected: true, result: 'read' });
  return { usage: { inputTokens: 3, outputTokens: 2 }, observations: { evidence: [], receipts: [receipt] },
    dialogue: executionEnvelope(r, 'approve', { claims: [{ id: 'briefing-requirement', kind: 'fact', text: 'The saved briefing is present.', evidenceIds: [item.id] }],
      verifications: [{ claimId: 'briefing-requirement', evidenceIds: [item.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read saved briefing' }], ...extra }) };
}

function nativeFixture(t, name, adapters = {}, gate = []) {
  const scr = scratch(), target = makeTarget();
  t.after(() => { rmSync(scr, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); });
  return { task: 'Write completed work', target, gate, scratchRoot: scr, artifactRoot: join(scr, 'artifacts'), runId: name, mode: 'autonomous',
    adapters: { runExecutor: r => { writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { exitCode: 0, changedFiles: ['completed.txt'], usage: { inputTokens: 5, outputTokens: 1 }, dialogue: executionEnvelope(r, r.action) }; },
      runReview: nativeApproval, ...adapters } };
}

function mutationFixture(t, name) {
  const options = nativeFixture(t, name);
  execFileSync('git', ['init', '-q', options.target]);
  execFileSync('git', ['-C', options.target, 'config', 'core.autocrlf', 'false']);
  writeFileSync(join(options.target, 'work.js'), 'module.exports = function work() {\n  return 1;\n};\n');
  writeFileSync(join(options.target, 'work.test.cjs'), "require('./work.js'); console.log('mutation test observed');\n");
  execFileSync('git', ['-C', options.target, 'add', '.']);
  execFileSync('git', ['-C', options.target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'mutation fixture']);
  options.mutation = { concurrency: 1, budget: 1, tests: { command: { bin: process.execPath, args: ['work.test.cjs'] } } };
  options.adapters.runExecutor = r => {
    writeFileSync(join(r.cwd, 'work.js'), 'module.exports = function work() {\n  return 2;\n};\n');
    return { exitCode: 0, usage: { inputTokens: 5, outputTokens: 1 }, dialogue: executionEnvelope(r, r.action) };
  };
  options.adapters.runMutationSeat = (bin, args, opts) => spawnCapture(process.execPath, ['-e',
    `process.stdin.resume(); process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({verdict:'gap',reasoning:'Surviving deletion deserves review'})}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));});`], opts);
  return options;
}

test('native mutation records disposable source evidence and both Codex calls before current approval', async t => {
  const options = mutationFixture(t, 'native-mutation-complete'); let reviews = 0;
  options.adapters.runReview = r => {
    reviews++;
    const command = r.state.evidence.find(e => e.mutation?.purpose === 'mutation-trial-test');
    assert.ok(command, 'trial command evidence reaches the actual reviewer');
    assert.equal(existsSync(command.cwd), false, 'owned trial was removed before review');
    assert.match(JSON.stringify(command.mutation.sourcesBefore), /uro mutation deleted/);
    return nativeApproval(r);
  };
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(reviews, 1);
  assert.equal(facts.mutation.survivors.length, 1);
  assert.equal(facts.resources.providerLaunches, 4);
  assert.equal(facts.resources.knownUsage.inputTokens, 12);
  assert.equal(facts.resources.knownUsage.outputTokens, 5);
  assert.equal(facts.tokens.total.inputTokens, 12);
  assert.equal(facts.tokens.total.outputTokens, 5);
  const events = readFileSync(join(facts.dir, '__uro_dialogue', 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const aux = events.filter(e => e.type === 'prepare' && e.purpose?.startsWith('mutation-') && e.effect === 'provider');
  assert.deepEqual(aux.map(e => [e.seat, e.purpose]), [['codex', 'mutation-grouping'], ['codex', 'mutation-survivor']]);
  assert.ok(events.some(e => e.type === 'prepare' && e.purpose === 'mutation-deletion'));
  assert.match(readFileSync(join(facts.dir, 'work.js'), 'utf8'), /return 2/);
});

test('native mutation denied budget stops before a nested provider and retains analysis intent', async t => {
  const options = mutationFixture(t, 'native-mutation-budget'); let launches = 0, reviews = 0;
  options.tokenBudget = 6;
  options.adapters.runMutationSeat = () => { launches++; throw new Error('unbudgeted mutation launch'); };
  options.adapters.runReview = () => { reviews++; throw new Error('unapproved mutation review'); };
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /budget-exhausted/);
  assert.equal(launches, 0); assert.equal(reviews, 0);
  assert.equal(facts.resources.providerLaunches, 1);
  assert.equal(facts.checkpointState.mutation.analysis.status, 'uncertain');
  assert.equal(facts.checkpointState.mutation.denials.length, 1);
});

test('native mutation refuses opaque option and outer adapters before mutation operations', async t => {
  for (const key of ['runMutation', 'plan', 'effects', 'judge', 'adapters']) {
    const options = mutationFixture(t, `native-mutation-opaque-${key}`); let launches = 0;
    options.adapters.runMutationSeat = () => { launches++; throw new Error('unexpected launch'); };
    if (key === 'runMutation') options.adapters.runMutation = () => { launches++; return {}; };
    else options.mutation[key] = {};
    const facts = await run(options);
    assert.equal(facts.approved, false);
    assert.match(facts.reason, /native mutation/);
    assert.equal(launches, 0);
    assert.equal(facts.checkpointState.mutation.operations.length, 0);
  }
});

test('native mutation missing option invokes no auxiliary provider or mutation command', async t => {
  const options = mutationFixture(t, 'native-mutation-absent'); delete options.mutation;
  options.adapters.runMutationSeat = options.adapters.runMutationCommand = () => { throw new Error('unexpected optional work'); };
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(facts.resources.providerLaunches, 2);
  assert.equal(facts.mutation, undefined);
  assert.deepEqual(facts.checkpointState.mutation.operations, []);
});

test('native mutation required baseline sink failure stops later trials and retains actual command output', async t => {
  const options = mutationFixture(t, 'native-mutation-sink'); let providers = 0;
  options.adapters.runMutationSeat = () => { providers++; throw new Error('launch after required sink failure'); };
  options.adapters.captureEvidence = request => {
    if (request.evidence.mutation?.purpose === 'mutation-baseline') throw new Error('required baseline sink lost');
    return captureEvidence(request);
  };
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /required baseline sink lost/);
  assert.equal(providers, 0);
  const mutation = facts.checkpointState.mutation;
  assert.equal(mutation.operations.some(e => e.purpose === 'mutation-workspace-allocation'), false);
  assert.match(mutation.analysis.error.observation.result.evidence.stdout, /mutation test observed/);
  assert.equal(mutation.analysis.error.observation.recording, 'unrecorded');
});

test('native mutation changed outer source cannot durably approve prior required checks', async t => {
  const options = mutationFixture(t, 'native-mutation-source-change'); let reviews = 0;
  options.adapters.runMutationCommand = async (bin, args, opts) => {
    const result = await spawnCapture(bin, args, opts);
    if (bin === process.execPath && opts.cwd.includes('native-mutation-source-change'))
      writeFileSync(join(opts.cwd, 'work.js'), 'module.exports = function work() {\n  return 3;\n};\n');
    return result;
  };
  options.adapters.runReview = r => { reviews++; return nativeApproval(r); };
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.equal(reviews, 0, 'changed check inputs require reconciliation before current approval');
  const events = readFileSync(join(facts.dir, '__uro_dialogue', 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.some(e => e.type === 'state' && e.state.approval), false);
  assert.match(readFileSync(join(facts.dir, 'work.js'), 'utf8'), /return 3/);
});

test('native mutation unknown grouping usage denies the next survivor provider without losing cleanup', async t => {
  const options = mutationFixture(t, 'native-mutation-unknown'); let launches = 0;
  options.tokenBudget = 100;
  options.adapters.runMutationSeat = (bin, args, opts) => {
    launches++;
    return spawnCapture(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{}'}})));"] , opts);
  };
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /accounting-incomplete/);
  assert.equal(launches, 1);
  assert.equal(facts.resources.providerLaunches, 2);
  assert.equal(facts.resources.usageUnknown, true);
  const mutation = facts.checkpointState.mutation;
  const cleanup = mutation.operations.find(e => e.purpose === 'mutation-parent-cleanup');
  assert.equal(cleanup.status, 'completed');
  assert.equal(existsSync(cleanup.result.parent), false);
});

test('native mutation concurrent trial sink failure retains every cleanup and forbids further paid work', async t => {
  const options = mutationFixture(t, 'native-mutation-concurrent');
  let failed = false, laterCommands = 0;
  options.mutation.budget = 2; options.mutation.concurrency = 2;
  options.adapters.runExecutor = r => {
    writeFileSync(join(r.cwd, 'work.js'), 'module.exports = function first() {\n  return 2;\n};\nfunction second() {\n  return 3;\n}\n');
    return { exitCode: 0, usage: { inputTokens: 5, outputTokens: 1 }, dialogue: executionEnvelope(r, r.action) };
  };
  options.adapters.captureEvidence = request => {
    if (request.evidence.mutation?.purpose === 'mutation-trial-test') { failed = true; throw new Error('concurrent trial sink lost'); }
    return captureEvidence(request);
  };
  options.adapters.runMutationCommand = (bin, args, opts) => {
    if (failed && !(bin === 'git' && args.includes('worktree') && args.includes('remove'))) laterCommands++;
    return spawnCapture(bin, args, opts);
  };
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /concurrent trial sink lost/);
  const mutation = facts.checkpointState.mutation;
  assert.equal(mutation.analysis.error.trials.length, 2);
  const allocated = mutation.operations.filter(e => e.purpose === 'mutation-workspace-allocation');
  assert.equal(allocated.length, 2);
  for (const operation of allocated) assert.equal(existsSync(operation.result.parent), false);
  assert.equal(mutation.operations.filter(e => e.purpose === 'mutation-parent-cleanup' && e.status === 'completed').length, 2);
  assert.equal(mutation.operations.some(e => e.purpose === 'mutation-survivor'), false);
  assert.equal(facts.resources.providerLaunches, 2);
  assert.equal(laterCommands, 0);
});

for (const scenario of ['none', 'both', 'helper', 'command-missing', 'entry-missing']) test(scenario.endsWith('-missing')
  ? `native mutation unresolved reviewer support refuses the actual trial command (${scenario})`
  : `native mutation explicit reviewer helper changes invalidate analysis before current review (${scenario} ignored)`, async t => {
  const missingAtCommand = scenario.endsWith('-missing'), ignored = missingAtCommand ? 'none' : scenario;
  const options = mutationFixture(t, `native-mutation-explicit-support-${ignored}`);
  const entry = '__uro_review/explicit.test.cjs', helper = '__uro_review/helper.cjs';
  const execute = options.adapters.runExecutor;
  let outer, reviews = 0, changed = false;
  mkdirSync(join(options.target, '__uro_review'), { recursive: true });
  writeFileSync(join(options.target, entry), "require('../work.js'); require('./helper.cjs');");
  if (ignored === 'none') writeFileSync(join(options.target, helper), "module.exports='before';");
  else writeFileSync(join(options.target, '.gitignore'), `${ignored === 'both' ? `${entry}\n` : ''}${helper}\n`);
  if (ignored !== 'both') execFileSync('git', ['-C', options.target, 'add', '-f', entry]);
  if (ignored === 'none') execFileSync('git', ['-C', options.target, 'add', '-f', helper]);
  else execFileSync('git', ['-C', options.target, 'add', '.gitignore']);
  execFileSync('git', ['-C', options.target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'selected reviewer support']);
  options.mutation.tests = { files: [entry], command: { bin: process.execPath, args: [entry] } };
  if (ignored !== 'none') options.adapters.isolate = async request => {
    const workspace = await isolate(request);
    mkdirSync(join(workspace.dir, '__uro_review'), { recursive: true });
    if (ignored === 'both') writeFileSync(join(workspace.dir, entry), "require('../work.js'); require('./helper.cjs');");
    writeFileSync(join(workspace.dir, helper), "module.exports='before';");
    assert.equal(execFileSync('git', ['-C', workspace.dir, 'ls-files', '--', helper], { encoding: 'utf8' }), '');
    assert.equal(execFileSync('git', ['-C', workspace.dir, 'check-ignore', helper], { encoding: 'utf8' }).trim(), helper);
    if (ignored === 'both') assert.equal(execFileSync('git', ['-C', workspace.dir, 'check-ignore', entry], { encoding: 'utf8' }).trim(), entry);
    return workspace;
  };
  options.adapters.runExecutor = r => {
    outer = r.cwd;
    return execute(r);
  };
  options.adapters.runReview = r => { reviews++; return nativeApproval(r); };
  if (missingAtCommand) options.adapters.captureEvidence = request => {
    const record = captureEvidence(request);
    if (request.evidence.mutation?.purpose === 'mutation-deletion') rmSync(join(request.root, scenario === 'entry-missing' ? entry : helper));
    return record;
  };
  options.adapters.runMutationCommand = async (bin, args, opts) => {
    const result = await spawnCapture(bin, args, opts);
    if (bin === process.execPath && args.includes(entry) && opts.cwd !== outer) {
      writeFileSync(join(outer, helper), "module.exports='after';");
      changed = true;
    }
    return result;
  };
  const facts = await run(options);
  assert.equal(changed, !missingAtCommand, `actual disposable command launch boundary: ${facts.reason}`);
  const analysis = facts.checkpointState.mutation.analysis;
  assert.deepEqual(analysis.selection.resolvedTestSupport.map(file => file.path), [entry, helper, 'work.test.cjs']);
  assert.equal(analysis.selection.resolvedTestSupport.find(file => file.path === helper).sha256, reviewDigest("module.exports='before';"));
  const overlay = facts.checkpointState.mutation.operations.find(operation => operation.purpose === 'mutation-overlay');
  assert.deepEqual(JSON.parse(overlay.input).resolvedTestSupport, analysis.selection.resolvedTestSupport);
  assert.equal(overlay.result.sourceObservations.before.supportResolution, 'deferred-before-overlay');
  assert.equal(overlay.result.sourceObservations.after.supportResolution, 'resolved');
  if (ignored !== 'none') assert.equal(overlay.result.sourceObservations.before.files.find(file => file.path === helper)?.missing, true);
  assert.equal(facts.approved, false);
  assert.equal(reviews, 0, 'changed support must be reconciled before current review');
  assert.match(facts.reason, missingAtCommand ? /unresolved reviewer test support|ENOENT|source is missing/ : /source|check inputs|reconciliation/);
  if (missingAtCommand) assert.equal(facts.checkpointState.mutation.operations.some(operation => operation.purpose === 'mutation-trial-test'), false);
});

test('native mutation materialized reviewer bundle preserves verified dynamic support and invalidates prior analysis', async t => {
  const options = mutationFixture(t, 'native-mutation-review-support'); let reviews = 0;
  options.gate = [{ bin: process.execPath, args: ['--test'] }];
  options.adapters.runReview = r => {
    reviews++;
    if (reviews === 1) {
      const response = nativeApproval(r);
      const bundle = { version: 1, conclusion: 'clean', report: 'Check the current source with its reviewer support.', tests: [
        { path: 'tests/current.test.cjs', content: "require('../../work.js'); const sibling='./helper.cjs'; require(sibling);" },
        { path: 'tests/helper.cjs', content: "module.exports='verified dynamic support';" },
      ] };
      return { ...response, resultSeen: true, resultUsable: true, materializationDeferred: true,
        answer: `${JSON.stringify(bundle)}\n<UROBOROS_DIALOGUE>${JSON.stringify(response.dialogue)}</UROBOROS_DIALOGUE>` };
    }
    return nativeApproval(r);
  };
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(reviews, 2, 'new required tests require review of the new analysis; no extra clean pass');
  const operations = facts.checkpointState.mutation.operations;
  assert.equal(operations.filter(operation => operation.effect === 'mutation-analysis').length, 2);
  const overlay = operations.filter(operation => operation.purpose === 'mutation-overlay').at(-1);
  const input = JSON.parse(overlay.input);
  assert.deepEqual(input.testSupportFiles.map(file => file.path), ['__uro_review/tests/current.test.cjs', '__uro_review/tests/helper.cjs']);
  const helper = overlay.result.sourceObservations.capturedSources.find(file => file.locator.path.endsWith('/helper.cjs'));
  assert.equal(readFileSync(helper.capturedPath, 'utf8'), "module.exports='verified dynamic support';");
  assert.equal(input.files.some(file => file.path.endsWith('manifest.json') || file.path.endsWith('REVIEW.md')), false);
});

test('native mutation failed owned cleanup retains its real directory registration and command receipt', async t => {
  const options = mutationFixture(t, 'native-mutation-cleanup-failed'); let facts;
  options.adapters.runMutationCommand = (bin, args, opts) => bin === 'git' && args.includes('worktree') && args.includes('remove')
    ? spawnCapture(process.execPath, ['-e', "process.stderr.write('owned cleanup failed'); process.exit(9)"], opts)
    : spawnCapture(bin, args, opts);
  try {
    facts = await run(options);
    assert.equal(facts.approved, false);
    const mutation = facts.checkpointState.mutation;
    const state = mutation.analysis.error.trials[0].state;
    assert.equal(state.cleanup.status, 'failed');
    assert.equal(state.cleanup.registration, 'registered');
    assert.equal(state.cleanup.retained, true);
    assert.equal(existsSync(state.directory), true);
    const cleanup = mutation.operations.find(operation => operation.purpose === 'mutation-cleanup-command');
    assert.equal(cleanup.status, 'completed', 'the failed command result was recorded, not successful removal');
    assert.equal(cleanup.result.code, 9);
    assert.match(cleanup.result.stderr, /owned cleanup failed/);
    assert.equal(mutation.operations.some(operation => operation.purpose === 'mutation-survivor'), false);
  } finally {
    for (const trial of facts?.checkpointState?.mutation?.analysis?.error?.trials ?? []) {
      const state = trial.state;
      if (state?.cleanup?.retained && dirname(state.parent) === realpathSync.native(tmpdir()) && state.parent.includes('uro-mutate-')) {
        execFileSync('git', ['-C', facts.dir, 'worktree', 'remove', '--force', state.directory], { stdio: 'pipe', windowsHide: true });
        rmSync(state.parent, { recursive: true, force: true });
      }
    }
  }
});

async function nativeMergeFixture(t, name, conflict = false) {
  const options = nativeFixture(t, name);
  const git = (...args) => execFileSync('git', ['-C', options.target, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local');
  const commit = message => { git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-m', message); return git('rev-parse', 'HEAD'); };
  writeFileSync(join(options.target, 'shared.txt'), 'base\n');
  const base = commit('base'), parents = [];
  for (const id of ['left', 'middle', 'right']) {
    git('checkout', '-b', id, base);
    writeFileSync(join(options.target, conflict ? 'shared.txt' : `${id}.txt`), `${id}\n`);
    parents.push({ unitId: id, branch: id, commit: commit(id) });
  }
  git('checkout', 'main');
  options.baseRef = parents[0].commit;
  options.unitKind = 'merge';
  options.merge = await deriveMergeContext({ repository: options.target, parents });
  return { options, git };
}

test('native merge clean ordered parents have durable initial intent before Git and current merged approval', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-clean');
  let beforeAdvance;
  options.reporter = event => {
    if (event.stage === 'merge' && event.type === 'start') {
      const cwd = join(options.scratchRoot, options.runId, 'w');
      const events = readFileSync(join(cwd, '__uro_dialogue/journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      beforeAdvance = { intent: events.findLast(e => e.type === 'prepare'),
        head: execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
        middleExists: existsSync(join(cwd, 'middle.txt')) };
    }
  };
  options.adapters.runExecutor = r => {
    const events = readFileSync(join(r.cwd, '__uro_dialogue/journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const intent = events.find(e => e.type === 'prepare' && e.effect === 'merge-sequence');
    assert.ok(intent, 'initial Git sequence must already have a durable intent');
    assert.equal(intent.selection.head, options.merge.parents[0].commit);
    assert.deepEqual(intent.selection.parents, options.merge.parents);
    assert.ok(events.some(e => e.type === 'complete' && e.operationId === intent.operationId));
    for (const id of ['left', 'middle', 'right']) assert.equal(readFileSync(join(r.cwd, `${id}.txt`), 'utf8'), `${id}\n`);
    writeFileSync(join(r.cwd, 'seam.test.js'), '');
    return { dialogue: executionEnvelope(r, r.action), usage: { inputTokens: 5, outputTokens: 1 } };
  };
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(beforeAdvance.intent.effect, 'merge-sequence');
  assert.equal(beforeAdvance.head, options.merge.parents[0].commit);
  assert.equal(beforeAdvance.middleExists, false, 'intent is observable before the first real parent merge');
  assert.equal(facts.dialogue.mergeProgress.complete, true);
  assert.equal(facts.dialogue.mergeProgress.nextParentIndex, 3);
  assert.equal(facts.dialogue.proposalCycles, 1);
  assert.equal(facts.resources.providerLaunches, 2);
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /left|middle|right/);
  assert.equal(facts.approval.artifactDigest, reviewDigest(readFileSync(join(facts.dir, 'CHANGES.diff'))));
  assert.ok(facts.evidence.some(e => e.kind === 'command' && e.argv.some(arg => arg.endsWith('merge-test-count.js'))));
  const landing = await landQueueDiff({ target: options.target, diffPath: join(facts.dir, 'CHANGES.diff'), unit: { name: 'merge' }, runId: facts.runId });
  assert.ok(landing.commit);
  for (const id of ['left', 'middle', 'right']) assert.equal(readFileSync(join(options.target, `${id}.txt`), 'utf8'), `${id}\n`);
});

test('native merge successive conflicts retain first resolution and separately prepare next parent without correction', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-conflicts', true);
  let segments = 0;
  options.debateRounds = 1;
  options.adapters.runExecutor = r => {
    const parent = ++segments === 1 ? 'middle' : 'right';
    assert.equal(r.state.mergeProgress.conflict.parentUnitId, parent);
    assert.match(r.input, new RegExp(`merge of parent ${parent}`));
    if (segments === 2) assert.match(readFileSync(join(r.cwd, 'first-resolution.txt'), 'utf8'), /retained/);
    writeFileSync(join(r.cwd, 'shared.txt'), segments === 1 ? 'left and middle\n' : 'left and middle and right\n');
    writeFileSync(join(r.cwd, 'first-resolution.txt'), 'retained');
    writeFileSync(join(r.cwd, MERGE_LEDGER_FILENAME), JSON.stringify({ status: 'resolved', resolutions: [{ path: 'shared.txt', chosen: parent, reason: 'Preserve all parent behavior' }] }));
    return { dialogue: executionEnvelope(r, r.action), usage: { inputTokens: 5, outputTokens: 1 } };
  };
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(segments, 2);
  assert.equal(facts.dialogue.proposalCycles, 1);
  assert.equal(facts.dialogue.correctionCycles, 0);
  assert.equal(facts.resources.providerLaunches, 3);
  assert.deepEqual(facts.merge.resolutions.map(r => r.parentUnitId), ['middle', 'right']);
  assert.equal(existsSync(join(facts.dir, MERGE_LEDGER_FILENAME)), false);
});

test('native merge malformed missing and conflicting-intent ledgers retain work without another effect or reviewer', async t => {
  for (const kind of ['missing', 'malformed', 'conflicting-intent']) {
    const { options } = await nativeMergeFixture(t, `native-merge-ledger-${kind}`, true);
    let writes = 0, reviews = 0;
    options.adapters.runExecutor = r => {
      writes++;
      writeFileSync(join(r.cwd, 'retained.txt'), 'useful work');
      if (kind !== 'missing') writeFileSync(join(r.cwd, MERGE_LEDGER_FILENAME), kind === 'malformed' ? '{' : JSON.stringify({
        status: 'conflicting-intent', resolutions: [{ path: 'shared.txt', chosen: 'Unresolved for human', reason: 'Parent intents conflict' }] }));
      return { dialogue: executionEnvelope(r, r.action), usage: { inputTokens: 1, outputTokens: 1 } };
    };
    options.adapters.runReview = () => { reviews++; };
    const facts = await run(options);
    assert.equal(facts.approved, false);
    assert.match(facts.reason, kind === 'conflicting-intent' ? /conflicting-intent/ : kind === 'missing' ? /missing.*resolutions/ : /invalid.*resolutions/);
    assert.equal(readFileSync(join(facts.dir, 'retained.txt'), 'utf8'), 'useful work');
    assert.equal(writes, 1); assert.equal(reviews, 0);
    assert.equal(facts.dialogue.mergeProgress.nextParentIndex, 1);
    assert.equal(facts.dialogue.mergeProgress.complete, false);
    assert.equal(facts.evidence.length, 0);
  }
});

test('native merge actual derived test floor failure blocks current approval', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-floor');
  options.merge.testCounts.required = 2;
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /checks.*failed/);
  const floor = facts.evidence.find(e => e.kind === 'command');
  assert.equal(floor.exitCode, 1);
  assert.match(floor.stdout, /actual=0 required=2/);
  assert.equal(facts.dialogue.approval, null);
});

test('native merge uncertain effect finalization observes partial bytes without staging or another provider', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-uncertain');
  let captures = 0, providers = 0, heldIndex, heldHead;
  options.adapters.diffText = async cwd => {
    captures++;
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    heldIndex = git('ls-files', '--stage'); heldHead = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'left.txt'), 'useful partial bytes after merge\n');
    writeFileSync(join(cwd, 'uncaptured.txt'), 'uncertain new work');
    throw new Error('interrupted merge outcome capture');
  };
  options.adapters.runExecutor = () => { providers++; };
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /interrupted merge outcome capture/);
  assert.equal(captures, 1, 'initial capture and post-uncertainty finalization must never call the staging adapter');
  assert.equal(providers, 0);
  const git = (...args) => execFileSync('git', ['-C', facts.dir, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(git('ls-files', '--stage'), heldIndex);
  assert.equal(git('rev-parse', 'HEAD'), heldHead);
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /useful partial bytes after merge/);
  assert.equal(facts.dialogue.pendingOperation.effect, 'merge-sequence');
  assert.equal(facts.checkpointState.mergeState.mergeProgress, null, 'callback-only progress is not a durably completed effect');
  assert.equal(facts.resources.providerLaunches, 0);
  assert.equal(facts.checkpointState.mergeState.observedWorkspace.diffComplete, false);
  assert.deepEqual(facts.checkpointState.mergeState.observedWorkspace.untrackedFiles, [{ path: 'uncaptured.txt', sha256: reviewDigest('uncertain new work') }]);
});

test('native merge retained replan carries completed progress and current remaining plan without repeating parents', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-replan');
  let writes = 0, reviews = 0, advances = 0;
  options.pivotCandidates = 1;
  options.reporter = event => { if (event.stage === 'merge' && event.type === 'start') advances++; };
  options.adapters.runExecutor = r => {
    if (++writes === 2) {
      assert.match(r.input.split('Requested codex action:')[0], /Only add remaining.txt/);
      assert.equal(r.state.mergeProgress.complete, true);
      assert.equal(r.state.priorExecution.mergeProgress.operationId, r.state.mergeProgress.operationId);
    }
    writeFileSync(join(r.cwd, writes === 1 ? 'first.txt' : 'remaining.txt'), 'retained');
    return { dialogue: executionEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } };
  };
  options.adapters.runReview = r => ++reviews === 1 ? { dialogue: executionEnvelope(r, 'replan', {
    issues: [{ id: 'R1', title: 'Remaining seam work', status: 'open', blocking: true }],
    replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The complete parent merge narrows remaining implementation to one additional file.' },
  }), usage: { inputTokens: 1, outputTokens: 1 } } : nativeApproval(r);
  options.adapters.draftPlanCandidate = r => ({ plan: 'Only add remaining.txt', gate: [], dialogue: planningEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } });
  options.adapters.reviewPlanCandidate = planningApproval;
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(advances, 1); assert.equal(writes, 2);
  assert.equal(facts.checkpointState.phaseChain.length, 3);
  assert.equal(facts.dialogue.proposalCycles, 2);
  assert.equal(facts.dialogue.correctionCycles, 0);
});

test('native merge rejects a replaced actual MERGE_HEAD before concluding the saved parent conflict', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-head-mismatch', true);
  let writes = 0;
  options.adapters.runExecutor = r => {
    writes++;
    writeFileSync(join(r.cwd, 'shared.txt'), 'retained resolution');
    writeFileSync(join(r.cwd, MERGE_LEDGER_FILENAME), JSON.stringify({ status: 'resolved', resolutions: [{ path: 'shared.txt', chosen: 'both', reason: 'Retain both' }] }));
    const mergeHeadPath = execFileSync('git', ['-C', r.cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    writeFileSync(mergeHeadPath, `${options.merge.parents[2].commit}\n`);
    return { dialogue: executionEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const facts = await run(options);
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /actual merge parent.*saved conflict/);
  assert.equal(writes, 1);
  assert.equal(execFileSync('git', ['-C', facts.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), options.merge.parents[0].commit);
  assert.equal(existsSync(join(facts.dir, MERGE_LEDGER_FILENAME)), true);
});

test('native merge partial replan composes each later conflict from the current approved remaining plan in one cycle', async t => {
  const { options } = await nativeMergeFixture(t, 'native-merge-partial-replan', true);
  let writes = 0, reviews = 0;
  options.pivotCandidates = 1; options.debateRounds = 1;
  const remainingPlan = 'Preserve partial.txt and complete only the remaining parent conflicts.';
  options.adapters.runExecutor = r => {
    writes++;
    if (writes === 1) {
      writeFileSync(join(r.cwd, 'partial.txt'), 'retained before planning');
      return { dialogue: executionEnvelope(r, 'ask'), usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const parent = writes === 2 ? 'middle' : 'right';
    const taskPreamble = r.input.split('Requested codex action:')[0];
    assert.match(taskPreamble, /Preserve partial.txt and complete only the remaining parent conflicts/);
    assert.match(taskPreamble, new RegExp(`merge of parent ${parent}`));
    assert.equal(r.state.proposalCycles, 1); assert.equal(r.state.correctionCycles, 0);
    assert.equal(readFileSync(join(r.cwd, 'partial.txt'), 'utf8'), 'retained before planning');
    writeFileSync(join(r.cwd, 'shared.txt'), writes === 2 ? 'left and middle' : 'all three parents');
    writeFileSync(join(r.cwd, MERGE_LEDGER_FILENAME), JSON.stringify({ status: 'resolved', resolutions: [{ path: 'shared.txt', chosen: 'composed', reason: 'Preserve all parent behavior' }] }));
    return { dialogue: executionEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } };
  };
  options.adapters.runReview = r => ++reviews === 1 ? { dialogue: executionEnvelope(r, 'replan', {
    issues: [{ id: 'R1', title: 'Clarify remaining merge strategy', status: 'open', blocking: true }],
    replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The retained partial implementation leaves only ordered parent conflict resolution.' },
  }), usage: { inputTokens: 1, outputTokens: 1 } } : nativeApproval(r);
  options.adapters.draftPlanCandidate = r => ({ plan: remainingPlan, gate: [], dialogue: planningEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } });
  options.adapters.reviewPlanCandidate = planningApproval;
  const facts = await run(options);
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(writes, 3); assert.equal(reviews, 2);
  assert.equal(facts.dialogue.proposalCycles, 1); assert.equal(facts.dialogue.correctionCycles, 0);
  assert.equal(facts.dialogue.executionCycle.completedOperationIds.length, 3);
  assert.equal(facts.checkpointState.phaseChain.length, 3);
  assert.equal(facts.checkpointState.approvedExecutionPlan, `${remainingPlan}\n`);
});

test('native ordinary run binds actual writes and required command evidence to current approval and facts', async t => {
  const command = { bin: process.execPath, args: ['-e', "if(require('node:fs').readFileSync('completed.txt','utf8')!=='1')process.exit(4);process.stdout.write('x'.repeat(16000))"] };
  const facts = await run(nativeFixture(t, 'native-complete', { runReview: r => {
    const check = r.state.evidence.find(e => e.kind === 'command');
    assert.equal(check.stdout.length, 16000); assert.equal(check.exitCode, 0);
    assert.deepEqual(check.argv, [process.execPath, ...command.args]);
    assert.equal(check.claimIds.length, 1, 'observed command evidence must be available for factual verification');
    return nativeApproval(r);
  } }, [command]));
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(facts.outcome, 'review-ready');
  assert.equal(facts.approval.artifactDigest, reviewDigest(readFileSync(join(facts.dir, 'CHANGES.diff'))));
  assert.equal(facts.approval.contextDigest, facts.dialogue.snapshot.digest);
  assert.equal(facts.resources.providerLaunches, 2);
  assert.equal(facts.tokens.total.inputTokens, 8);
  assert.equal(facts.dialogue.proposalCycles, 1);
  assert.equal(facts.checkpointState.executionArtifacts.files.some(f => f.path.endsWith('journal-tail.jsonl')), true);
  assert.equal(facts.iterations.length, 1);
});

test('native ordinary partial question resumes only remaining work with no gate at the yield', async t => {
  let writes = 0, reviews = 0;
  const facts = await run(nativeFixture(t, 'native-remaining', {
    runExecutor: r => {
      if (++writes === 1) { writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'ask') }; }
      assert.equal(r.remainingWork, true); assert.equal(readFileSync(join(r.cwd, 'completed.txt'), 'utf8'), '1');
      writeFileSync(join(r.cwd, 'remaining.txt'), 'done'); return { dialogue: executionEnvelope(r, 'propose') };
    }, runReview: r => {
      if (++reviews === 1) { assert.equal(r.state.executionChecks, undefined); return { dialogue: executionEnvelope(r, 'answer', { next: { seat: 'codex', action: 'propose', reason: 'Finish remaining work' } }) }; }
      return nativeApproval(r);
    },
  }));
  assert.equal(facts.approved, true, facts.reason); assert.equal(writes, 2);
  assert.equal(facts.dialogue.proposalCycles, 1); assert.equal(facts.dialogue.correctionCycles, 0);
  assert.equal(readFileSync(join(facts.dir, 'remaining.txt'), 'utf8'), 'done');
});

test('native ordinary failed required checks cannot become approval', async t => {
  const facts = await run(nativeFixture(t, 'native-red-command', {}, [{ bin: process.execPath, args: ['-e', 'process.exit(7)'] }]));
  assert.equal(facts.approved, false); assert.notEqual(facts.outcome, 'review-ready');
  assert.match(facts.reason, /required checks/);
  assert.equal(facts.evidence[0].exitCode, 7);
  const states = readFileSync(join(facts.dir, '__uro_dialogue', 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type === 'state');
  assert.equal(states.at(-1).state.approval, null, 'failed checks must not durably finalize native approval');
});

test('native retained replan continues an open execution cycle without another correction', async t => {
  let writes = 0, reviews = 0, cycle;
  const facts = await run({ ...nativeFixture(t, 'native-replan-open-cycle', {
    runExecutor: r => {
      if (++writes === 1) {
        cycle = r.state.executionCycle.id; writeFileSync(join(r.cwd, 'completed.txt'), '1');
        return { dialogue: executionEnvelope(r, 'ask') };
      }
      assert.equal(r.state.executionCycle.id, cycle); assert.equal(r.state.proposalCycles, 1);
      assert.equal(r.state.correctionCycles, 0); assert.equal(r.remainingWork, true);
      writeFileSync(join(r.cwd, 'remaining.txt'), 'done'); return { dialogue: executionEnvelope(r, 'propose') };
    },
    runReview: r => ++reviews === 1 ? { dialogue: executionEnvelope(r, 'replan', {
      issues: [{ id: 'R1', title: 'Partial execution needs a remaining plan', status: 'open', blocking: true }],
      replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The completed first segment narrows the remaining work to one file.' },
    }) } : nativeApproval(r),
    draftPlanCandidate: r => ({ plan: 'Only finish remaining.txt', gate: [], dialogue: planningEnvelope(r, 'propose') }),
    reviewPlanCandidate: planningApproval,
  }), pivotCandidates: 1, debateRounds: 1 });
  assert.equal(facts.approved, true, facts.reason); assert.equal(writes, 2);
  assert.equal(facts.dialogue.proposalCycles, 1); assert.equal(facts.dialogue.correctionCycles, 0);
  assert.equal(facts.dialogue.executionCycle.completedOperationIds.length, 2);
});

test('native retained replan manual dispute launches no child before human resolution', async t => {
  let planning = 0;
  const facts = await run({ ...nativeFixture(t, 'native-replan-manual-dispute', {
    runReview: r => ({ dialogue: executionEnvelope(r, 'replan', {
      issues: [{ id: 'R1', title: 'Disputed remaining strategy', status: 'disputed', blocking: true }],
      replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The completed segment raises a disputed remaining-work choice.' },
    }) }),
    draftPlanCandidate: () => { planning++; return { unavailable: true }; },
  }), mode: 'manual' });
  assert.equal(facts.approved, false); assert.equal(planning, 0);
  assert.equal(facts.nextAction, 'needs-decision'); assert.equal(facts.phase, 'execution');
  assert.equal(facts.dialogue.pendingDecision.authority, 'human');
  assert.equal(facts.dialogue.terminalAction, 'replan');
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
});

test('native ordinary dialogue permits four challenges and enforces an explicit separate challenge limit', async t => {
  for (const limit of [undefined, 2]) {
    let exchanges = 0, coding = 0;
    const options = nativeFixture(t, `native-exchanges-${limit}`, {
      runExecutor: r => {
        if (r.action === 'challenge') { exchanges++; return { dialogue: executionEnvelope(r, 'challenge', { evidence: ['requirement-briefing'] }) }; }
        coding++; writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'propose') };
      }, runReview: r => exchanges < 4 ? { dialogue: executionEnvelope(r, 'ask', { next: { seat: 'codex', action: 'challenge', reason: 'Discuss evidence' } }) } : nativeApproval(r),
    });
    options.challengeRounds = limit;
    const facts = await run(options);
    assert.equal(coding, 1); assert.equal(exchanges, limit ?? 4);
    assert.equal(facts.approved, limit === undefined, facts.reason);
    assert.equal(facts.dialogue.proposalCycles, 1);
  }
});

test('native ordinary uncertain writer retains bytes without another provider even with restart configured', async t => {
  let calls = 0, reviews = 0;
  const options = nativeFixture(t, 'native-timeout', {
    runExecutor: r => { calls++; writeFileSync(join(r.cwd, 'partial.txt'), 'retained'); return { timedOut: true, exitCode: 1, lastMessage: '' }; },
    runReview: () => { reviews++; },
  });
  options.stallPolicy = 'restart'; options.stallRestartLimit = 3;
  const facts = await run(options);
  assert.equal(facts.approved, false); assert.equal(calls, 1); assert.equal(reviews, 0);
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /retained/);
  assert.equal(facts.resources.providerLaunches, 1);
});

test('native ordinary empty malformed output and absent or legacy reviewer never imply approval', async t => {
  for (const shape of ['empty', 'missing-review', 'legacy-review']) {
    const options = nativeFixture(t, `native-negative-${shape}`);
    if (shape === 'empty') options.adapters.runExecutor = () => ({ exitCode: 0, changedFiles: [], lastMessage: '' });
    if (shape === 'missing-review') delete options.adapters.runReview;
    if (shape === 'legacy-review') options.adapters.runReview = () => ({ conclusion: 'clean', artifact: null });
    const facts = await run(options);
    assert.equal(facts.approved, false); assert.notEqual(facts.outcome, 'no-op');
    assert.notEqual(exitCodeFor(facts), 0);
  }
});

test('native ordinary retained manifest corruption is unapproved before another seat', async t => {
  let reviews = 0;
  const facts = await run(nativeFixture(t, 'native-manifest', {
    judgeLiveness: async () => ({ status: 'working', reasoning: 'Observed current progress', usage: { inputTokens: 4, outputTokens: 2 } }),
    runExecutor: async r => { await r.judgeLiveness({ checkCount: 1 }); writeFileSync(join(r.cwd, 'completed.txt'), '1');
      writeFileSync(join(r.cwd, '__uro_context', `${r.state.snapshot.id}.json`), '{}');
      return { dialogue: executionEnvelope(r, 'propose'), usage: { inputTokens: 7, outputTokens: 3 } }; }, runReview: () => { reviews++; },
  }));
  assert.equal(facts.approved, false); assert.equal(reviews, 0);
  assert.equal(facts.checkpointState.executionArtifacts, undefined);
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
  assert.equal(facts.checkpointState.supervision.observedWorkspace.diffComplete, false);
  assert.ok(facts.checkpointState.supervision.observedWorkspace.untrackedFiles.some(file => file.path === 'completed.txt'));
  assert.equal((await spawnCapture('git', ['-C', facts.dir, 'ls-files', '--', 'completed.txt'])).stdout, '');
  assert.equal(facts.resources.providerLaunches, 2);
  assert.partialDeepStrictEqual(facts.resources.knownUsage, { inputTokens: 11, outputTokens: 5 });
  assert.equal(facts.checkpointState.phaseChain.at(-1).checkpointState.executionArtifacts, undefined);
  assert.ok(facts.requiredSourceFailure);
});

test('native ordinary invalid merge identities stop before initial Git advance and every provider', async t => {
  let calls = 0;
  const { options } = await nativeMergeFixture(t, 'native-merge-pause');
  options.adapters.runExecutor = () => { calls++; };
  options.merge.parents[1].commit = 'does-not-exist';
  const facts = await run(options);
  assert.equal(facts.approved, false); assert.match(facts.reason, /bad revision|unknown revision|Command failed|ambiguous argument/);
  assert.equal(calls, 0); assert.equal(facts.resources.providerLaunches, 0);
});

for (const discussionAction of ['answer', 'rebut', 'challenge']) test(`native Codex ${discussionAction} and protocol repair pin actual child argv to read-only`, async t => {
  const hadSandbox = Object.hasOwn(process.env, 'URO_CODEX_SANDBOX');
  const previousSandbox = process.env.URO_CODEX_SANDBOX;
  process.env.URO_CODEX_SANDBOX = 'danger-full-access';
  try {
    const { runExecutor } = await import(`../src/executor.js?discussion-sandbox=${discussionAction}`);
    const launches = [];
    let reviews = 0;
    const facts = await run(nativeFixture(t, `sandbox-${discussionAction}`, {
      runExecutor: async request => {
        const writing = ['propose', 'revise'].includes(request.action);
        const reply = request.action === discussionAction ? 'malformed discussion reply'
          : `<UROBOROS_DIALOGUE>${JSON.stringify(executionEnvelope(request,
            request.action === 'repair' ? discussionAction : request.action,
            { evidence: ['requirement-briefing'] }))}</UROBOROS_DIALOGUE>`;
        // The hermetic child reports the argv it actually received. Production
        // runExecutor still builds and launches the Codex argument vector.
        const script = [
          "process.stdin.resume();process.stdin.on('end',()=>{",
          writing ? `require('node:fs').writeFileSync('completed.txt',${JSON.stringify(request.action)});` : '',
          "const emit=e=>process.stdout.write(JSON.stringify(e)+'\\n');",
          "emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({argv:process.argv.slice(1)})}});",
          `emit({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(reply)}}});`,
          "emit({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}});});",
        ].join('');
        const response = await runExecutor({ ...request, bin: process.execPath,
          spawnProcess: (_bin, args, options) => spawn(process.execPath, ['-e', script, '--', ...args], options) });
        launches.push({ action: request.action, ...JSON.parse(response.agentMessages[0]) });
        return response;
      },
      runReview: request => ++reviews < 3 ? { dialogue: executionEnvelope(request, 'ask', {
        next: { seat: 'codex', action: reviews === 1 ? discussionAction : 'revise',
          reason: reviews === 1 ? 'Explain the implemented behavior.' : 'Apply the requested correction.' },
      }) } : nativeApproval(request),
    }));
    assert.equal(facts.approved, true, facts.reason);
    assert.deepEqual(launches.map(launch => [launch.action, launch.argv[launch.argv.indexOf('-s') + 1]]), [
      ['propose', 'danger-full-access'], [discussionAction, 'read-only'],
      ['repair', 'read-only'], ['revise', 'danger-full-access'],
    ]);
    assert.ok(launches.every(launch => launch.argv.includes('exec') && launch.argv.includes('--json')));
    assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), 'revise');
    assert.equal(facts.dialogue.proposalCycles, 2);
    assert.equal(facts.dialogue.correctionCycles, 1);
    assert.equal(facts.resources.providerLaunches, 7);
    assert.equal(facts.resources.repairLaunches, 1);
  } finally {
    if (hadSandbox) process.env.URO_CODEX_SANDBOX = previousSandbox;
    else delete process.env.URO_CODEX_SANDBOX;
  }
});

test('native Codex partial-work ask retains its authorized implementation sandbox', async t => {
  const hadSandbox = Object.hasOwn(process.env, 'URO_CODEX_SANDBOX');
  const previousSandbox = process.env.URO_CODEX_SANDBOX;
  process.env.URO_CODEX_SANDBOX = 'workspace-write';
  try {
    const { runExecutor } = await import('../src/executor.js?partial-ask-sandbox');
    const launches = [];
    let reviews = 0;
    const facts = await run(nativeFixture(t, 'sandbox-partial-ask', {
      runExecutor: async request => {
        const first = launches.length === 0;
        const reply = executionEnvelope(request, first ? 'ask' : 'propose', first ? {
          content: 'Partial work is saved; which convention should finish it?', evidence: ['requirement-briefing'],
          next: { seat: 'claude', action: 'answer', reason: 'Clarify the existing convention.' },
        } : {});
        const script = [
          "process.stdin.resume();process.stdin.on('end',()=>{",
          first ? "require('node:fs').writeFileSync('partial.txt','retained');"
            : "require('node:assert/strict').equal(require('node:fs').readFileSync('partial.txt','utf8'),'retained');require('node:fs').writeFileSync('completed.txt','finished');",
          "const emit=e=>process.stdout.write(JSON.stringify(e)+'\\n');",
          "emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({argv:process.argv.slice(1)})}});",
          `emit({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(`<UROBOROS_DIALOGUE>${JSON.stringify(reply)}</UROBOROS_DIALOGUE>`)}}});`,
          "emit({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}});});",
        ].join('');
        const response = await runExecutor({ ...request, bin: process.execPath,
          spawnProcess: (_bin, args, options) => spawn(process.execPath, ['-e', script, '--', ...args], options) });
        launches.push({ action: request.action, remainingWork: request.remainingWork, ...JSON.parse(response.agentMessages[0]) });
        return response;
      },
      runReview: request => ++reviews === 1 ? { dialogue: executionEnvelope(request, 'answer', {
        content: 'Follow the existing convention.', next: { seat: 'codex', action: 'propose', reason: 'Complete only remaining work.' },
      }) } : nativeApproval(request),
    }));
    assert.equal(facts.approved, true, facts.reason);
    assert.deepEqual(launches.map(launch => [launch.action, launch.argv[launch.argv.indexOf('-s') + 1], launch.remainingWork]), [
      ['propose', 'workspace-write', false], ['propose', 'workspace-write', true],
    ]);
    assert.equal(readFileSync(join(facts.dir, 'partial.txt'), 'utf8'), 'retained');
    assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), 'finished');
    assert.equal(facts.dialogue.proposalCycles, 1);
    assert.equal(facts.resources.providerLaunches, 4);
  } finally {
    if (hadSandbox) process.env.URO_CODEX_SANDBOX = previousSandbox;
    else delete process.env.URO_CODEX_SANDBOX;
  }
});

test('native ordinary reviewer mistake is rebutted and disposed without another edit', async t => {
  let coding = 0, reviews = 0;
  const facts = await run(nativeFixture(t, 'native-rebuttal', {
    runExecutor: r => {
      if (r.action === 'rebut') return { dialogue: executionEnvelope(r, 'rebut', { evidence: ['requirement-briefing'], content: 'The requirement already specifies this behavior.' }) };
      coding++; writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'propose') };
    }, runReview: r => ++reviews === 1 ? { dialogue: executionEnvelope(r, 'ask', {
      issues: [{ id: 'I1', title: 'Possible requirement mismatch', status: 'awaiting-answer', blocking: true }],
      next: { seat: 'codex', action: 'rebut', reason: 'Explain the requirement' },
    }) } : nativeApproval(r, { issues: [{ id: 'I1', status: 'resolved', disposition: { kind: 'rejected', reason: 'The briefing already specifies it.', claimIds: ['briefing-requirement'] } }] }),
  }));
  assert.equal(facts.approved, true, facts.reason); assert.equal(coding, 1);
  assert.equal(facts.dialogue.issues.I1.disposition.kind, 'rejected');
  assert.equal(facts.messages.some(m => m.action === 'rebut'), true);
});

test('native ordinary final code change invalidates the current approval instead of relabelling it', async t => {
  let captures = 0;
  const facts = await run(nativeFixture(t, 'native-stale-final', { diffText: async (cwd, base) => {
    if (++captures === 4) writeFileSync(join(cwd, 'completed.txt'), 'changed after review');
    return diffText(cwd, base);
  } }));
  assert.equal(facts.approved, false); assert.match(facts.reason, /stale/);
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /changed after review/);
});

test('native ordinary reviewer check addition runs independently and invalidates the earlier approval', async t => {
  let reviews = 0;
  const facts = await run(nativeFixture(t, 'native-added-check', { runReview: async r => {
    reviews++;
    if (reviews > 1) {
      assert.equal(r.state.approval, null);
      assert.equal(r.state.evidence.some(e => e.kind === 'command' && e.argv.includes('--test')), true);
      return nativeApproval(r);
    }
    const response = nativeApproval(r);
    const bundle = { version: 1, conclusion: 'clean', report: 'Check the existing implementation.', tests: [{ path: 'tests/current.test.js', content: "require('node:assert/strict').equal(require('node:fs').readFileSync('completed.txt','utf8'),'1');" }] };
    return { ...response, resultSeen: true, resultUsable: true, materializationDeferred: true,
      answer: `${JSON.stringify(bundle)}\n<UROBOROS_DIALOGUE>${JSON.stringify(response.dialogue)}</UROBOROS_DIALOGUE>` };
  } }, [{ bin: process.execPath, args: ['--test'] }]));
  assert.equal(facts.approved, true, facts.reason); assert.equal(reviews, 2);
  assert.equal(facts.dialogue.proposalCycles, 1);
});

test('native ordinary correction starts one new cycle and rechecks actual changed files', async t => {
  let coding = 0, reviews = 0;
  const facts = await run(nativeFixture(t, 'native-correction', {
    runExecutor: r => { coding++; writeFileSync(join(r.cwd, 'completed.txt'), coding === 1 ? 'first' : 'corrected'); return { dialogue: executionEnvelope(r, r.action) }; },
    runReview: r => ++reviews === 1 ? { dialogue: executionEnvelope(r, 'ask', { next: { seat: 'codex', action: 'revise', reason: 'Correct the implementation using current evidence' } }) } : nativeApproval(r),
  }));
  assert.equal(facts.approved, true, facts.reason); assert.equal(coding, 2);
  assert.equal(facts.dialogue.proposalCycles, 2); assert.equal(facts.dialogue.correctionCycles, 1);
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /corrected/);
});

test('native ordinary discussion bundle restored by isolation cannot support approval', async t => {
  let reviews = 0;
  const facts = await run(nativeFixture(t, 'native-restored-bundle', {
    runExecutor: r => {
      if (r.action === 'answer') return { dialogue: executionEnvelope(r, 'answer', { next: { seat: 'claude', action: 'answer', reason: 'Discuss the explanation' } }) };
      writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'propose') };
    }, runReview: async r => {
      if (++reviews === 1) return { dialogue: executionEnvelope(r, 'ask', { next: { seat: 'codex', action: 'answer', reason: 'Explain the work' } }) };
      assert.equal(r.action, 'answer');
      const artifact = await materializeReviewBundle({ cwd: r.cwd, round: r.round, diffDigest: r.diffDigest,
        bundle: { version: 1, conclusion: 'clean', report: 'Discussion emitted a new report.', tests: [] } });
      return { ...nativeApproval(r), artifact };
    },
  }));
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /retained review artifact/);
  assert.equal(facts.resources.providerLaunches, 4);
});

test('native ordinary requested answer approves current issues in the same call after protected raw transport', async t => {
  let reviews = 0, answers = 0;
  const deferred = (r, response, bundle) => ({ ...response, resultSeen: true, resultUsable: true, materializationDeferred: true,
    answer: `${JSON.stringify(bundle)}\n<UROBOROS_DIALOGUE>${JSON.stringify(response.dialogue)}</UROBOROS_DIALOGUE>` });
  const retainedReport = 'Explain the existing implementation.';
  const facts = await run(nativeFixture(t, 'native-answer-approval', {
    runExecutor: r => {
      if (r.action === 'answer') return { dialogue: executionEnvelope(r, 'answer', { next: { seat: 'claude', action: 'answer', reason: 'Settle this issue using the briefing' } }) };
      writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'propose') };
    }, runReview: r => {
      reviews++;
      assert.equal(r.deferMaterialization, true);
      if (reviews === 1) return deferred(r, { dialogue: executionEnvelope(r, 'ask', {
        issues: [{ id: 'I1', title: 'Clarify intended behavior', status: 'awaiting-answer', blocking: true }],
        next: { seat: 'codex', action: 'answer', reason: 'Explain the implementation' },
      }) }, { version: 1, conclusion: 'issues', report: retainedReport, tests: [] });
      answers++;
      assert.equal(r.action, 'answer');
      assert.equal(readFileSync(join(r.cwd, '__uro_review/REVIEW.md'), 'utf8'), retainedReport);
      assert.equal(r.state.executionChecks.artifactDigest, r.state.artifactDigest);
      writeFileSync(join(r.cwd, '__uro_review/REVIEW.md'), 'unauthorized raw provider edit');
      mkdirSync(join(r.cwd, '__uro_review/tests'), { recursive: true });
      writeFileSync(join(r.cwd, '__uro_review/tests/tamper.test.js'), 'unauthorized new test');
      writeFileSync(join(r.cwd, 'completed.txt'), 'unauthorized project edit');
      return deferred(r, nativeApproval(r, { issues: [{ id: 'I1', status: 'resolved', disposition: { kind: 'rejected', reason: 'The briefing supports the implemented behavior.', claimIds: ['briefing-requirement'] } }] }),
        { version: 1, conclusion: 'clean', report: 'The current issue is resolved by the cited briefing.', tests: [] });
    },
  }, [{ bin: process.execPath, args: ['-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('completed.txt','utf8'),'1')"] }]));
  assert.equal(facts.approved, true, facts.reason);
  assert.equal(answers, 1, 'the requested answer must approve without a second provider call');
  assert.equal(reviews, 2); assert.equal(facts.resources.providerLaunches, 4);
  assert.equal(facts.dialogue.issues.I1.status, 'resolved');
  assert.equal(facts.approval.messageId, facts.messages.at(-1).id);
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
  assert.equal(existsSync(join(facts.dir, '__uro_review/tests/tamper.test.js')), false);
  assert.equal(facts.iterations.at(-1).reviewer.artifact.revisions.find(item => item.path === 'REVIEW.md').before, reviewDigest(retainedReport));
  assert.match(readFileSync(join(facts.dir, '__uro_review/REVIEW.md'), 'utf8'), /current issue is resolved/);
});

test('native ordinary budget stops before the next provider using journal usage once', async t => {
  let reviews = 0;
  const options = nativeFixture(t, 'native-budget', { runReview: () => { reviews++; } });
  options.tokenBudget = 6;
  const facts = await run(options);
  assert.equal(facts.approved, false); assert.equal(reviews, 0);
  assert.equal(facts.resources.providerLaunches, 1); assert.equal(facts.tokens.total.inputTokens, 5);
  assert.match(facts.reason, /budget-exhausted/);
});

test('native ordinary required sink failure prevents second command and next reviewer', async t => {
  let reviews = 0;
  const facts = await run(nativeFixture(t, 'native-sink', { captureEvidence: () => { throw new Error('required sink unavailable'); },
    runReview: r => { reviews++; return nativeApproval(r); } }, [
    { bin: process.execPath, args: ['-e', "require('node:fs').writeFileSync('first-command','1')"] },
    { bin: process.execPath, args: ['-e', "require('node:fs').writeFileSync('second-command','1')"] },
  ]));
  assert.equal(facts.approved, false); assert.match(facts.reason, /required sink unavailable/);
  assert.equal(existsSync(join(facts.dir, 'first-command')), true);
  assert.equal(existsSync(join(facts.dir, 'second-command')), false); assert.equal(reviews, 0);
});

test('native ordinary missing replan authorization and requested mutation pause before later effects', async t => {
  for (const effect of ['replan', 'mutation']) {
    let later = 0;
    const options = nativeFixture(t, `native-wip-${effect}`, { runPlanCandidateSet: () => { later++; }, runMutation: () => { later++; },
      runReview: r => effect === 'replan' ? { dialogue: executionEnvelope(r, 'replan') } : nativeApproval(r) });
    if (effect === 'mutation') options.mutation = true;
    const facts = await run(options);
    assert.equal(facts.approved, false); assert.match(facts.reason, new RegExp(effect));
    assert.equal(later, 0); assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
  }
});

test('default run captures partial execution before a human question and launches no gate or reviewer', async t => {
  const scr = scratch(), target = makeTarget();
  t.after(() => { rmSync(scr, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); });
  let gates = 0, reviews = 0;
  const facts = await run({ task: 'Keep the original requirement', target, gate: [], scratchRoot: scr,
    runId: 'native-human-partial', mode: 'autonomous', adapters: {
      runExecutor: r => {
        writeFileSync(join(r.cwd, 'completed.txt'), '1');
        assert.ok(r.state, 'normal run must deliver the prepared native dialogue request');
        return { exitCode: 0, changedFiles: ['completed.txt'], dialogue: executionEnvelope(r, 'ask', {
          evidence: ['requirement-briefing'], issues: [{ id: 'Q1', title: 'Choose the remaining product behavior',
            kind: 'product', needsHuman: true, blocking: true, status: 'awaiting-answer' }],
        }) };
      }, runGate: () => { gates++; }, runReview: () => { reviews++; },
    },
  });
  assert.equal(facts.approved, false);
  assert.equal(facts.outcome, 'needs-decision');
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
  assert.equal(facts.dialogue.pendingDecision.authority, 'human');
  assert.equal(facts.dialogue.pendingDecision.artifactDigest, reviewDigest(facts.checkpointState.workspace.diff));
  assert.equal(facts.checkpointState.version, 2);
  assert.equal(facts.checkpointState.interactionMode, 'autonomous');
  assert.equal(gates, 0);
  assert.equal(reviews, 0);
});

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

const DECISION_CONTENT = `
## Q1
Kind: technical
Question: Should this follow the existing implementation convention?
Options: follow the task literally, follow the existing convention
Recommendation: follow the existing convention
`;

test('one holistic review report carries correctness and intent findings into the record', async t => {
  const calls = [];
  const report = '## F1\nSeverity: suggestion\nCategory: correctness\nDescription: Simplify the implementation.\n\n## F2\nSeverity: suggestion\nCategory: intent\nDescription: The shared-scope requirement was dropped.\n';
  const facts = await run({ ...nativeFixture(t, 'f1', { runReview: r => {
    calls.push(r); const response = nativeApproval(r);
    return { ...response, resultSeen: true, resultUsable: true, materializationDeferred: true,
      answer: JSON.stringify({ version: 1, conclusion: 'clean', report, tests: [] }) + '\n<UROBOROS_DIALOGUE>' + JSON.stringify(response.dialogue) + '</UROBOROS_DIALOGUE>' };
  } }), task: 'do the task' });
  assert.equal(facts.approved, true, facts.reason);
  assert.match(readFileSync(join(facts.dir, '__uro_review/REVIEW.md'), 'utf8'), /Category: correctness[\s\S]*Category: intent/);
  assert.match(JSON.stringify(facts), /shared-scope requirement was dropped/);
  for (const gone of ['verdict','correctnessVerdict','intentVerdict','verifierFindings','intentVerifierFindings']) assert.equal(Object.hasOwn(facts, gone), false);
  assert.equal(facts.baseRef, 'HEAD'); assert.match(facts.baseCommit, /^[0-9a-f]{40,64}$/); assert.equal(facts.branch, 'uro/f1');
  assert.equal(calls.length, 1); assert.match(calls[0].input, /do the task/); assert.match(calls[0].input, /completed.txt/);
});

test('debate fix rounds accumulate usage and model overrides reach both agents and run facts', async t => {
  const writers = [], reviewers = []; let writes = 0;
  const options = nativeFixture(t, 'usage-models', {
    runExecutor: r => { writers.push(r); writeFileSync(join(r.cwd, 'completed.txt'), String(++writes));
      return { usage: { inputTokens: writes === 1 ? 10 : 20, outputTokens: writes === 1 ? 2 : 3 }, dialogue: executionEnvelope(r, r.action) }; },
    runReview: r => { reviewers.push(r); return reviewers.length === 1
      ? { usage: { inputTokens: 18, outputTokens: 14 }, dialogue: executionEnvelope(r, 'ask', { next: { seat: 'codex', action: 'revise', reason: 'Correct the implementation' } }) }
      : { ...nativeApproval(r), usage: { inputTokens: 18, outputTokens: 14 } }; },
  });
  const cli = parseArgs(['run','--task',options.task,'--target',options.target,'--gate','unused','--executor-model','executor-override','--executor-effort','medium','--claude-model','reviewer-override']);
  const facts = await run({ ...options, ...cli, gate: [], verifierModel: cli.claudeModel });
  assert.equal(writers.length, 2); assert.equal(reviewers.length, 2); assert.equal(facts.approved, true, facts.reason);
  for (const r of writers) { assert.equal(r.model, 'executor-override'); assert.equal(r.effort, 'medium'); }
  for (const r of reviewers) assert.equal(r.model, 'reviewer-override');
  assert.deepEqual(facts.model, { executor:'executor-override',executorEffort:'medium',verifier:'reviewer-override',arbiter:'reviewer-override' });
  assert.equal(facts.resources.providerLaunches, 4); assert.equal(facts.resources.knownUsage.inputTokens, 66); assert.equal(facts.resources.knownUsage.outputTokens, 33);
  assert.equal(facts.tokens.total.inputTokens, 66); assert.equal(facts.dialogue.correctionCycles, 1);
});

test('a token invariant violation is reported without failing a completed run', async t => {
  const options = nativeFixture(t, 'usage-disagreement');
  const writer = options.adapters.runExecutor;
  options.adapters.runExecutor = r => ({ ...writer(r), usage: { inputTokens:10,cachedInputTokens:30,outputTokens:2,reasoningOutputTokens:0,cacheWriteTokens:0 } });
  const facts = await run(options); assert.equal(facts.approved, true, facts.reason);
  assert.equal(facts.usageConsistency.status, 'disagreement');
  const violation = facts.usageConsistency.checks.find(c => c.status === 'disagreement');
  assert.equal(violation.invariant, 'cachedInputTokens <= inputTokens'); assert.equal(violation.inputTokens,10); assert.equal(violation.cachedInputTokens,30);
  assert.equal(JSON.parse(readFileSync(join(facts.dir,'uro-runfacts.json'))).usageConsistency.status,'disagreement');
  assert.match(readFileSync(join(facts.dir,'uro-report.md'),'utf8'),/token accounting bookkeeping disagreement/i);
});

test('omitted model flags travel through the CLI path to both agents and run-fact defaults', async t => {
  const writers=[], reviewers=[], options=nativeFixture(t,'default-models');
  const writer=options.adapters.runExecutor;
  options.adapters.runExecutor=r=>{writers.push(r);return writer(r);}; options.adapters.runReview=r=>{reviewers.push(r);return nativeApproval(r);};
  const cli=parseArgs(['run','--task',options.task,'--target',options.target,'--gate','unused']);
  const facts=await run({...options,...cli,gate:[],verifierModel:cli.claudeModel});
  assert.equal(facts.approved,true,facts.reason); assert.equal(writers[0].model,DEFAULT_EXECUTOR_MODEL); assert.equal(writers[0].effort,DEFAULT_EXECUTOR_EFFORT);
  assert.equal(Object.hasOwn(writers[0],'superpowersDir'),false); assert.equal(reviewers[0].model,DEFAULT_VERIFIER_MODEL); assert.equal(reviewers[0].bin,'claude');
  assert.deepEqual(facts.model,{executor:DEFAULT_EXECUTOR_MODEL,executorEffort:DEFAULT_EXECUTOR_EFFORT,verifier:DEFAULT_VERIFIER_MODEL,arbiter:DEFAULT_ARBITER_MODEL});
  assert.equal(facts.skills,VERIFIED_SUPERPOWERS.seats.claude.path); assert.deepEqual(Object.keys(facts.superpowers.seats).sort(),['claude','codex']);
});

test('TASK.md is written before execution, excluded from the diff, and the reviewer launches', async t => {
  const plan='Implement the exact requested behavior.\nDo not narrow shared scope.\n'; let reviews=0;
  const options=nativeFixture(t,'g1'); const writer=options.adapters.runExecutor;
  options.task=plan; options.adapters.runExecutor=r=>{ assert.equal(r.approvedPlan,plan); assert.equal(readFileSync(join(r.cwd,'TASK.md'),'utf8'),r.input);
    assert.ok(r.input.includes(plan)); return writer(r); };
  options.adapters.runReview=r=>{reviews++;return nativeApproval(r);};
  const facts=await run(options); assert.equal(facts.approved,true,facts.reason); assert.equal(reviews,1);
  const diff=readFileSync(join(facts.dir,'CHANGES.diff'),'utf8'); assert.match(diff,/completed.txt/); assert.doesNotMatch(diff,/TASK.md/);
  assert.equal(existsSync(join(options.target,'TASK.md')),false);
});

test('run reads an existing .txt task file instead of executing its path string', async t => {
  const options=nativeFixture(t,'txt-task'), path=join(options.scratchRoot,'plan.txt'), plan='Use the contents of the text task file.\n';
  writeFileSync(path,plan); const writer=options.adapters.runExecutor; options.task=path;
  options.adapters.runExecutor=r=>{assert.equal(r.approvedPlan,plan);assert.equal(readFileSync(join(r.cwd,'TASK.md'),'utf8'),r.input);return writer(r);};
  const facts=await run(options); assert.equal(facts.approved,true,facts.reason);
});

test('the first call preserves the plan and a correction receives actual failing evidence', async t => {
  const requests=[];let reviews=0;
  const command={bin:process.execPath,args:['-e',"const n=require('node:fs').readFileSync('completed.txt','utf8');if(n==='1'){process.stdout.write('repair test failed');process.stderr.write('expected true but received false');process.exit(7)}"]};
  const options=nativeFixture(t,'retry-context',{
    runExecutor:r=>{requests.push(r);writeFileSync(join(r.cwd,'completed.txt'),String(requests.length));return {dialogue:executionEnvelope(r,r.action)};},
    runReview:r=>++reviews===1?{dialogue:executionEnvelope(r,'ask',{next:{seat:'codex',action:'revise',reason:'Correct failed check'}})}:nativeApproval(r),
  },[command]);options.task='Implement the requested behavior exactly.\nKeep the original plan unchanged.\n';
  const facts=await run(options);assert.equal(facts.approved,true,facts.reason);assert.equal(requests.length,2);
  assert.equal(requests[0].approvedPlan,options.task);assert.ok(requests[0].input.includes(options.task));
  assert.match(requests[1].input,/repair test failed/);assert.match(requests[1].input,/expected true but received false/);
  assert.equal(requests[1].state.evidence.find(e=>e.kind==='command').exitCode,7);
  assert.equal(readFileSync(join(facts.dir,'TASK.md'),'utf8'),requests[1].input);
});

test('each correction distinguishes current failing evidence while retaining earlier evidence as history', async t => {
  const requests=[];let reviews=0;
  const command={bin:process.execPath,args:['-e',"const n=+require('node:fs').readFileSync('completed.txt','utf8');if(n<3){process.stdout.write(n===1?'FIRST_FAILURE_ONLY':'SECOND_FAILURE_ONLY');process.exit(n===1?11:22)}"]};
  const facts=await run(nativeFixture(t,'fresh-retry-context',{
    runExecutor:r=>{requests.push(r);writeFileSync(join(r.cwd,'completed.txt'),String(requests.length));return {dialogue:executionEnvelope(r,r.action)};},
    runReview:r=>++reviews<3?{dialogue:executionEnvelope(r,'ask',{next:{seat:'codex',action:'revise',reason:'Correct current command failure'}})}:nativeApproval(r),
  },[command]));
  assert.equal(facts.approved,true,facts.reason);assert.equal(requests.length,3);
  const first=requests[1].state.evidence.filter(e=>e.kind==='command'),second=requests[2].state.evidence.filter(e=>e.kind==='command');
  assert.equal(first.at(-1).stdout,'FIRST_FAILURE_ONLY');assert.equal(first.at(-1).exitCode,11);
  assert.equal(second.at(-1).stdout,'SECOND_FAILURE_ONLY');assert.equal(second.at(-1).exitCode,22);
  assert.notEqual(first.at(-1).codeIdentity,second.at(-1).codeIdentity);assert.ok(second.some(e=>e.stdout==='FIRST_FAILURE_ONLY'));
  assert.equal(facts.dialogue.correctionCycles,2);
});

test('a green first gate never augments the executor prompt', async t => {
  const requests=[],options=nativeFixture(t,'green-no-retry-context',{},[{bin:process.execPath,args:['-e',"process.stdout.write('green')"]}]);
  const writer=options.adapters.runExecutor; options.adapters.runExecutor=r=>{requests.push(r);return writer(r);};
  const facts=await run(options); assert.equal(facts.approved,true,facts.reason); assert.equal(requests.length,1);
  assert.equal(requests[0].approvedPlan,options.task); assert.doesNotMatch(requests[0].input,/Previous gate attempt failed/);
  assert.equal(facts.dialogue.correctionCycles,0);
});

test('a reviewer launch failure yields verifier-failed', async t => {
  const facts=await run(nativeFixture(t,'vf1',{runReview:()=>{throw Error('reviewer CLI would not start');}}));
  assert.equal(facts.approved,false); assert.equal(facts.nextAction,'paused'); assert.notEqual(exitCodeFor(facts.outcome),0);
  assert.match(JSON.stringify(facts),/reviewer CLI would not start/);
});

test('a reviewer that runs but writes no report yields verifier-failed', async t => {
  let reviews=0; const facts=await run(nativeFixture(t,'vf2',{runReview:()=>{reviews++;return {launchFailed:false,timedOut:false};}}));
  assert.equal(facts.approved,false); assert.equal(facts.nextAction,'paused'); assert.equal(facts.approval,null); assert.equal(reviews,2); assert.equal(facts.resources.repairLaunches,1);
});

test('empty malformed execution pauses without launching a verifier or inventing no-op success', async t => {
  let reviews=0;
  const facts=await run(nativeFixture(t,'e1',{runExecutor:()=>({exitCode:0,changedFiles:[],lastMessage:''}),runReview:()=>{reviews++;throw Error('No review');}}));
  assert.equal(reviews,0); assert.equal(facts.approved,false); assert.notEqual(facts.outcome,'no-op');
  assert.equal(readFileSync(join(facts.dir,'CHANGES.diff'),'utf8'),''); assert.equal(await diffText(facts.dir),'');
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

test('a passing verifier preflight probe leaves executor dispatch unchanged', async t => {
  let writes=0; const options=nativeFixture(t,'probe-passed'); const writer=options.adapters.runExecutor;
  options.adapters.probeVerifier=()=>({ok:true,reason:null}); options.adapters.runExecutor=r=>{writes++;return writer(r);};
  const facts=await run(options); assert.equal(facts.approved,true,facts.reason); assert.equal(writes,1);
});

test('a native explicit missing product decision pauses in manual mode before gate or reviewer', async t => {
  let gates=0,reviews=0; const facts=await run({...nativeFixture(t,'manual-decision',{
    runExecutor:r=>({dialogue:executionEnvelope(r,'ask',{issues:[{id:'Q1',kind:'product',needsHuman:true,title:'Choose product behavior',status:'awaiting-answer',blocking:true}],
      evidence:['requirement-briefing'],next:{seat:'claude',action:'answer',reason:'Missing user intent'}})}),
    runGate:()=>{gates++;throw Error('No check');},runReview:()=>{reviews++;throw Error('No reviewer');},
  }),mode:'manual'});
  assert.equal(facts.outcome,'needs-decision',facts.reason); assert.equal(gates,0); assert.equal(reviews,0);
  assert.deepEqual(facts.dialogue.pendingDecision.issueIds,['Q1']); assert.equal(facts.dialogue.pendingDecision.authority,'human');
  assert.equal(facts.checkpointState.version,2); assert.equal(facts.checkpointState.interactionMode,'manual');
});

test('a clean executor run receives evidenced Claude approval in every mode', async t => {
  for(const mode of ['manual','autonomous']){
    const facts=await run({...nativeFixture(t,mode+'-clean'),mode,decisionResolver:()=>{throw Error('No inferred decision');}});
    assert.equal(facts.approved,true,facts.reason); assert.equal(facts.dialogue.pendingDecision,null); assert.equal(facts.approval.decidedBy,'claude');
    assert.equal(facts.resources.providerLaunches,2);
  }
});

test('a historical sentinel beside substantive native work does not invent a human decision', async t => {
  let reviews=0; const options=nativeFixture(t,'decision-with-work',{runExecutor:r=>{
    writeFileSync(join(r.cwd,'DECISION.md'),DECISION_CONTENT); writeFileSync(join(r.cwd,'new.txt'),'substantive work');
    return {usage:{inputTokens:1,outputTokens:1},dialogue:executionEnvelope(r,'propose')};
  },runReview:r=>{reviews++;return nativeApproval(r);}},[{bin:process.execPath,args:['-e',"process.stdout.write('gate-ran')"]}]);
  const facts=await run({...options,mode:'manual'}); assert.equal(facts.approved,true,facts.reason); assert.equal(reviews,1);
  assert.equal(facts.dialogue.pendingDecision,null); assert.equal(facts.dialogue.evidence.find(e=>e.kind==='command').stdout,'gate-ran');
  assert.doesNotMatch(readFileSync(join(facts.dir,'CHANGES.diff'),'utf8'),/DECISION.md/);
});

test('autonomous mode answers a native question then resumes only remaining execution', async t => {
  let writes=0,reviews=0; const plans=[];
  const facts=await run(nativeFixture(t,'autonomous-decision',{
    runExecutor:r=>{plans.push(r); if(++writes===1){writeFileSync(join(r.cwd,'first.txt'),'retained');return {dialogue:executionEnvelope(r,'ask',{
      issues:[{id:'Q1',title:'Existing convention?',kind:'technical',status:'awaiting-answer',blocking:false}],evidence:['requirement-briefing'],
      next:{seat:'claude',action:'answer',reason:'Clarify existing convention'}})};}
      assert.equal(readFileSync(join(r.cwd,'first.txt'),'utf8'),'retained');assert.equal(r.remainingWork,true);
      writeFileSync(join(r.cwd,'new.txt'),'resolved work');return {dialogue:executionEnvelope(r,'propose')};},
    runReview:r=>++reviews===1?{dialogue:executionEnvelope(r,'answer',{content:'Follow the existing convention.',next:{seat:'codex',action:'propose',reason:'Complete remaining work'}})}:nativeApproval(r),
  }));
  assert.equal(facts.approved,true,facts.reason);assert.equal(writes,2);assert.equal(reviews,2);
  assert.match(plans[1].input,/Follow the existing convention/);assert.equal(facts.dialogue.proposalCycles,1);assert.equal(facts.dialogue.correctionCycles,0);
  assert.equal(facts.dialogue.messages.filter(m=>m.action==='answer').length,1);assert.equal(facts.dialogue.pendingDecision,null);
});

test('autonomous authority does not change when a TTY is present', async t => {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  t.after(() => { if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor); else delete process.stdin.isTTY; });
  const options=nativeFixture(t,'authority-present');const writer=options.adapters.runExecutor;
  options.adapters.runExecutor=r=>r.action==='propose'?writer(r):{dialogue:executionEnvelope(r,'challenge',{content:'A TTY is present; reconsider the technical issue.',
    next:{seat:'claude',action:'answer',reason:'Answer on merits'}})};
  let reviews=0;options.adapters.runReview=r=>++reviews===1?{dialogue:executionEnvelope(r,'ask',{next:{seat:'codex',action:'challenge',reason:'Explain technical objection'}})}:nativeApproval(r);
  options.decisionResolver=()=>{throw Error('Presence must not select a legacy resolver');};
  const facts=await run(options);assert.equal(facts.approved,true,facts.reason);assert.equal(facts.authority,'claude');
  assert.equal(facts.dialogue.pendingDecision,null);assert.equal(facts.escalation,undefined);
});

test('autonomous authority uses reviewer merits without inventing an operator-absent assumption', async t => {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  t.after(() => { if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor); else delete process.stdin.isTTY; });
  let reviews=0;const events=[];const options=nativeFixture(t,'authority-absent');const writer=options.adapters.runExecutor;
  options.reporter=e=>events.push(e);options.adapters.runExecutor=r=>r.action==='propose'?writer(r):{dialogue:executionEnvelope(r,'rebut',{content:'The captured requirement already permits the existing implementation.',evidence:['requirement-briefing']})};
  options.adapters.runReview=r=>++reviews===1?{dialogue:executionEnvelope(r,'ask',{next:{seat:'codex',action:'rebut',reason:'Explain requirement'}})}:nativeApproval(r);
  const facts=await run(options);assert.equal(facts.approved,true,facts.reason);assert.equal(facts.authority,'claude');
  assert.equal(facts.escalation,undefined);assert.equal(events.some(e=>e.type==='assumed'),false);assert.equal(facts.dialogue.pendingDecision,null);
});

test('challenge-round exhaustion halts instead of starting another executor', async t => {
  let discussions=0,reviews=0,writes=0;
  const facts=await run({...nativeFixture(t,'challenge-exhaustion',{
    runExecutor:r=>{if(r.action==='propose'){writes++;writeFileSync(join(r.cwd,'new.txt'),'retained');return {dialogue:executionEnvelope(r,'propose')};}
      discussions++;return {dialogue:executionEnvelope(r,'challenge',{next:{seat:'claude',action:'answer',reason:'Reconsider technical evidence'}})};},
    runReview:r=>{reviews++;return {dialogue:executionEnvelope(r,'ask',{next:{seat:'codex',action:'challenge',reason:'Explain remaining objection'}})};},
  }),challengeRounds:2});
  assert.equal(facts.approved,false);assert.equal(writes,1);assert.equal(discussions,2);assert.equal(reviews,3);
  assert.equal(facts.dialogue.challengeCycles,2);assert.match(facts.reason,/challenge/i);
});

test('an unusable native answer pauses without rerunning the executor', async t => {
  let writes=0,reviews=0;const facts=await run(nativeFixture(t,'empty-resolution',{
    runExecutor:r=>{writes++;writeFileSync(join(r.cwd,'partial.txt'),'retained');return {dialogue:executionEnvelope(r,'ask',{evidence:['requirement-briefing'],
      next:{seat:'claude',action:'answer',reason:'Clarify before completing'}})};},
    runReview:()=>{reviews++;return {resultSeen:false,resultUsable:false,answer:''};},
  }));
  assert.equal(facts.approved,false);assert.equal(writes,1);assert.equal(reviews,1);
  assert.equal(readFileSync(join(facts.dir,'partial.txt'),'utf8'),'retained');assert.equal(facts.dialogue.executionCycle.open,true);
});

test('--mode accepts manual or autonomous and rejects other values', () => {
  const base = ['run', '--task', 'p', '--target', 't', '--gate', 'g'];
  assert.equal(parseArgs([...base, '--mode', 'manual']).mode, 'manual');
  assert.equal(parseArgs([...base, '--mode', 'autonomous']).mode, 'autonomous');
  assert.throws(() => parseArgs([...base, '--mode', 'interactive']), /invalid --mode/i);
});

test('non-zero executor exit with an empty diff is unapproved and launches no reviewer', async t => {
  let reviews=0;const facts=await run(nativeFixture(t,'executor-failed-empty-diff',{
    runExecutor:r=>({exitCode:1,changedFiles:[],dialogue:executionEnvelope(r,'propose'),lastMessage:'executor aborted'}),
    runReview:()=>{reviews++;throw Error('No review');},
  }));assert.equal(facts.approved,false);assert.equal(reviews,0);assert.notEqual(exitCodeFor(facts),0);
  assert.equal(readFileSync(join(facts.dir,'CHANGES.diff'),'utf8'),'');
});

test('zero executor exit with empty legacy prose cannot imply fresh-run no-op success', async t => {
  let reviews=0;const facts=await run(nativeFixture(t,'clean-empty-diff',{
    runExecutor:()=>({exitCode:0,changedFiles:[],lastMessage:'nothing to do'}),runReview:()=>{reviews++;throw Error('No review');},
  }));assert.equal(facts.approved,false);assert.notEqual(facts.outcome,'no-op');assert.equal(reviews,0);assert.notEqual(exitCodeFor(facts),0);
});

test('approval-request prose cannot replace an explicit native human question or approve empty work', async t => {
  const raw="Approve this design and I'll implement it.";const facts=await run(nativeFixture(t,'approval-request-no-op',{
    runExecutor:()=>({exitCode:0,changedFiles:[],agentMessages:[raw],lastMessage:raw}),
    runReview:()=>{throw Error('No review');},
  }));assert.equal(facts.approved,false);assert.notEqual(facts.outcome,'needs-decision');assert.notEqual(facts.outcome,'no-op');
  assert.equal(facts.dialogue.pendingDecision,null);
  assert.ok(readFileSync(join(facts.checkpointState.directory,'__uro_dialogue/journal.jsonl'),'utf8').includes(raw));
});

test('unrelated executor prose does not label an empty native pause as approval-requested', async t => {
  const facts=await run(nativeFixture(t,'ordinary-no-op',{runExecutor:()=>({exitCode:0,changedFiles:[],lastMessage:'The approved design is already implemented; no changes are needed.'})}));
  assert.equal(facts.approved,false);assert.equal(Object.hasOwn(facts,'noOpReason'),false);
  assert.doesNotMatch(readFileSync(join(facts.dir,'uro-report.md'),'utf8'),/approval-requested/);
});

test('a non-zero required exit is delivered as evidence and prevents approval', async t => {
  let reviews=0;const command={bin:process.execPath,args:['-e',"process.stdout.write('failed assertion');process.stderr.write('stack trace');process.exit(7)"]};
  const facts=await run(nativeFixture(t,'required-nonzero',{runReview:r=>{
    reviews++;const check=r.state.evidence.find(e=>e.kind==='command');assert.equal(check.exitCode,7);assert.equal(check.stdout,'failed assertion');
    assert.equal(check.stderr,'stack trace');return nativeApproval(r);
  }},[command]));
  assert.equal(facts.approved,false);assert.equal(reviews,1);assert.equal(facts.dialogue.approval,null);
  const check=facts.dialogue.evidence.find(e=>e.kind==='command');assert.deepEqual(check.argv,[process.execPath,...command.args]);assert.ok(check.codeIdentity);
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
  assert.equal(facts.nextAction, 'paused');
  assert.equal(facts.approved, false);
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
        await opts.beforeKillRequired({
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

  assert.equal(facts.nextAction, 'paused');
  assert.equal(facts.approved, false);
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

test('a failed partial-work commit preserves bytes and reports a required unapproved pause', async () => {
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
        await assert.rejects(opts.beforeKillRequired({ kind: 'liveness', timeoutMs: 50, gapMs: 50,
          setting: 'URO_STALL_THRESHOLD_MS' }), /git commit failed/);
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

  assert.equal(facts.nextAction, 'paused');
  assert.equal(facts.approved, false);
  assert.match(facts.reason, /git commit failed/);
  assert.equal(facts.checkpointState.supervision.operations.find(item => item.purpose === 'preservation').status, 'prepared');
  assert.equal(facts.timeoutEvents[0].timeoutMs, 50,
    'the silence threshold is the recorded limit');
  assert.equal(facts.timeoutEvents[0].gapMs, 50);
  assert.equal(facts.timeoutEvents[0].setting, 'URO_STALL_THRESHOLD_MS');
  assert.match(readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8'), /partial[.]js/,
    'positive control: staging and diff production succeeded before git commit failed');
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out reviewer cannot produce a successful outcome', async t => {
  let reviews=0;const facts=await run(nativeFixture(t,'verifier-timeout',{runReview:()=>{reviews++;return {timedOut:true,timeoutReason:{timeoutMs:40}};}}));
  assert.equal(facts.approved,false);assert.equal(facts.nextAction,'paused');assert.equal(reviews,1);assert.notEqual(exitCodeFor(facts),0);
  assert.match(JSON.stringify(facts),/timedOut/);
});

test('a timed-out gate command is distinguishable in run facts and the report', async t => {
  let reviews=0;const command={bin:process.execPath,args:['-e',"process.stdout.write('partial test output');setTimeout(()=>{},10000)"]};
  const options=nativeFixture(t,'gate-timeout',{runReview:r=>{reviews++;return nativeApproval(r);}},[command]);
  const facts=await run({...options,gateTimeout:1000});
  assert.equal(facts.approved,false);assert.notEqual(exitCodeFor(facts),0);assert.equal(reviews,1);
  const check=facts.dialogue.evidence.find(e=>e.kind==='command');assert.equal(check.timedOut,true);assert.equal(check.status,'timed-out');assert.equal(check.stdout,'partial test output');
  assert.match(JSON.stringify(facts),/timed-out/);
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

test('debate regression control converges after one current native review', async t => {
  const events=[];const options=nativeFixture(t,'debate-clean',{},[{bin:process.execPath,args:['-e',"process.stdout.write('checked-once')"]}]);
  options.reporter=e=>events.push(e);const facts=await run(options);
  assert.equal(facts.approved,true,facts.reason);assert.equal(facts.resources.providerLaunches,2);assert.equal(facts.dialogue.proposalCycles,1);
  assert.equal(facts.dialogue.evidence.filter(e=>e.kind==='command').length,1);assert.equal(facts.dialogue.messages.filter(m=>m.action==='approve').length,1);
  assert.equal(events.some(e=>e.type==='pivot'),false);
});

test('one blocking native issue is corrected and explicitly resolved by current review', async t => {
  let writes=0,reviews=0;const requests=[];
  const facts=await run(nativeFixture(t,'debate-fixed',{
    runExecutor:r=>{requests.push(r);writeFileSync(join(r.cwd,'completed.txt'),String(++writes));return {dialogue:executionEnvelope(r,r.action)};},
    runReview:r=>++reviews===1?{dialogue:executionEnvelope(r,'ask',{issues:[{id:'I1',title:'Missing branch',status:'open',blocking:true}],
      next:{seat:'codex',action:'revise',reason:'Fix I1 missing branch'}})}:nativeApproval(r,{issues:[{id:'I1',status:'resolved',
        disposition:{kind:'accepted',reason:'Current corrected branch satisfies the briefing.',claimIds:['briefing-requirement']}}]}),
  },[{bin:process.execPath,args:['-e',"process.stdout.write(require('node:fs').readFileSync('completed.txt','utf8'))"]}]));
  assert.equal(facts.approved,true,facts.reason);assert.equal(writes,2);assert.equal(reviews,2);assert.match(requests[1].input,/Missing branch/);
  assert.equal(facts.dialogue.issues.I1.status,'resolved');assert.equal(facts.dialogue.evidence.filter(e=>e.kind==='command').length,2);
});

test('a persistent native issue remains visible across three corrections before explicit resolution', async t => {
  let writes=0,reviews=0;const requests=[];
  const facts=await run(nativeFixture(t,'debate-circling',{
    runExecutor:r=>{requests.push(r);writeFileSync(join(r.cwd,'completed.txt'),String(++writes));return {dialogue:executionEnvelope(r,r.action)};},
    runReview:r=>++reviews<4?{dialogue:executionEnvelope(r,'ask',{issues:[{id:'I1',title:'Recurring missing branch',status:'open',blocking:true}],
      next:{seat:'codex',action:'revise',reason:'The prior implementation still misses I1; amend this branch'}})}:nativeApproval(r,{issues:[{id:'I1',status:'resolved',
        disposition:{kind:'accepted',reason:'Fourth implementation addresses I1.',claimIds:['briefing-requirement']}}]}),
    runArbiter:()=>{throw Error('Claude reviews directly');},
  }));
  assert.equal(facts.approved,true,facts.reason);assert.equal(writes,4);assert.equal(reviews,4);assert.equal(facts.dialogue.correctionCycles,3);
  assert.match(requests[3].input,/amend this branch/);assert.equal(requests[3].state.messages.filter(m=>m.sender==='codex').length,3);
  assert.equal(facts.dialogue.issues.I1.status,'resolved');
});

test('the final allowed execution cycle suppresses a requested correction that cannot run', async t => {
  let writes=0,reviews=0;
  const facts=await run({...nativeFixture(t,'debate-final-amend',{
    runExecutor:r=>{writeFileSync(join(r.cwd,'completed.txt'),String(++writes));return {dialogue:executionEnvelope(r,r.action)};},
    runReview:r=>{reviews++;return {dialogue:executionEnvelope(r,'ask',{issues:[{id:'I1',title:'Still unresolved',status:'open',blocking:true}],
      next:{seat:'codex',action:'revise',reason:'Amend the unresolved branch'}})};},
  }),debateRounds:3});
  assert.equal(facts.approved,false);assert.equal(writes,3);assert.equal(reviews,3);assert.equal(facts.dialogue.proposalCycles,3);
  assert.equal(facts.dialogue.issues.I1.status,'open');assert.match(facts.reason,/proposal|cycle|limit/);
});

test('native retained replan after the last execution cycle plans but cannot buy another cycle', async t => {
  let planning = 0, coding = 0;
  const facts = await run({ ...nativeFixture(t, 'native-replan-final-cycle', {
    runExecutor: r => { coding++; writeFileSync(join(r.cwd, 'completed.txt'), '1'); return { dialogue: executionEnvelope(r, 'propose') }; },
    runReview: r => ({ dialogue: executionEnvelope(r, 'replan', {
      issues: [{ id: 'R1', title: 'Remaining authorized work', status: 'open', blocking: true }],
      replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The completed segment exposes a new remaining-work requirement.' },
    }) }),
    draftPlanCandidate: r => { planning++; return { plan: 'Remaining work only', gate: [], dialogue: planningEnvelope(r, 'propose') }; },
    reviewPlanCandidate: r => { planning++; return planningApproval(r); },
  }), pivotCandidates: 1, debateRounds: 1 });
  assert.equal(facts.approved, false); assert.equal(coding, 1); assert.equal(planning, 2);
  assert.equal(facts.phase, 'execution'); assert.equal(facts.dialogue.proposalCycles, 1);
  assert.match(facts.reason, /proposal-cycle limit/);
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
});

test('native retained replan preserves explicit challenge use across remaining execution', async t => {
  let coding = 0, reviewing = 0;
  const facts = await run({ ...nativeFixture(t, 'native-replan-challenge', {
    runExecutor: r => {
      coding++;
      if (coding === 1) writeFileSync(join(r.cwd, 'completed.txt'), '1');
      else { assert.equal(r.state.challengeCycles, 1); assert.equal(r.remainingWork, true); writeFileSync(join(r.cwd, 'remaining.txt'), 'done'); }
      return { usage: { inputTokens: 1, outputTokens: 1 }, dialogue: executionEnvelope(r, r.action) };
    },
    runReview: r => {
      reviewing++;
      if (reviewing === 1) return { dialogue: executionEnvelope(r, 'challenge', {
        next: { seat: 'claude', action: 'verify', reason: 'Assess the current evidence' } }) };
      if (reviewing === 2) return { dialogue: executionEnvelope(r, 'replan', {
        issues: [{ id: 'R1', title: 'Remaining work', blocking: true, status: 'open' }],
        replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'The first completed file settles the first step; remaining.txt still needs implementation.' },
      }) };
      return { dialogue: executionEnvelope(r, 'ask', { next: { seat: 'claude', action: 'challenge', reason: 'Another explicit challenge' } }) };
    },
    draftPlanCandidate: r => ({ plan: 'Only finish remaining.txt', gate: [], dialogue: planningEnvelope(r, 'propose') }),
    reviewPlanCandidate: planningApproval,
  }), pivotCandidates: 1, challengeRounds: 1 });
  assert.equal(facts.approved, false); assert.match(facts.reason, /challenge limit/);
  assert.equal(coding, 2); assert.equal(reviewing, 3);
  assert.equal(facts.dialogue.challengeCycles, 1);
  assert.equal(readFileSync(join(facts.dir, 'completed.txt'), 'utf8'), '1');
});

test('the native reviewer conclude action stops without reporting success', async t => {
  const facts=await run(nativeFixture(t,'debate-conclude',{runReview:r=>({dialogue:executionEnvelope(r,'stop',{content:'The approach cannot satisfy requirements.'})})}));
  assert.equal(facts.approved,false);assert.equal(facts.nextAction,'stop');assert.notEqual(exitCodeFor(facts),0);
  assert.equal(facts.resources.providerLaunches,2);assert.equal(facts.dialogue.messages.at(-1).sender,'claude');assert.match(facts.reason,/cannot satisfy/);
});

test('URO_DEBATE_ROUNDS exhaustion stops honestly with unresolved findings', async t => {
  let writes=0;const facts=await run({...nativeFixture(t,'debate-exhausted',{
    runExecutor:r=>{writeFileSync(join(r.cwd,'completed.txt'),String(++writes));return {dialogue:executionEnvelope(r,r.action)};},
    runReview:r=>({dialogue:executionEnvelope(r,'ask',{issues:[{id:'I1',title:'Unresolved requirement',status:'open',blocking:true}],
      next:{seat:'codex',action:'revise',reason:'Correct I1'}})}),
  }),env:{...process.env,URO_DEBATE_ROUNDS:'1'}});
  assert.equal(facts.approved,false);assert.equal(writes,1);assert.equal(facts.dialogue.proposalCycles,1);assert.equal(facts.dialogue.issues.I1.status,'open');
  assert.match(facts.reason,/proposal|cycle|limit/);assert.match(JSON.stringify(facts.checkpointState),/Unresolved requirement/);
});

test('a non-zero correction check remains visible and blocks an attempted approval', async t => {
  let writes=0,reviews=0;
  const command={bin:process.execPath,args:['-e',"if(require('node:fs').readFileSync('completed.txt','utf8')==='2'){process.stdout.write('review regression failed');process.exit(7)}"]};
  const facts=await run(nativeFixture(t,'debate-fix-gate-failed',{
    runExecutor:r=>{writeFileSync(join(r.cwd,'completed.txt'),String(++writes));return {dialogue:executionEnvelope(r,r.action)};},
    runReview:r=>++reviews===1?{dialogue:executionEnvelope(r,'ask',{next:{seat:'codex',action:'revise',reason:'Fix branch'}})}:(assert.equal(r.state.evidence.filter(e=>e.kind==='command').at(-1).exitCode,7),nativeApproval(r)),
  },[command]));
  assert.equal(facts.approved,false);assert.equal(writes,2);assert.equal(reviews,2);assert.equal(facts.dialogue.approval,null);
  assert.equal(facts.dialogue.evidence.filter(e=>e.kind==='command').at(-1).stdout,'review regression failed');
});

test('suggestions alone converge without another executor or gate round', async t => {
  const facts=await run(nativeFixture(t,'debate-suggestion',{runReview:r=>nativeApproval(r,{issues:[{id:'I1',title:'Optional naming suggestion',status:'open',blocking:false}]})},
    [{bin:process.execPath,args:['-e',"process.stdout.write('checked')"]}]));
  assert.equal(facts.approved,true,facts.reason);assert.equal(facts.resources.providerLaunches,2);assert.equal(facts.dialogue.correctionCycles,0);
  assert.equal(facts.dialogue.evidence.filter(e=>e.kind==='command').length,1);assert.equal(facts.dialogue.issues.I1.blocking,false);
});

test('debate rounds are unbounded by default and accept any positive operator bound', () => {
  assert.equal(resolveDebateRounds({}), undefined);
  assert.equal(resolveDebateRounds({ URO_DEBATE_ROUNDS: '50' }), 50);
  assert.throws(() => resolveDebateRounds({ URO_DEBATE_ROUNDS: '0' }), /positive integer/);
  assert.throws(() => resolveDebateRounds({ URO_DEBATE_ROUNDS: '2.5' }), /positive integer/);
});

test('Claude retains reviewer authority and sees current diff and history when amending recurring work', async t => {
  const requests=[],writers=[];let writes=0;
  const facts=await run(nativeFixture(t,'debate-independent-review',{
    runExecutor:r=>{writers.push(r);writeFileSync(join(r.cwd,'completed.txt'),String(++writes));return {dialogue:executionEnvelope(r,r.action)};},
    runReview:r=>{requests.push(r);if(requests.length<4)return {dialogue:executionEnvelope(r,'ask',{content:'Current branch remains fixable.',
      next:{seat:'codex',action:'revise',reason:'The review shows it is fixable'}})};return nativeApproval(r);},
    runArbiter:()=>{throw Error('No separate pivot oracle');},
  }));
  assert.equal(facts.approved,true,facts.reason);assert.equal(requests.length,4);assert.equal(facts.authority,'claude');
  assert.match(requests[2].input,/diff --git/);assert.equal(requests[2].state.messages.filter(m=>m.sender==='codex').length,3);
  assert.match(writers[3].input,/The review shows it is fixable/);assert.equal(facts.dialogue.messages.filter(m=>m.sender==='claude').length,4);
});

test('every command run in the worktree leaves whole evidence on disk', async t => {
  const stdout='noise line\n'.repeat(200)+'tests 823 pass 823 fail 0\n',stderr='whole stderr';
  const command={bin:process.execPath,args:['-e',"process.stdout.write("+JSON.stringify(stdout)+");process.stderr.write("+JSON.stringify(stderr)+")"]};
  const facts=await run(nativeFixture(t,'evidence-run',{},[command]));assert.equal(facts.approved,true,facts.reason);
  const record=facts.dialogue.evidence.find(e=>e.kind==='command');assert.equal(record.exitCode,0);assert.equal(record.stdout,stdout);assert.equal(record.stderr,stderr);
  assert.deepEqual(record.argv,[process.execPath,...command.args]);assert.equal(record.cwd,facts.dir);assert.ok(record.codeIdentity);
  const full=JSON.parse(readFileSync(record.capturedPath,'utf8'));assert.equal(full.stdout,stdout);assert.equal(full.stderr,stderr);
  assert.equal(Object.hasOwn(record,'passed'),false);
});
