import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runQueue, continueQueue } from '../src/queue.js';
import { resumeRun } from '../src/resume.js';
import { checkpointDigest, writeCheckpointAtomic, readCheckpoint } from '../src/checkpoint.js';
import { planningEnvelope, planningApproval } from './fixtures/planning-responses.js';
import { readPlanningHandoffReference } from '../src/planning-dialogue.js';
import { readWorkflowBinding, workflowIdentity } from '../src/workflow-profiles.js';
import { createSharedContext, persistSharedContext } from '../src/shared-context.js';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { launchLoopRun, launchLoopPlan, judgeGoalAcceptance } from '../src/queue-runtime.js';
import { buildArbiterPrompt } from '../src/arbiter.js';
import { reviewDigest } from '../src/review.js';
import { copyNativeWorkflowPackage } from './fixtures/workflow-profile-fixture.js';
import { VERIFIED_SUPERPOWERS } from '../fixtures/verified-superpowers.mjs';

const usage = { inputTokens: 1, outputTokens: 1 };
const diff = 'diff --git a/result.txt b/result.txt\n+completed work\n';
function fixture(t, count = 2) {
  const base = process.platform === 'win32' ? 'C:/ccc-test' : tmpdir(); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'uro-workflow-parent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'target'); mkdirSync(target);
  const units = Array.from({ length: count }, (_, i) => ({ name: `unit-${i + 1}`, task: `task-${i}.md`, gate: `gate-${i}.json` }));
  for (const unit of units) { writeFileSync(join(root, unit.task), 'Preserve completed work'); writeFileSync(join(root, unit.gate), '[]'); }
  const file = join(root, 'queue.json'); writeFileSync(file, JSON.stringify(units));
  const spec = join(root, 'spec.md'); writeFileSync(spec, 'Deliver the full goal');
  return { root, target, file, spec };
}
function ready(runId) {
  return { runId, outcome: 'review-ready', phase: 'execution', approved: true,
    approval: { artifactDigest: reviewDigest(diff), decidedBy: 'claude', basis: 'reviewer', reason: 'Reviewed current diff' },
    tokens: { total: usage }, resources: { providerLaunches: 2, usageUnknown: false } };
}
// Real, internally consistent changed installed package, independently hashed.
function upgradeBundle(assetsPath) {
  const path = join(assetsPath, 'manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  const sha = value => createHash('sha256').update(value).digest('hex');
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  for (const profile of manifest.profiles) for (const section of profile.sections) {
    const file = join(assetsPath, section.localPath), text = readFileSync(file, 'utf8') + '\nPARENT_UPGRADE_B_91827\n';
    writeFileSync(file, text); section.sha256 = sha(text);
  }
  const binding = { schemaVersion: 1, mode: 'bound', profiles: manifest.profiles.map(p => ({
    id: p.id, adapterRevision: p.adapterRevision, upstream: p.upstream,
    sources: p.sources.map(({ path, sha256 }) => ({ path, sha256 })), notices: p.notices.map(({ path, sha256 }) => ({ path, sha256 })),
    sections: p.sections.map(s => ({ id: s.id, phases: s.phases, content: readFileSync(join(assetsPath, s.localPath), 'utf8'), sha256: s.sha256 })),
  })) };
  manifest.digest = sha(JSON.stringify(sort(binding))); writeFileSync(path, JSON.stringify(manifest));
}

test('task-only queue pins actual child stdin across a valid installed upgrade and aggregate acceptance', async t => {
  const f = fixture(t), pkg = copyNativeWorkflowPackage(t);
  const binding = (await pkg.module('workflow-profiles.js')).loadWorkflowBinding();
  const inherited = structuredClone(binding);
  const child = join(f.root, 'child.mjs');
  writeFileSync(child, `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSharedContextReference, resolveNativeWorkflowBinding } from ${JSON.stringify(pathToFileURL(join(pkg.root, 'src/shared-context.js')).href)};
import { loadWorkflowBinding } from ${JSON.stringify(pathToFileURL(join(pkg.root, 'src/workflow-profiles.js')).href)};
const ref = JSON.parse(readFileSync(0, 'utf8'));
const snapshot = readSharedContextReference({ reference: ref, target: process.cwd() });
const binding = resolveNativeWorkflowBinding({ parentSnapshots: [snapshot] });
const dir = join(process.cwd(), snapshot.unitId.split(':').at(-1)); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'observed.json'), JSON.stringify({ snapshot, binding, installed: loadWorkflowBinding().digest }));
writeFileSync(join(dir, 'CHANGES.diff'), ${JSON.stringify(diff)});
process.stdout.write(JSON.stringify({ runId: snapshot.unitId, dir }));`);
  const observations = [], acceptances = [];
  const result = await runQueue({ file: f.file, target: f.target, workflowBinding: inherited, acceptGoalSpec: f.spec,
    dependencies: { assertCleanTarget: async () => {},
      launchRun: async request => {
        const launched = await launchLoopRun(request, { loopPath: child });
        observations.push(JSON.parse(readFileSync(join(launched.runDirectory, 'observed.json'), 'utf8')));
        if (observations.length === 1) {
          upgradeBundle(pkg.assetsPath);
          Object.assign(inherited, (await pkg.module('workflow-profiles.js')).loadWorkflowBinding());
        }
        return launched;
      }, readRunFacts: launch => ready(launch.runId), judgeLanding: async () => ({ approved: true, usage }),
      landDiff: async ({ unit }) => { writeFileSync(join(f.target, `completed-${unit.index}`), 'retained'); return { commit: `commit-${unit.index}` }; },
      acceptGoal: async request => {
        acceptances.push(request);
        return judgeGoalAcceptance(request, { runCommand: async () => ({ code: 0, stdout: diff }),
          arbiter: async request => { acceptances.push(request); return { verdict: 'ANSWERED', answer: JSON.stringify({ approved: true, reasoning: 'Read aggregate', findings: [] }), usage }; } });
      } } });
  assert.equal(result.landedCount, 2, result.stop?.reason);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].installed, binding.digest);
  assert.notEqual(observations[1].installed, binding.digest);
  assert.deepEqual(observations.map(r => r.snapshot.workflow?.digest), [binding.digest, binding.digest]);
  assert.deepEqual(observations.map(r => r.binding.digest), [binding.digest, binding.digest]);
  assert.equal(readFileSync(join(f.target, 'completed-1'), 'utf8'), 'retained');
  assert.equal(acceptances.length, 2, 'one aggregate provider request');
  assert.equal(acceptances[0].workflowBinding?.digest, binding.digest);
  const prompt = acceptances[1].prompt ?? buildArbiterPrompt(acceptances[1].request);
  assert.match(prompt, /BMAD/); assert.match(prompt, /Spec Kit/); assert.doesNotMatch(prompt, /PARENT_UPGRADE_B_91827/);
  assert.ok(prompt.includes(binding.profiles[0].sections.find(s => s.id === 'acceptance').content));
  const journalPath = readdirSync(join(f.root, '__uro_context')).find(name => name.endsWith('-queue.json'));
  const journal = JSON.parse(readFileSync(join(f.root, '__uro_context', journalPath), 'utf8'));
  assert.equal(journal.schemaVersion, 3); assert.equal(journal.workflowBinding.digest, binding.digest);
});

test('campaign selects once before live iterative rounds even when the installed default changes', async t => {
  const pkg = copyNativeWorkflowPackage(t), binding = (await pkg.module('workflow-profiles.js')).loadWorkflowBinding();
  const { runCampaign } = await pkg.module('campaign.js'), received = [];
  const result = await runCampaign({ campaignId: 'workflow-rounds', target: 'adapter-target', gate: [],
    tasks: [{ task: 'First result', unitId: 'first', unitKind: 'candidate', perspective: 'minimal-change' }],
    candidateSet: true, maxRounds: 2, tokenBudget: 100, superpowers: VERIFIED_SUPERPOWERS,
    runUnit: async request => { received.push(request.workflowBinding); return { ...ready(request.runId), branch: `ccc/${request.runId}` }; },
    nextRound: () => { upgradeBundle(pkg.assetsPath); return { tasks: [{ task: 'Next result', unitId: 'second', unitKind: 'candidate', perspective: 'minimal-change' }] }; } });
  assert.equal(result.rounds.length, 2);
  assert.equal(received.length, 2);
  assert.deepEqual(received.map(b => b?.digest), [binding.digest, binding.digest]);
  assert.notEqual((await pkg.module('workflow-profiles.js')).loadWorkflowBinding().digest, binding.digest);
});

test('campaign captures mutable inherited options before unit callbacks can replace them', async t => {
  const pkg = copyNativeWorkflowPackage(t), binding = (await pkg.module('workflow-profiles.js')).loadWorkflowBinding();
  const inherited = structuredClone(binding), { runCampaign } = await pkg.module('campaign.js'), received = [];
  upgradeBundle(pkg.assetsPath);
  const newer = (await pkg.module('workflow-profiles.js')).loadWorkflowBinding();
  const result = await runCampaign({ campaignId: 'mutable-parent', target: 'adapter-target', gate: [], concurrency: 1,
    tasks: [{ task: 'First', unitId: 'first' }, { task: 'Second', unitId: 'second' }],
    superpowers: VERIFIED_SUPERPOWERS, runOptions: { workflowBinding: inherited },
    runUnit: async request => {
      received.push(structuredClone(request.workflowBinding));
      Object.assign(inherited, newer);
      Object.assign(request.workflowBinding, newer);
      return ready(request.runId);
    } });
  assert.equal(result.units.length, 2);
  assert.deepEqual(received.map(b => b.digest), [binding.digest, binding.digest]);
});

test('a single declared campaign round preserves the parent pin with ordinary option overrides', async t => {
  const pkg = copyNativeWorkflowPackage(t), binding = (await pkg.module('workflow-profiles.js')).loadWorkflowBinding();
  upgradeBundle(pkg.assetsPath);
  const { runCampaign } = await pkg.module('campaign.js'), received = [];
  const result = await runCampaign({ campaignId: 'declared-parent', target: 'adapter-target', gate: [],
    superpowers: VERIFIED_SUPERPOWERS, runOptions: { workflowBinding: binding },
    roundPlans: [{ tasks: [{ task: 'Declared task', unitId: 'declared' }], runOptions: { executorModel: 'fixture-round-model' } }],
    runUnit: async request => { received.push(request.workflowBinding); assert.equal(request.executorModel, 'fixture-round-model'); return ready(request.runId); } });
  assert.equal(result.units.length, 1);
  assert.equal(received[0].digest, binding.digest);
});

for (const timing of ['first', 'later']) for (const malformed of [false, true]) {
  test(`campaign refuses ${malformed ? 'malformed' : 'conflicting valid'} ${timing} round binding before affected launch`, async t => {
    const pkg = copyNativeWorkflowPackage(t), binding = (await pkg.module('workflow-profiles.js')).loadWorkflowBinding();
    upgradeBundle(pkg.assetsPath);
    const override = structuredClone((await pkg.module('workflow-profiles.js')).loadWorkflowBinding());
    if (malformed) override.digest = '0'.repeat(64);
    const { runCampaign } = await pkg.module('campaign.js'); let launches = 0;
    const declaration = { tasks: [{ task: 'Declared task', unitId: 'declared', unitKind: 'candidate', perspective: 'minimal-change' }],
      runOptions: { workflowBinding: override } };
    await assert.rejects(runCampaign({ campaignId: 'conflicting-round', target: 'adapter-target', gate: [],
      superpowers: VERIFIED_SUPERPOWERS, runOptions: { workflowBinding: binding },
      ...(timing === 'first' ? { roundPlans: [declaration] } : {
        tasks: [{ task: 'First', unitId: 'first', unitKind: 'candidate', perspective: 'minimal-change' }],
        candidateSet: true, maxRounds: 2, nextRound: () => declaration,
      }), runUnit: async request => { launches++; return ready(request.runId); } }), /workflow|binding|digest|conflict/i);
    assert.equal(launches, timing === 'first' ? 0 : 1);
  });
}

test('native dependent campaign children retain completed work and both-seat guidance across package upgrade', async t => {
  const f = fixture(t, 0), pkg = copyNativeWorkflowPackage(t), delivered = [];
  const binding = (await pkg.module('workflow-profiles.js')).loadWorkflowBinding();
  const { runCampaign } = await pkg.module('campaign.js');
  const result = await runCampaign({ campaignId: 'workflow-dependent', target: f.target, gate: [],
    tasks: [{ task: 'Write completed marker', unitId: 'parent', unitKind: 'node' },
      { task: 'Read completed marker and extend work', unitId: 'child', unitKind: 'node', dependsOn: 'parent' }],
    superpowers: VERIFIED_SUPERPOWERS, scratchRoot: join(f.root, 'scratch'), tokenBudget: 1000,
    runOptions: { artifactRoot: join(f.root, 'artifacts'), adapters: {
      runExecutor: r => {
        delivered.push({ snapshot: r.state.snapshot, input: r.plan });
        if (r.runId === 'parent') writeFileSync(join(r.cwd, 'completed.txt'), 'completed before upgrade');
        else writeFileSync(join(r.cwd, 'next.txt'), readFileSync(join(r.cwd, 'completed.txt'), 'utf8') + ' and extended');
        return { dialogue: planningEnvelope(r, r.action), usage };
      }, runReview: r => {
        delivered.push({ snapshot: r.state.snapshot, input: r.prompt });
        const evidence = r.state.evidence.find(e => e.id === 'requirement-briefing'); readFileSync(evidence.capturedPath);
        const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' });
        if (r.runId === 'parent') upgradeBundle(pkg.assetsPath);
        return { usage, observations: { evidence: [], receipts: [receipt] }, dialogue: planningEnvelope(r, 'approve', {
          claims: [{ id: 'briefing-requirement', kind: 'fact', text: evidence.text, evidenceIds: [evidence.id] }],
          verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read captured requirement.' }],
        }) };
      } } } });
  assert.equal(result.units.length, 2);
  for (const unit of result.units) { assert.equal(unit.facts.approved, true, unit.facts.reason); assert.equal(unit.facts.resources.providerLaunches, 2); }
  assert.equal(delivered.length, 4);
  for (const input of delivered) {
    assert.equal(input.snapshot.workflow.digest, binding.digest);
    assert.match(input.input, /BMAD/); assert.match(input.input, /Spec Kit/); assert.doesNotMatch(input.input, /PARENT_UPGRADE_B_91827/);
  }
  assert.equal(readFileSync(join(result.units[1].facts.dir, 'completed.txt'), 'utf8'), 'completed before upgrade');
  assert.equal(readFileSync(join(result.units[1].facts.dir, 'next.txt'), 'utf8'), 'completed before upgrade and extended');
  assert.equal(result.units[1].facts.baseCommit, result.units[0].resultCommit);
});

async function pendingQueue(t, historical = false) {
  const f = fixture(t, 1), pkg = copyNativeWorkflowPackage(t, { historical });
  const { runQueue: queue } = await pkg.module('queue.js'), { runPlan } = await pkg.module('plan.js');
  const out = join(f.root, 'planned'), delivered = [];
  writeFileSync(f.file, JSON.stringify([{ name: 'goal', goal: 'Preserve local login', out }]));
  const result = await queue({ file: f.file, target: f.target, tokenBudget: 1000,
    dependencies: { assertCleanTarget: async () => {}, launchPlan: ({ unit, contextRef }) => runPlan({
      goal: unit.goal, target: f.target, out, contextRef, candidates: 1, superpowers: VERIFIED_SUPERPOWERS,
      artifactRoot: join(f.root, 'artifacts'), adapters: {
        author: r => { delivered.push(r); return { plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose'), usage }; },
        reviewer: r => { delivered.push(r); return { dialogue: planningEnvelope(r, 'ask', { issues: [{ id: 'choice', title: 'Choose behavior',
          kind: 'product', needsHuman: true, status: 'open', blocking: true, claimIds: [] }] }), usage }; },
      } }) } });
  assert.equal(result.stop.kind, 'plan-not-approved', result.stop?.reason);
  assert.equal(delivered.length, 2);
  return { ...f, out, pkg, delivered, saved: readCheckpoint(out) };
}
function answerFor(f, saved = readCheckpoint(f.out)) {
  const path = join(f.root, `answer-${saved.revision}.json`);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: [{ id: saved.pending.questions[0].id, answer: 'Preserve local login.' }] })); return path;
}
function resolvedApproval(r) {
  const result = { ...planningApproval(r), usage };
  result.dialogue.issues = [{ id: 'choice', status: 'resolved', disposition: { kind: 'accepted', reason: 'Human chose local login.', claimIds: ['briefing-requirement'] } }];
  return result;
}
function rewriteCheckpoint(f, saved) {
  saved.stateDigest = checkpointDigest(saved.continuation);
  saved.artifactDigest = checkpointDigest({ runId: saved.runId, revision: saved.revision, stateDigest: saved.stateDigest,
    questions: saved.pending.questions, queue: saved.queue });
  writeCheckpointAtomic(join(f.out, 'uro-checkpoint.json'), saved);
}

test('actual child launchers reject a valid different child pin before spawning', async t => {
  const f = await pendingQueue(t), binding = f.saved.queueJournal.workflowBinding;
  upgradeBundle(f.pkg.assetsPath);
  const newer = (await f.pkg.module('workflow-profiles.js')).loadWorkflowBinding();
  const ref = f.saved.queueJournal.units[1].contextRef, old = JSON.parse(readFileSync(ref.path, 'utf8'));
  const snapshot = createSharedContext({ ...old, workflowBinding: newer, entries: old.entries.filter(e => e.kind !== 'workflow-binding') });
  const path = persistSharedContext({ directory: f.root, snapshot });
  let launches = 0;
  for (const launch of [launchLoopRun, launchLoopPlan]) await assert.rejects(launch({
    target: f.target, unit: { task: 'task', gate: 'gate', goal: 'goal', out: f.out }, workflowBinding: binding,
    contextRef: { ...ref, path, contextDigest: snapshot.digest },
  }, { runCommand: () => { launches++; throw new Error('child launched'); } }), /workflow|conflict/i);
  assert.equal(launches, 0);
});

for (const mutation of ['missing-binding', 'altered-binding', 'missing-identity', 'different-identity', 'different-valid-parent', 'different-valid-child']) {
  test(`public pending queue refuses ${mutation} before resumed provider work`, async t => {
    const f = await pendingQueue(t), saved = f.saved;
    upgradeBundle(f.pkg.assetsPath);
    const newer = (await f.pkg.module('workflow-profiles.js')).loadWorkflowBinding();
    if (mutation === 'missing-binding') delete saved.queueJournal.workflowBinding;
    if (mutation === 'altered-binding') saved.queueJournal.workflowBinding.digest = '0'.repeat(64);
    if (mutation === 'missing-identity') delete saved.queue.workflow;
    if (mutation === 'different-identity') saved.queue.workflow = workflowIdentity({ binding: newer });
    if (mutation === 'different-valid-parent') {
      saved.queueJournal.workflowBinding = newer;
      saved.queue.workflow = workflowIdentity({ binding: newer });
    }
    if (mutation === 'different-valid-parent' || mutation === 'different-valid-child') {
      const entry = saved.queueJournal.units[1], old = JSON.parse(readFileSync(entry.contextRef.path, 'utf8'));
      const snapshot = createSharedContext({ ...old, workflowBinding: newer, entries: old.entries.filter(e => e.kind !== 'workflow-binding') });
      const path = persistSharedContext({ directory: f.root, snapshot });
      entry.contextRef = { ...entry.contextRef, path, contextDigest: snapshot.digest };
    }
    rewriteCheckpoint(f, saved);
    let effects = 0;
    await assert.rejects(resumeRun({ runDirectory: f.out, decisionFile: answerFor(f, saved),
      adapters: { reviewer: r => { effects++; return resolvedApproval(r); } },
      queueDependencies: { assertCleanTarget: async () => {}, launchRun: () => { effects++; throw new Error('unexpected child'); },
        landDiff: () => { effects++; }, acceptGoal: () => { effects++; } } }), /workflow|binding|identity|conflict/i);
    assert.equal(effects, 0, 'parent semantic validation must precede native continuation');
  });
}

for (const missing of [false, true]) test(`public pending queue uses captured parent after upgrade with assets ${missing ? 'missing' : 'present'}`, async t => {
  const f = await pendingQueue(t), binding = f.saved.queueJournal.workflowBinding;
  upgradeBundle(f.pkg.assetsPath);
  assert.notEqual((await f.pkg.module('workflow-profiles.js')).loadWorkflowBinding().digest, binding.digest);
  if (missing) rmSync(f.pkg.assetsPath, { recursive: true });
  const { resumeRun: resume } = await f.pkg.module('resume.js'), inputs = [], children = [];
  const result = await resume({ runDirectory: f.out, decisionFile: answerFor(f),
    adapters: { reviewer: r => { inputs.push(r); return resolvedApproval(r); } },
    queueDependencies: { assertCleanTarget: async () => {},
      launchRun: async ({ contextRef }) => {
        const snapshot = readPlanningHandoffReference({ reference: contextRef, target: f.target });
        children.push(snapshot);
        const directory = join(f.root, 'run'); mkdirSync(directory); writeFileSync(join(directory, 'CHANGES.diff'), diff);
        return { runDirectory: directory, runId: 'execution' };
      }, readRunFacts: launch => ready(launch.runId), judgeLanding: () => ({ approved: true, usage }), landDiff: () => ({ commit: 'landed' }) } });
  assert.equal(result.queueResult.landedCount, 1, result.queueResult.stop?.reason);
  assert.equal(inputs.length, 1); assert.equal(children.length, 1);
  assert.equal(inputs[0].state.snapshot.workflow.digest, binding.digest);
  assert.equal(children[0].workflow.digest, binding.digest);
  const handoff = JSON.parse(children[0].entries.find(e => e.kind === 'planning-handoff').content);
  assert.equal(handoff.snapshot.workflow.digest, binding.digest);
  assert.equal(result.resources.providerLaunches, 3);
  assert.equal(result.queueResult.resources.providerLaunches, 6);
  assert.doesNotMatch(inputs[0].input, /PARENT_UPGRADE_B_91827/);
});

test('authentic historical queue stays explicitly unbound across public re-pause and re-save', async t => {
  const f = await pendingQueue(t, true);
  assert.equal(f.saved.queueJournal.schemaVersion, 2);
  assert.equal(f.saved.queueJournal.workflowBinding, undefined);
  assert.equal(f.saved.queue.workflow, undefined);
  const first = await resumeRun({ runDirectory: f.out, decisionFile: answerFor(f),
    adapters: { reviewer: r => ({ dialogue: planningEnvelope(r, 'ask', { issues: [{ id: 'choice2', title: 'Confirm remaining intent',
      kind: 'product', needsHuman: true, status: 'open', blocking: true, claimIds: [] }] }), usage }) } });
  assert.equal(first.reason, 'needs-decision');
  const savedAgain = readCheckpoint(f.out);
  assert.equal(savedAgain.continuation.workflow.mode, 'legacy-unbound');
  assert.equal(savedAgain.queueJournal.workflowBinding?.mode, 'legacy-unbound', 'the parent re-save must explicitly retain historical lineage');
  const inputs = [], children = [];
  const second = await resumeRun({ runDirectory: f.out, decisionFile: answerFor(f),
    adapters: { reviewer: r => { inputs.push(r); const response = resolvedApproval(r);
      response.dialogue.issues.push({ ...response.dialogue.issues[0], id: 'choice2' }); return response; } },
    queueDependencies: { assertCleanTarget: async () => {}, launchRun: async ({ contextRef }) => {
      children.push(readPlanningHandoffReference({ reference: contextRef, target: f.target }));
      const directory = join(f.root, 'run'); mkdirSync(directory); writeFileSync(join(directory, 'CHANGES.diff'), diff);
      return { runDirectory: directory, runId: 'legacy-execution' };
    }, readRunFacts: launch => ready(launch.runId), judgeLanding: () => ({ approved: true, usage }), landDiff: () => ({ commit: 'landed' }) } });
  assert.equal(second.queueResult.landedCount, 1, second.queueResult.stop?.reason);
  assert.equal(children.length, 1);
  assert.equal(readWorkflowBinding({ snapshot: children[0], allowLegacy: true }).mode, 'legacy-unbound');
  assert.doesNotMatch(inputs[0].input, /BMAD|Spec Kit/);
  assert.equal(readCheckpoint(f.out).queueJournal.workflowBinding.mode, 'legacy-unbound');
});
