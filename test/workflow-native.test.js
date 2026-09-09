import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan, runPlanCandidateSet } from '../src/plan.js';
import { runDecomposeGoal, runDecomposeProject } from '../src/decompose.js';
import { createSharedContext, extendSharedContext, renderSharedContext, persistSharedContext } from '../src/shared-context.js';
import { createPlanningHandoff, readPlanningHandoffReference, openPlanningContext } from '../src/planning-dialogue.js';
import { resolveProjectIdentity } from '../src/project-memory.js';
import { loadWorkflowBinding } from '../src/workflow-profiles.js';
import { planningEnvelope, planningApproval } from './fixtures/planning-responses.js';
import { copyNativeWorkflowPackage } from './fixtures/workflow-profile-fixture.js';
import { resumeRun } from '../src/resume.js';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkpointDigest } from '../src/checkpoint.js';

const usage = { inputTokens: 1, outputTokens: 1 };
function contextReference(snapshot, path) {
  return { schemaVersion: 1, projectId: snapshot.projectId, runId: snapshot.runId, unitId: snapshot.unitId, contextDigest: snapshot.digest, path };
}

test('validated parent reference pins planning and projects nested queue binding only once', async t => {
  const f = fixture(t), binding = loadWorkflowBinding(), pkg = copyNativeWorkflowPackage(t);
  const parent = createSharedContext({ projectId: resolveProjectIdentity({ target: f.target }).projectId, runId: 'queue', unitId: 'queue', phase: 'queue',
    sourceRevision: 'fixture', workflowBinding: binding, entries: [] });
  const path = persistSharedContext({ directory: f.root, snapshot: parent });
  upgradeBundle(pkg.assetsPath);
  const { runPlan: plan } = await pkg.module('plan.js'), delivered = [];
  const result = await plan({ ...f, contextRef: contextReference(parent, path), adapters: {
    author: r => { delivered.push(r); return { plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose') }; },
    reviewer: r => { delivered.push(r); return planningApproval(r); } } });
  assert.equal(result.approved, true, result.reason);
  for (const r of delivered) {
    assert.equal(r.state.snapshot.workflow.digest, binding.digest);
    assert.doesNotMatch(r.input, /NEW_INSTALLED_WORKFLOW_90210/);
    assert.equal(r.input.split(JSON.stringify(planningSection).slice(1, -1)).length - 1, 1, 'one applicable guidance projection');
    const queue = JSON.parse(r.state.snapshot.entries.find(e => e.kind === 'queueParent').content);
    assert.deepEqual(queue, parent, 'immutable nested source snapshot remains complete');
  }
});

test('authenticated planning handoff cannot conflict with its parent workflow', async t => {
  const f = fixture(t);
  const planned = await runPlan({ ...f, adapters: { author: r => ({ plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose') }), reviewer: planningApproval } });
  const handoff = createPlanningHandoff({ result: planned, target: f.target, directory: f.out });
  const parent = createSharedContext({ projectId: handoff.snapshot.projectId, runId: 'legacy-queue', unitId: 'unit', phase: 'queue', sourceRevision: 'fixture',
    entries: [{ id: 'planning-handoff', kind: 'planning-handoff', sourceIdentity: planned.runId, provenance: { origin: 'validated-handoff' }, status: 'required', content: JSON.stringify(handoff) }] });
  const path = persistSharedContext({ directory: f.root, snapshot: parent });
  const reference = { ...contextReference(parent, path), planningHandoff: { directory: f.out, runId: planned.runId,
    contextDigest: handoff.approval.contextDigest, artifactDigest: handoff.approval.artifactDigest, sidecarDigest: handoff.approval.sidecarDigest } };
  assert.throws(() => readPlanningHandoffReference({ reference, target: f.target }), /workflow|conflict/i);
});

test('supplied candidate session refuses a conflicting internal binding before preparation', async t => {
  const f = fixture(t), session = openPlanningContext({ requirements: f.goal, target: f.target, directory: f.out, runId: 'supplied', artifactRoot: f.artifactRoot });
  t.after(() => session.journal.close()); let launches = 0;
  await assert.rejects(runPlanCandidateSet({ ...f, count: 2, session, workflowBinding: { schemaVersion: 1, mode: 'legacy-unbound' },
    draft: r => { launches++; return { plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose') }; },
    select: r => ({ selectedCandidateId: 'candidate-1', dialogue: planningEnvelope(r, 'verify') }), review: planningApproval }), /workflow|conflict/i);
  assert.equal(launches, 0);
});

test('caller queueParent content is grounding and cannot select a historical workflow', async t => {
  const f = fixture(t);
  const result = await runPlanCandidateSet({ ...f, count: 1, context: { queueParent: { schemaVersion: 1, entries: [], workflow: { schemaVersion: 1, mode: 'legacy-unbound' } } },
    draft: r => ({ plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose') }), review: planningApproval });
  assert.equal(result.approved, true, result.reason); assert.equal(result.checkpointState.workflow.mode, 'bound');
});

test('distinct valid bound versions cannot override an authenticated parent reference', async t => {
  const f = fixture(t), binding = loadWorkflowBinding(), pkg = copyNativeWorkflowPackage(t);
  const parent = createSharedContext({ projectId: resolveProjectIdentity({ target: f.target }).projectId, runId: 'queue', unitId: 'queue', phase: 'queue', sourceRevision: 'fixture', workflowBinding: binding, entries: [] });
  const path = persistSharedContext({ directory: f.root, snapshot: parent });
  upgradeBundle(pkg.assetsPath);
  const newer = (await pkg.module('workflow-profiles.js')).loadWorkflowBinding();
  assert.notEqual(newer.digest, binding.digest);
  let launches = 0;
  await assert.rejects(runPlan({ ...f, contextRef: contextReference(parent, path), workflowBinding: newer,
    adapters: { author: r => { launches++; return { plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose') }; },
      reviewer: r => { launches++; return planningApproval(r); } } }), /workflow|conflict/);
  assert.equal(launches, 0);
});

test('historical unbound delivery is explicit without changing the captured snapshot', () => {
  const snapshot = createSharedContext({ projectId: 'p', runId: 'r', unitId: 'u', phase: 'planning', sourceRevision: 's', entries: [] });
  const before = JSON.stringify(snapshot);
  assert.match(renderSharedContext({ snapshot }), /legacy-unbound/);
  assert.equal(JSON.stringify(snapshot), before); assert.equal(snapshot.workflow, undefined);
});

test('non-snapshot caller carrier content retains original delivery bytes', () => {
  const content = 'This is a user note, not a serialized parent reference.';
  const snapshot = createSharedContext({ projectId: 'p', runId: 'r', unitId: 'u', phase: 'planning', sourceRevision: 's',
    entries: [{ id: 'queueParent', kind: 'queueParent', sourceIdentity: 'user', provenance: { origin: 'user' }, status: 'required', content }] });
  assert.match(renderSharedContext({ snapshot }), /This is a user note, not a serialized parent reference\./);
});
function executionApproval(r) {
  const evidence = r.state.evidence.find(e => e.id === 'requirement-briefing'); readFileSync(evidence.capturedPath);
  const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' });
  return { dialogue: planningEnvelope(r, 'approve', {
    claims: [{ id: 'briefing-requirement', kind: 'fact', text: 'The saved briefing was read.', evidenceIds: [evidence.id] }],
    verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read briefing.' }],
  }), observations: { evidence: [], receipts: [receipt] }, usage };
}
function resolvedApproval(r, execution = false) {
  const result = execution ? executionApproval(r) : { ...planningApproval(r), usage };
  result.dialogue.issues = [{ id: 'choice', status: 'resolved', disposition: { kind: 'accepted', reason: 'The human chose to preserve local login.', claimIds: ['briefing-requirement'] } }];
  return result;
}
function initGit(target) {
  const git = (...args) => execFileSync('git', ['-C', target, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base');
}

// This independently changes valid installed bytes and manifest, leaving the saved run intact.
function upgradeBundle(assetsPath) {
  const path = join(assetsPath, 'manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  const sha = value => createHash('sha256').update(value).digest('hex');
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  for (const profile of manifest.profiles) for (const section of profile.sections) {
    const file = join(assetsPath, section.localPath);
    const bytes = readFileSync(file, 'utf8') + '\nNEW_INSTALLED_WORKFLOW_90210\n';
    writeFileSync(file, bytes); section.sha256 = sha(bytes);
  }
  const binding = { schemaVersion: 1, mode: 'bound', profiles: manifest.profiles.map(p => ({
    id: p.id, adapterRevision: p.adapterRevision, upstream: p.upstream,
    sources: p.sources.map(({ path, sha256 }) => ({ path, sha256 })), notices: p.notices.map(({ path, sha256 }) => ({ path, sha256 })),
    sections: p.sections.map(s => ({ id: s.id, phases: s.phases, content: readFileSync(join(assetsPath, s.localPath), 'utf8'), sha256: s.sha256 })),
  })) };
  manifest.digest = sha(JSON.stringify(sort(binding))); writeFileSync(path, JSON.stringify(manifest));
}

test('direct supplied execution pins workflow before provider launch and transports it to both seats', async t => {
  const f = fixture(t), pkg = copyNativeWorkflowPackage(t), delivered = []; initGit(f.target);
  const { run } = await pkg.module('run.js');
  const result = await run({ ...f, scratchRoot: join(f.root, 'scratch'), task: f.goal, gate: [], runId: 'workflow-direct', mode: 'autonomous',
    adapters: { runExecutor: r => { delivered.push({ input: r.plan, snapshot: r.state.snapshot }); return { dialogue: planningEnvelope(r, 'propose'), usage }; },
      runReview: r => { delivered.push({ input: r.prompt, snapshot: r.state.snapshot }); return executionApproval(r); },
      runPlanCandidateSet: () => assert.fail('supplied task must not add planning') } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(delivered.length, 2);
  for (const r of delivered) {
    assert.equal(r.snapshot.workflow?.mode, 'bound');
    assert.match(r.input, /Spec Kit/); assert.match(r.input, /Preserve local login/);
    assert.doesNotMatch(r.input, /NEW_INSTALLED_WORKFLOW_90210/);
  }
  assert.deepEqual(result.checkpointState.workflow, delivered[0].snapshot.workflow);
});

// Characterizes existing evidence prerequisites: methodology delivery/checkboxes
// cannot replace actual source observation and an inspection receipt.
for (const basis of ['workflow guidance', 'checked task list']) test(`native review cannot verify a source claim from ${basis} alone`, async t => {
  const f = fixture(t), { run } = await copyNativeWorkflowPackage(t).module('run.js'); initGit(f.target);
  const result = await run({ ...f, scratchRoot: join(f.root, 'scratch'), task: f.goal, gate: [],
    runId: 'unsupported-method-claim', mode: 'autonomous', adapters: {
      runExecutor: r => ({ dialogue: planningEnvelope(r, 'propose'), usage }),
      runReview: r => ({ dialogue: planningEnvelope(r, 'approve', {
        content: basis === 'workflow guidance' ? 'BMAD and Spec Kit guidance says the source is correct.' : '[x] implementation [x] tests [x] correct source',
        claims: [{ id: 'source-claim', kind: 'fact', text: 'source.js preserves local login.',
          evidenceIds: basis === 'workflow guidance' ? ['uroboros-workflow-binding'] : [] }],
        verifications: [{ claimId: 'source-claim', result: 'supports', reason: 'The method was followed.',
          evidenceIds: basis === 'workflow guidance' ? ['uroboros-workflow-binding'] : [], inspectionReceiptIds: [] }],
      }), usage }),
    } });
  assert.equal(result.approved, false);
  assert.equal(result.dialogue.approval, null);
  assert.equal(Object.values(result.dialogue.verifications ?? {}).some(v => v.claimId === 'source-claim' && v.result === 'supports'), false);
  assert.equal(Object.values(result.dialogue.inspectionReceipts ?? {}).length, 0);
});

test('native review can verify the same source claim after actual source inspection', async t => {
  const f = fixture(t), { run } = await copyNativeWorkflowPackage(t).module('run.js'); initGit(f.target);
  let reviews = 0;
  const result = await run({ ...f, scratchRoot: join(f.root, 'scratch'), task: f.goal, gate: [],
    runId: 'observed-source-claim', mode: 'autonomous', adapters: {
      runExecutor: r => ({ dialogue: planningEnvelope(r, 'propose'), usage }),
      runReview: r => {
        if (++reviews === 1) return { dialogue: planningEnvelope(r, 'inspect', { requests: [{ path: 'source.js', line: 1, claimIds: ['source-claim'] }] }), usage };
        assert.match(r.prompt, /export const localLogin = true;/);
        const evidence = r.state.evidence.find(e => e.kind === 'code');
        const receipt = Object.values(r.state.inspectionReceipts).find(item => item.evidenceIds.includes(evidence.id));
        assert.equal(readFileSync(evidence.capturedPath, 'utf8'), 'export const localLogin = true;\n');
        return { dialogue: planningEnvelope(r, 'approve', {
          claims: [{ id: 'source-claim', kind: 'fact', text: 'source.js preserves local login.', evidenceIds: [evidence.id] }],
          verifications: [{ claimId: 'source-claim', result: 'supports', reason: 'The captured source enables local login.', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id] }],
        }), usage };
      },
    } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(reviews, 2);
  assert.ok(result.dialogue.verifications.some(v => v.claimId === 'source-claim' && v.result === 'supports'));
});

for (const historical of [false, true]) test(`public planning resume preserves ${historical ? 'authentic historical unbound' : 'captured bound'} lineage with unavailable installed bundle`, async t => {
  const f = fixture(t), pkg = copyNativeWorkflowPackage(t, { historical });
  const { runPlan: oldPlan } = await pkg.module('plan.js');
  const pending = await oldPlan({ ...f, adapters: {
    author: r => ({ plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose'), usage }),
    reviewer: r => ({ dialogue: planningEnvelope(r, 'ask', { issues: [{ id: 'choice', title: 'Choose behavior', kind: 'product', needsHuman: true, status: 'open', blocking: true, claimIds: [] }] }), usage }),
  } });
  assert.equal(pending.reason, 'needs-decision');
  const saved = JSON.parse(readFileSync(join(f.out, 'uro-checkpoint.json'), 'utf8'));
  const answer = join(f.root, 'answer.json');
  writeFileSync(answer, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: [{ id: saved.pending.questions[0].id, answer: 'Preserve local login.' }] }));
  let resume = resumeRun;
  if (!historical) {
    upgradeBundle(pkg.assetsPath);
    const profiles = await pkg.module('workflow-profiles.js');
    assert.notEqual(profiles.loadWorkflowBinding().digest, saved.continuation.workflow.digest);
    rmSync(pkg.assetsPath, { recursive: true });
    ({ resumeRun: resume } = await pkg.module('resume.js'));
  } else assert.equal(saved.continuation.dialogue.snapshot.workflow, undefined);
  const delivered = [];
  const result = await resume({ runDirectory: f.out, decisionFile: answer,
    adapters: { author: () => assert.fail('completed author must not replay'), reviewer: r => { delivered.push(r); return resolvedApproval(r); } } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.checkpointState.workflow.mode, historical ? 'legacy-unbound' : 'bound');
  assert.equal(delivered.length, 1);
  assert.equal(result.resources.providerLaunches, 3);
  assert.deepEqual(result.resources.knownUsage, { inputTokens: 3, outputTokens: 3 });
  assert.doesNotMatch(delivered[0].input, /NEW_INSTALLED_WORKFLOW_90210/);
  if (historical) assert.doesNotMatch(delivered[0].input, /BMAD|Spec Kit/);
  else assert.equal(result.checkpointState.workflow.digest, saved.continuation.workflow.digest);
});

test('missing installed native workflow refuses before preflight', async t => {
  const f = fixture(t), pkg = copyNativeWorkflowPackage(t); rmSync(pkg.assetsPath, { recursive: true });
  const { runPlan: plan } = await pkg.module('plan.js'); let launches = 0;
  await assert.rejects(plan({ ...f, superpowers: undefined, adapters: { verifySuperpowers: () => { launches++; return superpowers; },
    author: () => { launches++; }, reviewer: () => { launches++; } } }), /missing workflow/);
  assert.equal(launches, 0);
});

test('direct execution missing bundle refuses before preflight or workspace allocation', async t => {
  const f = fixture(t), pkg = copyNativeWorkflowPackage(t); rmSync(pkg.assetsPath, { recursive: true });
  const { run } = await pkg.module('run.js'); let launches = 0;
  await assert.rejects(run({ ...f, superpowers: undefined, scratchRoot: join(f.root, 'scratch'), task: f.goal, gate: [], runId: 'missing-workflow',
    adapters: { verifySuperpowers: () => { launches++; return superpowers; }, isolate: () => { launches++; throw Error('unexpected isolate'); },
      runExecutor: () => { launches++; }, runReview: () => { launches++; } } }), /missing workflow/);
  assert.equal(launches, 0);
});

for (const tier of ['project', 'goal', 'execution']) test(`public ${tier} resume uses captured guidance after valid installed upgrade`, async t => {
  const f = fixture(t), pkg = copyNativeWorkflowPackage(t); let authors = 0;
  const ask = r => ({ dialogue: planningEnvelope(r, 'ask', { issues: [{ id: 'choice', title: 'Choose behavior', kind: 'product', needsHuman: true, status: 'open', blocking: true, claimIds: [] }] }), usage });
  let pending;
  if (tier === 'execution') {
    initGit(f.target); const { run } = await pkg.module('run.js');
    pending = await run({ ...f, task: f.goal, gate: [], scratchRoot: join(f.root, 'scratch'), runId: 'resume-method', mode: 'autonomous',
      adapters: { runExecutor: r => { authors++; return { dialogue: planningEnvelope(r, 'propose'), usage }; }, runReview: ask } });
  } else {
    const goalDir = join(f.root, 'goals', 'G1-first'); mkdirSync(goalDir, { recursive: true });
    const goalSpecPath = join(goalDir, 'spec.md'), project = join(f.root, 'project.md');
    writeFileSync(goalSpecPath, f.goal); writeFileSync(project, f.goal);
    const proposal = tier === 'goal'
      ? '<TASKS_JSON>[{"id":"T1","name":"T1-first","dependsOn":[],"gate":[]}]</TASKS_JSON><TASKS_MD>## T1: first\nTitle: first\nRequired behavior: preserve.\nTest requirements: tests.\n</TASKS_MD>'
      : '<GOALS_JSON>[{"id":"G1","slug":"first","statement":"Preserve behavior","capability":"first","dependsOn":[],"rationale":"MVP"}]</GOALS_JSON><GOALS_MD>## G1: first\nA usable increment\n</GOALS_MD>';
    const methods = await pkg.module('decompose.js');
    pending = await methods[tier === 'goal' ? 'runDecomposeGoal' : 'runDecomposeProject']({ ...f, goalSpecPath, project,
      adapters: { author: r => { authors++; return { answer: proposal, dialogue: planningEnvelope(r, 'propose'), usage }; }, reviewer: ask } });
  }
  assert.equal(tier === 'execution' ? pending.nextAction : pending.reason, 'needs-decision', pending.reason);
  const directory = pending.dir ?? pending.out, saved = JSON.parse(readFileSync(join(directory, 'uro-checkpoint.json'), 'utf8'));
  upgradeBundle(pkg.assetsPath);
  assert.notEqual((await pkg.module('workflow-profiles.js')).loadWorkflowBinding().digest, saved.continuation.workflow.digest);
  const answer = join(f.root, 'answer.json'); writeFileSync(answer, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: [{ id: saved.pending.questions[0].id, answer: 'Preserve local login.' }] }));
  const delivered = [], { resumeRun: resume } = await pkg.module('resume.js');
  const review = r => { delivered.push({ input: r.input ?? r.prompt, snapshot: r.state.snapshot }); return resolvedApproval(r, tier === 'execution'); };
  const result = await resume({ runDirectory: directory, decisionFile: answer,
    adapters: { author: () => assert.fail('completed author cannot replay'), runExecutor: () => assert.fail('completed execution cannot replay'), reviewer: review, runReview: review } });
  assert.equal(result.approved, true, result.reason); assert.equal(authors, 1); assert.equal(delivered.length, 1);
  assert.equal(result.checkpointState.workflow.digest, saved.continuation.workflow.digest);
  assert.equal(result.resources.providerLaunches, 3);
  assert.equal(result.resources.knownUsage.inputTokens, 3); assert.equal(result.resources.knownUsage.outputTokens, 3);
  assert.match(delivered[0].input, /Spec Kit/); assert.doesNotMatch(delivered[0].input, /NEW_INSTALLED_WORKFLOW_90210/);
});

for (const corruption of ['marker', 'entry', 'required', 'content', 'all']) test(`public bound resume refuses altered captured ${corruption} before launch`, async t => {
  const f = fixture(t);
  await runPlan({ ...f, adapters: { author: r => ({ plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose'), usage }),
    reviewer: r => ({ dialogue: planningEnvelope(r, 'ask', { issues: [{ id: 'choice', title: 'Choose behavior', kind: 'product', needsHuman: true, status: 'open', blocking: true, claimIds: [] }] }), usage }) } });
  const path = join(f.out, 'uro-checkpoint.json'), saved = JSON.parse(readFileSync(path, 'utf8')), snapshot = saved.continuation.dialogue.snapshot;
  if (['marker', 'all'].includes(corruption)) delete snapshot.workflow;
  if (['entry', 'all'].includes(corruption)) snapshot.entries = snapshot.entries.filter(entry => entry.kind !== 'workflow-binding');
  if (corruption === 'required') snapshot.entries.find(entry => entry.kind === 'workflow-binding').status = 'historical';
  if (corruption === 'content') snapshot.entries.find(entry => entry.kind === 'workflow-binding').content += 'corrupt';
  saved.stateDigest = checkpointDigest(saved.continuation);
  saved.artifactDigest = checkpointDigest({ runId: saved.runId, revision: saved.revision, stateDigest: saved.stateDigest, questions: saved.pending.questions, queue: saved.queue });
  const { checksum, ...body } = saved; saved.checksum = checkpointDigest(body); writeFileSync(path, JSON.stringify(saved));
  const answer = join(f.root, 'answer.json'); writeFileSync(answer, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: [{ id: saved.pending.questions[0].id, answer: 'Preserve local login.' }] }));
  let launches = 0;
  await assert.rejects(resumeRun({ runDirectory: f.out, decisionFile: answer, adapters: { reviewer: r => { launches++; return resolvedApproval(r); } } }), /workflow|journal|context/i);
  assert.equal(launches, 0);
});

for (const historical of [false, true]) test(`retained execution planning execution keeps ${historical ? 'authentic historical' : 'bound'} lineage and completed work`, async t => {
  const f = fixture(t), pkg = copyNativeWorkflowPackage(t, { historical }); initGit(f.target);
  const { run } = await pkg.module('run.js'); let coding = 0, reviews = 0; const delivered = [];
  const adapters = {
    runExecutor: r => { coding++; delivered.push({ input: r.plan, snapshot: r.state.snapshot });
      writeFileSync(join(r.cwd, coding === 1 ? 'completed.txt' : 'remaining.txt'), 'done');
      if (coding > 1) assert.equal(readFileSync(join(r.cwd, 'completed.txt'), 'utf8'), 'done');
      return { dialogue: planningEnvelope(r, r.action), usage }; },
    runReview: r => { delivered.push({ input: r.prompt, snapshot: r.state.snapshot }); reviews++;
      if (reviews === 1 && historical) return { dialogue: planningEnvelope(r, 'ask', { issues: [{ id: 'choice', title: 'Choose behavior', kind: 'product', needsHuman: true, status: 'open', blocking: true, claimIds: [] }] }), usage };
      if (reviews === (historical ? 2 : 1)) {
        if (!historical) upgradeBundle(pkg.assetsPath);
        return { dialogue: planningEnvelope(r, 'replan', { issues: [{ id: 'R1', title: 'Remaining work', status: 'open', blocking: true }],
          replan: { issueId: 'R1', evidenceIds: ['requirement-briefing'], novelty: 'completed.txt is done; only remaining.txt remains.' } }), usage };
      }
      return executionApproval(r); },
    draftPlanCandidate: r => { delivered.push({ input: r.input, snapshot: r.state.snapshot }); return { plan: 'Only finish remaining.txt', gate: [], dialogue: planningEnvelope(r, 'propose'), usage }; },
    reviewPlanCandidate: r => { delivered.push({ input: r.input, snapshot: r.state.snapshot }); return { ...planningApproval(r), usage }; },
  };
  let result = await run({ ...f, task: f.goal, gate: [], scratchRoot: join(f.root, 'scratch'), runId: 'retained-method', mode: 'autonomous', pivotCandidates: 1, adapters });
  if (historical) {
    assert.equal(result.nextAction, 'needs-decision', result.reason);
    const saved = JSON.parse(readFileSync(join(result.dir, 'uro-checkpoint.json'), 'utf8'));
    assert.equal(saved.continuation.dialogue.snapshot.workflow, undefined);
    const answer = join(f.root, 'answer.json'); writeFileSync(answer, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
      answers: [{ id: saved.pending.questions[0].id, answer: 'Preserve local login.' }] }));
    result = await resumeRun({ runDirectory: result.dir, decisionFile: answer, adapters });
  }
  assert.equal(result.approved, true, result.reason); assert.equal(coding, 2);
  assert.equal(readFileSync(join(result.dir, 'completed.txt'), 'utf8'), 'done');
  assert.equal(result.resources.providerLaunches, historical ? 7 : 6);
  assert.equal(result.resources.knownUsage.inputTokens, historical ? 7 : 6);
  assert.equal(result.resources.knownUsage.outputTokens, historical ? 7 : 6);
  for (const r of delivered) {
    assert.doesNotMatch(r.input, /NEW_INSTALLED_WORKFLOW_90210/);
    if (historical) assert.doesNotMatch(r.input, /BMAD|Spec Kit/);
    else assert.equal(r.snapshot.workflow.digest, delivered[0].snapshot.workflow.digest);
  }
  assert.equal(result.checkpointState.workflow.mode, historical ? 'legacy-unbound' : 'bound');
});

test('bound continuation cannot drop its independent workflow identity while retaining journal and captured snapshot', async t => {
  const f = fixture(t);
  const pending = await runPlan({ ...f, adapters: { author: r => ({ plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose'), usage }),
    reviewer: r => ({ dialogue: planningEnvelope(r, 'ask', { issues: [{ id: 'choice', title: 'Choose behavior', kind: 'product', needsHuman: true, status: 'open', blocking: true, claimIds: [] }] }), usage }) } });
  const path = join(f.out, 'uro-checkpoint.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
  delete saved.continuation.workflow; saved.stateDigest = checkpointDigest(saved.continuation);
  saved.artifactDigest = checkpointDigest({ runId: saved.runId, revision: saved.revision, stateDigest: saved.stateDigest,
    questions: saved.pending.questions, queue: saved.queue });
  const { checksum, ...withoutIntegrity } = saved;
  // Public checkpoint uses the same existing outer integrity calculation; inner journal remains untouched.
  saved.checksum = checkpointDigest(withoutIntegrity);
  writeFileSync(path, JSON.stringify(saved));
  const answer = join(f.root, 'answer.json'); writeFileSync(answer, JSON.stringify({ schemaVersion: 1, runId: saved.runId, artifactDigest: saved.artifactDigest,
    answers: [{ id: saved.pending.questions[0].id, answer: 'Preserve local login.' }] }));
  let launches = 0;
  await assert.rejects(resumeRun({ runDirectory: pending.out, decisionFile: answer, adapters: {
    author: () => { launches++; }, reviewer: r => { launches++; return planningApproval(r); },
  } }), /workflow/);
  assert.equal(launches, 0, 'independent identity is validated before provider launch');
});

const superpowers = { seats: { claude: { verified: true }, codex: { verified: true } } };
function fixture(t) {
  const scratchBase = process.platform === 'win32' ? 'C:/ccc-test' : tmpdir();
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(join(scratchBase, 'uro-workflow-native-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'repo'); mkdirSync(target);
  writeFileSync(join(target, 'source.js'), 'export const localLogin = true;\n');
  return { root, target, out: join(root, 'out'), artifactRoot: join(root, 'artifacts'), goal: 'Preserve local login', superpowers };
}
const planningSection = readFileSync(new URL('../src/workflow-profiles/adapted/bmad-planning.md', import.meta.url), 'utf8');
function assertDelivery(delivered) {
  assert.ok(delivered.length >= 2);
  assert.equal(new Set(delivered.map(r => r.state.snapshot.workflow?.digest)).size, 1);
  for (const r of delivered) {
    assert.equal(r.state.snapshot.workflow?.mode, 'bound');
    assert.match(r.input, /BMAD/); assert.match(r.input, /Spec Kit/);
    assert.ok(r.input.includes(JSON.stringify(planningSection).slice(1, -1)), 'actual input includes captured adapted planning section');
    assert.match(r.input, /Preserve local login/);
    assert.doesNotMatch(r.input, /BMAD adapted execution/);
  }
}

// Removing native initialization or dropping request.input fails these real provider-boundary assertions.
for (const count of [1, 2]) test(`native candidate count ${count} delivers pinned planning guidance to draft, selector and review`, async t => {
  const f = fixture(t), delivered = [];
  const capture = handler => r => { delivered.push(r); return handler(r); };
  const result = await runPlanCandidateSet({ ...f, count, directory: f.out,
    draft: capture(r => ({ plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose') })),
    select: capture(r => ({ selectedCandidateId: 'candidate-1', dialogue: planningEnvelope(r, 'verify') })),
    review: capture(planningApproval) });
  assert.equal(result.approved, true, result.reason);
  assertDelivery(delivered);
  assert.equal(result.resources.providerLaunches, count === 1 ? 2 : 4);
  assert.deepEqual(result.checkpointState.workflow, result.dialogue.snapshot.workflow);
});

test('ordinary planning Q&A keeps guidance and evidence without an extra review call', async t => {
  const f = fixture(t), delivered = []; let authors = 0, reviews = 0;
  const result = await runPlan({ ...f, rounds: 1, adapters: {
    author: r => { delivered.push(r); return ++authors === 1
      ? { plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose') }
      : { dialogue: planningEnvelope(r, 'answer', { next: { seat: 'codex', action: 'verify', reason: 'Assess explanation' } }) }; },
    reviewer: r => { delivered.push(r); return ++reviews === 1
      ? { dialogue: planningEnvelope(r, 'ask', { next: { seat: 'claude', action: 'answer', reason: 'Explain local login' } }) }
      : planningApproval(r); },
  } });
  assert.equal(result.approved, true, result.reason); assertDelivery(delivered);
  assert.equal(result.resources.providerLaunches, 4); assert.equal(result.rounds, 1);
});

for (const tier of ['project', 'goal']) test(`native ${tier} decomposition delivers planning guidance to both seats`, async t => {
  const f = fixture(t), delivered = [];
  const goalDir = join(f.root, 'hierarchy', 'goals', 'G1-demo'); mkdirSync(goalDir, { recursive: true });
  const goalSpecPath = join(goalDir, 'spec.md'), project = join(f.root, 'project.md');
  writeFileSync(goalSpecPath, f.goal); writeFileSync(project, f.goal);
  const proposal = tier === 'goal'
    ? '<TASKS_JSON>[{"id":"T1","name":"T1-first","dependsOn":[],"gate":[]}]</TASKS_JSON><TASKS_MD>## T1: first\nTitle: first\nRequired behavior: preserve.\nTest requirements: tests.\n</TASKS_MD>'
    : '<GOALS_JSON>[{"id":"G1","slug":"first","statement":"Preserve behavior","capability":"first","dependsOn":[],"rationale":"MVP"}]</GOALS_JSON><GOALS_MD>## G1: first\nA usable increment\n</GOALS_MD>';
  const result = await (tier === 'goal' ? runDecomposeGoal : runDecomposeProject)({ ...f, goalSpecPath, project,
    adapters: { author: r => { delivered.push(r); return { answer: proposal, dialogue: planningEnvelope(r, 'propose') }; },
      reviewer: r => { delivered.push(r); return planningApproval(r); } } });
  assert.equal(result.approved, true, result.reason); assertDelivery(delivered);
});

test('shared workflow capture is immutable across extensions and only applicable text is projected', () => {
  const binding = loadWorkflowBinding();
  const snapshot = createSharedContext({ projectId: 'p', runId: 'r', unitId: 'u', phase: 'planning', sourceRevision: 's', entries: [], workflowBinding: binding });
  assert.equal(snapshot.workflow?.digest, binding.digest);
  const extended = extendSharedContext({ snapshot, phase: 'execution' });
  assert.equal(extended.workflow.digest, binding.digest);
  const entry = extended.entries.find(e => e.kind === 'workflow-binding');
  assert.deepEqual(JSON.parse(entry.content), binding);
  const input = renderSharedContext({ snapshot: extended });
  assert.match(input, /delivery projection/);
  assert.ok(!input.includes(JSON.stringify(planningSection).slice(1, -1)));
  assert.deepEqual(JSON.parse(entry.content), binding, 'rendering never mutates captured bytes');
  assert.throws(() => extendSharedContext({ snapshot, entries: [{ ...entry, id: 'replacement' }] }), /workflow|reserved/i);
});

for (const key of ['workflow', 'workflowBinding', 'uroboros-workflow-binding', 'requirements', 'target']) test(`caller ${key} cannot replace native authority`, async t => {
  const f = fixture(t); let launches = 0;
  await assert.rejects(runPlanCandidateSet({ ...f, count: 1, context: { [key]: { mode: 'legacy-unbound' } },
    draft: r => { launches++; return { plan: 'Keep local login', gate: [], dialogue: planningEnvelope(r, 'propose') }; },
    review: r => { launches++; return planningApproval(r); } }), /reserved|context|requirements|target/i);
  assert.equal(launches, 0);
});
