import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan, runPlanCandidateSet, assertCurrentPlanApproval } from '../src/plan.js';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { resumeRun } from '../src/resume.js';
import { openProjectMemory, resolveProjectIdentity } from '../src/project-memory.js';
import { captureEvidence } from '../src/context-evidence.js';
import { assertPlanningSidecars, runPlanningDialogue } from '../src/planning-dialogue.js';
import { contextDigest, renderSharedContext } from '../src/shared-context.js';

const superpowers = { seats: { claude: { verified: true }, codex: { verified: true } } };

for (const scenario of [
  { name: 'first draft', count: 2, limit: 10, expected: [] },
  { name: 'single-candidate review', count: 1, limit: 12, expected: ['draft'] },
  { name: 'selector', count: 2, limit: 14, expected: ['draft', 'draft'] },
  { name: 'selected review', count: 2, limit: 16, expected: ['draft', 'draft', 'selector'] },
  { name: 'protocol repair', count: 2, limit: 12, malformed: 'protocol', expected: ['draft'] },
  { name: 'artifact repair', count: 2, limit: 14, malformed: 'artifact', expected: ['draft', 'draft'] },
  { name: 'unknown observed usage', count: 2, limit: 100, unknown: true, expected: ['draft'] },
]) test(`fresh planning budget pauses before ${scenario.name} without trying another effect`, async t => {
  const opts = fixture(t), launches = [];
  const resourceBudget = { tokenBudget: scenario.limit,
    prior: { knownUsage: { inputTokens: 8, outputTokens: 2 }, usageUnknown: false, providerLaunches: 3 } };
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: scenario.count, mode: 'fresh', resourceBudget,
    draft: r => {
      launches.push(r.action === 'repair' ? 'repair' : 'draft');
      const usage = scenario.unknown ? null : { inputTokens: 1, outputTokens: 1 };
      if (launches.length === 1 && scenario.malformed === 'protocol') return { content: 'unreadable', usage };
      if (launches.length === 1 && scenario.malformed === 'artifact') return { answer: '<PLAN_MD>Missing gate</PLAN_MD>', dialogue: reply(r, 'propose'), usage };
      return { plan: r.candidateId, gate: [], dialogue: reply(r, 'propose'), usage };
    },
    select: r => { launches.push('selector'); return { selectedCandidateId: 'candidate-1', dialogue: reply(r, 'verify'), usage: { inputTokens: 1, outputTokens: 1 } }; },
    review: r => { launches.push('review'); return approve(r); },
  });
  assert.equal(result.approved, false);
  assert.equal(result.action, 'paused', result.reason);
  assert.match(result.reason, /budget|unknown usage/);
  assert.deepEqual(launches, scenario.expected);
  assert.deepEqual(result.checkpointState.resourceBudget, resourceBudget);
  assert.equal(result.resources.providerLaunches, launches.length);
  if (scenario.malformed === 'artifact') {
    assert.equal(result.checkpointState.artifactRepairs, 0, 'a denied repair consumes no repair launch');
    assert.equal(result.checkpointState.preparationState.proposalCycles, 1, 'the original allocated candidate cycle remains retained');
  }
  const events = readFileSync(join(opts.out, '__uro_dialogue', 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.type === 'budget-check' && e.decision.allowed === false));
  if (scenario.malformed) assert.deepEqual(events.findLast(e => e.type === 'budget-check').nextAction,
    { seat: 'claude', action: scenario.malformed === 'protocol' ? 'repair' : 'propose' });
  assert.ok(result.checkpointState.planningArtifacts, 'paused preparation retains exact sidecar provenance');
});

test('fresh planning budget keeps prior consumption separate from live preparation and review accounting', async t => {
  const opts = fixture(t), observed = [], launches = [];
  const resourceBudget = { tokenBudget: 100, prior: { knownUsage: { inputTokens: 8, outputTokens: 2 }, usageUnknown: false, providerLaunches: 3 } };
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2, resourceBudget,
    budget: ({ account }) => { observed.push(account.providerLaunches); return { allowed: true }; },
    draft: r => { launches.push('draft'); return { plan: r.candidateId, gate: [], dialogue: reply(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } }; },
    select: r => { launches.push('selector'); return { selectedCandidateId: 'candidate-1', dialogue: reply(r, 'verify'), usage: { inputTokens: 1, outputTokens: 1 } }; },
    review: r => { launches.push('review'); return approve(r); },
  });
  assert.equal(result.approved, true, result.reason);
  assert.deepEqual(launches, ['draft', 'draft', 'selector', 'review']);
  assert.deepEqual(observed, [0, 1, 2, 3], 'the live phase account never resets and never includes prior consumption twice');
  assert.deepEqual(result.resources.knownUsage, { inputTokens: 6, outputTokens: 4 });
  assert.deepEqual(result.checkpointState.resourceBudget, resourceBudget);
});

test('a failed planning budget callback pauses without trying another candidate', async t => {
  const opts = fixture(t); let guards = 0, launches = 0;
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    budget: () => { if (++guards === 1) throw new Error('budget authority unavailable'); return { allowed: true }; },
    draft: r => { launches++; return { plan: r.candidateId, gate: [], dialogue: reply(r, 'propose') }; }, review: approve,
  });
  assert.equal(result.action, 'paused', result.reason);
  assert.match(result.reason, /budget authority unavailable/);
  assert.equal(guards, 1);
  assert.equal(launches, 0);
});

for (const change of [
  { tokenBudget: Infinity }, { tokenBudget: -1 },
  { prior: { knownUsage: { inputTokens: -1, outputTokens: 0 }, usageUnknown: false, providerLaunches: 0 } },
  { prior: { knownUsage: { inputTokens: NaN, outputTokens: 0 }, usageUnknown: false, providerLaunches: 0 } },
  { prior: { knownUsage: { inputTokens: 0, outputTokens: 0 }, usageUnknown: false, providerLaunches: -1 } },
]) test('invalid planning resource accounting cannot authorize a provider launch', async t => {
  const opts = fixture(t); let launches = 0;
  await assert.rejects(runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    resourceBudget: { tokenBudget: 100, prior: { knownUsage: { inputTokens: 0, outputTokens: 0 }, usageUnknown: false, providerLaunches: 0 }, ...change },
    draft: () => { launches++; },
  }), /invalid saved planning resource budget/);
  assert.equal(launches, 0);
});

test('same-phase planning continuation refuses a raised saved budget before any new provider', async t => {
  const opts = fixture(t);
  const resourceBudget = { tokenBudget: 100, prior: { knownUsage: { inputTokens: 8, outputTokens: 2 }, usageUnknown: false, providerLaunches: 3 } };
  const pending = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 1, resourceBudget,
    draft: r => ({ plan: 'Preserve local login', gate: [], dialogue: reply(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 } }),
    review: r => ({ dialogue: reply(r, 'decide', { issues: [{ id: 'I1', title: 'Unresolved technical issue', status: 'disputed', blocking: true, claimIds: [] }] }), usage: { inputTokens: 1, outputTokens: 1 } }),
  });
  assert.equal(pending.action, 'needs-decision');
  await assert.rejects(runPlanningDialogue({ requirements: opts.goal, target: opts.target, directory: opts.out,
    runId: pending.runId, continuation: pending.checkpointState, resourceBudget: { ...resourceBudget, tokenBudget: 200 },
    seats: { author: () => assert.fail('no new launch'), reviewCodex: () => assert.fail('no new launch') }, strategy: {},
  }), /saved planning resource budget cannot change/);
});

test('budget pause after malformed preparation retains the current discovered material identity', async t => {
  const opts = fixture(t);
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    budget: ({ account }) => ({ allowed: account.providerLaunches === 0, reason: 'budget-exhausted' }),
    draft: r => {
      const evidence = captureEvidence({ projectId: r.state.projectId, root: opts.target, directory: join(opts.out, '__uro_evidence'),
        evidence: { id: 'discovered-before-budget', kind: 'code', projectId: r.state.projectId, claimIds: [],
          locator: { path: 'source.js', line: 1 }, sourceIdentity: r.state.snapshot.sourceRevision } });
      return { content: 'malformed preparation with real source observation', observations: { evidence: [evidence],
        receipts: [createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' })] } };
    },
  });
  assert.equal(result.action, 'paused');
  assert.equal(result.checkpointState.preparationState.snapshot.digest, result.sharedContext.digest);
  assert.equal(result.resources.providerLaunches, 1);
  assert.ok(result.sharedContext.evidence.some(e => e.id === 'discovered-before-budget'));
});

for (const staleRepair of [false, true]) test(`protocol repair prepares current discovered context and preserves original provenance (${staleRepair})`, async t => {
  const opts = fixture(t); let original, repaired, malformed, firstCandidateCalls = 0;
  const readJournal = () => readFileSync(join(opts.out, '__uro_dialogue', 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    draft: r => {
      if (r.candidateId !== 'candidate-1') return { plan: r.candidateId, gate: [], dialogue: reply(r, 'propose') };
      firstCandidateCalls++;
      if (firstCandidateCalls === 1) {
        original = readJournal().find(event => event.type === 'prepare' && event.operationId === r.operationId);
        const evidence = captureEvidence({ projectId: r.state.projectId, root: opts.target, directory: join(opts.out, '__uro_evidence'),
          evidence: { id: 'repair-discovery', kind: 'code', projectId: r.state.projectId, claimIds: [],
            locator: { path: 'source.js', line: 1 }, sourceIdentity: r.state.snapshot.sourceRevision } });
        malformed = { content: 'Malformed original response: preserve this proposal substance.', observations: { evidence: [evidence],
          receipts: [createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' })] } };
        return malformed;
      }
      assert.equal(firstCandidateCalls, 2, 'one protocol repair allowance only');
      assert.equal(r.action, 'repair');
      repaired = readJournal().find(event => event.type === 'prepare' && event.operationId === r.operationId);
      assert.notEqual(repaired.operationId, original.operationId);
      assert.notEqual(r.state.snapshot.digest, original.contextDigest);
      assert.equal(r.state.snapshot.parentDigest, original.contextDigest);
      assert.ok(r.state.snapshot.evidence.some(e => e.id === 'repair-discovery'));
      assert.ok(r.input.includes(renderSharedContext({ snapshot: r.state.snapshot })));
      assert.equal(repaired.input, r.input);
      assert.equal(repaired.contextDigest, r.state.snapshot.digest);
      assert.ok(repaired.evidenceIds.includes('repair-discovery'));
      assert.equal(repaired.artifactDigest, original.artifactDigest);
      assert.deepEqual(repaired.repairOf, { operationId: original.operationId,
        artifactDigest: original.artifactDigest, contextDigest: original.contextDigest });
      assert.ok(r.input.includes(JSON.stringify(repaired.repairOf)));
      assert.ok(r.input.includes(JSON.stringify(malformed)));
      const persisted = JSON.parse(readFileSync(join(opts.out, '__uro_context', `${r.state.snapshot.id}.json`), 'utf8'));
      assert.equal(persisted.digest, repaired.contextDigest);
      return { plan: 'candidate-1', gate: [], dialogue: reply(r, 'propose', staleRepair ? { contextDigest: original.contextDigest } : {}) };
    },
    select: r => ({ selectedCandidateId: 'candidate-1', dialogue: reply(r, 'verify') }), review: approve,
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.selected.id, staleRepair ? 'candidate-2' : 'candidate-1');
  assert.equal(result.resources.providerLaunches, staleRepair ? 4 : 5);
  assert.equal(result.resources.repairLaunches, 1);
  assert.equal(result.dialogue.artifactRepairs, 0);
  assert.equal(result.rounds, 1);
  assert.equal(firstCandidateCalls, 2);
  t.diagnostic(JSON.stringify({ originalOperationId: original.operationId, originalContextDigest: original.contextDigest,
    repairOperationId: repaired.operationId, repairContextDigest: repaired.contextDigest, staleRepair }));
  const events = readJournal();
  assert.deepEqual(events.find(event => event.type === 'prepare' && event.operationId === original.operationId), original);
  assert.deepEqual(events.find(event => event.type === 'complete' && event.operationId === original.operationId).result, malformed);
  assert.equal(result.candidates[0].gateResult.passed, !staleRepair);
  if (staleRepair) {
    assert.match(result.candidates[0].response.error, /stale/);
    assert.equal(events.some(event => event.type === 'candidate-artifact' && event.operationId === repaired.operationId), false);
  }
});

for (const resolveBlocker of [false, true]) test(`selected alternative retains its blocker and requires explicit disposition (${resolveBlocker})`, async t => {
  const opts = fixture(t); let reviewed = false;
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    draft: r => ({ plan: r.candidateId, gate: [], dialogue: reply(r, 'propose', {
      issues: [{ id: `${r.candidateId}-blocker`, title: 'Unresolved source concern', blocking: true, status: 'open', claimIds: [] }],
      next: { seat: 'codex', action: 'verify', reason: 'Resolve the retained blocker before sign-off' },
    }) }),
    select: r => ({ selectedCandidateId: 'candidate-1', dialogue: reply(r, 'verify') }),
    review: r => {
      reviewed = true;
      assert.equal(r.state.issues['candidate-1-blocker']?.status, 'open');
      assert.equal(r.state.issues['candidate-2-blocker'], undefined, 'rejected concerns are historical, not selected live blockers');
      assert.match(r.input, /candidate-2-blocker/);
      const response = approve(r);
      if (resolveBlocker) response.dialogue.issues = [{ id: 'candidate-1-blocker', status: 'resolved',
        disposition: { kind: 'accepted', reason: 'The briefing resolves this concern.', claimIds: ['briefing-requirement'] } }];
      return response;
    },
  });
  assert.equal(reviewed, true);
  assert.equal(result.approved, resolveBlocker, result.reason);
  assert.equal(result.dialogue.issues['candidate-1-blocker'].status, resolveBlocker ? 'resolved' : 'open');
});

test('selected preparation keeps authenticated observations and material evidence before review', async t => {
  const opts = fixture(t); let captured, preparedId;
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    draft: r => {
      if (r.candidateId !== 'candidate-1') return { plan: r.candidateId, gate: [], dialogue: reply(r, 'propose') };
      captured = captureEvidence({ projectId: r.state.projectId, root: opts.target, directory: join(opts.out, '__uro_evidence'),
        evidence: { id: 'candidate-source', kind: 'code', projectId: r.state.projectId, claimIds: ['candidate-fact'],
          locator: { path: 'source.js', line: 1 }, sourceIdentity: r.state.snapshot.sourceRevision } });
      const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [captured], inspected: true, result: 'read' });
      preparedId = r.operationId;
      return { plan: 'Keep login', gate: [], observations: { evidence: [captured], receipts: [receipt] },
        dialogue: reply(r, 'propose', { claims: [{ id: 'candidate-fact', kind: 'fact', text: 'Local login is enabled.', evidenceIds: [captured.id] }],
          memoryProposals: [{ id: 'candidate-memory', kind: 'lesson', content: 'Preserve local login', claimIds: ['candidate-fact'], tags: [] }] }) };
    }, select: r => ({ selectedCandidateId: 'candidate-1', dialogue: reply(r, 'verify') }),
    review: r => {
      assert.ok(r.state.snapshot.evidence.some(e => e.id === captured.id));
      assert.equal(r.state.operations[preparedId].status, 'completed');
      assert.equal(r.state.claims['candidate-fact'].sender, 'claude');
      assert.notEqual(r.state.claims['candidate-fact'].contextDigest, r.state.snapshot.digest, 'selection must not relabel an old premise as currently verified');
      assert.equal(r.state.memoryProposals[0].id, 'candidate-memory');
      assert.match(r.input, /export const localLogin = true/);
      return approve(r);
    },
  });
  assert.equal(result.approved, true, result.reason);
});

for (const timing of ['pre-existing', 'during-provider']) test(`unrelated ${timing} sidecars are rejected before approval`, async t => {
  const opts = fixture(t); let reviews = 0;
  const place = () => { mkdirSync(join(opts.out, '__uro_context'), { recursive: true });
    writeFileSync(join(opts.out, '__uro_context', 'unrelated.js'), 'unrelated user content'); };
  if (timing === 'pre-existing') place();
  await assert.rejects(runPlan({ ...opts, adapters: {
    author: r => { if (timing === 'during-provider') place(); return { plan: 'Keep login', gate: [], dialogue: reply(r, 'propose') }; },
    reviewer: r => { reviews++; return approve(r); },
  } }), /unexpected|unregistered|sidecar/);
  assert.equal(reviews, 0);
  assert.equal(existsSync(join(opts.out, 'plan.md')), false);
  assert.equal(readFileSync(join(opts.out, '__uro_context', 'unrelated.js'), 'utf8'), 'unrelated user content');
});

test('registered captured sidecars remain exactly allowable and intact after normal approval', async t => {
  const opts = fixture(t);
  const result = await runPlan({ ...opts, adapters: { author: r => ({ plan: 'Keep login', gate: [], dialogue: reply(r, 'propose') }), reviewer: approve } });
  const paths = assertPlanningSidecars({ directory: opts.out, runId: result.runId, approval: result.approval, manifest: result.planningArtifacts });
  assert.equal(paths.length, 4, 'one context, one briefing capture and both journals');
  assert.ok(paths.some(path => path.endsWith('journal-tail.jsonl')));
  assert.ok(paths.some(path => path === result.sharedContext.evidence[0].capturedPath));
  writeFileSync(result.sharedContext.evidence[0].capturedPath, 'tampered');
  assert.throws(() => assertPlanningSidecars({ directory: opts.out, runId: result.runId, approval: result.approval, manifest: result.planningArtifacts }), /manifest changed/);
});

test('sidecar provenance rejects symlink roots and escaping registered paths', async t => {
  const opts = fixture(t), outside = join(opts.artifactRoot, 'outside');
  mkdirSync(outside, { recursive: true }); mkdirSync(opts.out);
  symlinkSync(outside, join(opts.out, '__uro_context'), 'junction');
  await assert.rejects(runPlan({ ...opts, adapters: { author: () => assert.fail('symlink rejected before launch') } }), /symbolic link/);
  const clean = fixture(t);
  const result = await runPlan({ ...clean, adapters: { author: r => ({ plan: 'Keep login', gate: [], dialogue: reply(r, 'propose') }), reviewer: approve } });
  const manifest = structuredClone(result.planningArtifacts);
  manifest.files.push({ path: '../escape.txt', sha256: 'not-a-generated-file' });
  const approval = { ...result.approval, sidecarDigest: contextDigest({ manifest }) };
  assert.throws(() => assertPlanningSidecars({ directory: clean.out, runId: result.runId, approval, manifest }), /invalid registered.*path/);
});

test('candidate observation cannot impersonate the other seat or another operation', async t => {
  const opts = fixture(t); let reviewed = false;
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    draft: r => ({ plan: r.candidateId, gate: [], dialogue: reply(r, 'propose'), observations: { evidence: [],
      receipts: [createInspectionReceipt({ operationId: 'forged-operation', seat: 'codex', evidence: r.state.evidence, inspected: true, result: 'read' })] } }),
    review: () => { reviewed = true; },
  });
  assert.equal(result.approved, false);
  assert.equal(result.surviving.length, 0);
  assert.equal(reviewed, false);
  assert.ok(result.messages.every(message => /operation or seat mismatch/.test(message.error)));
});

test('selection cannot change the parsed candidate artifact behind its preparation identity', async t => {
  const opts = fixture(t);
  await assert.rejects(runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    draft: r => ({ plan: r.candidateId, gate: [], dialogue: reply(r, 'propose') }),
    select: r => { r.candidates[0].plan = 'Unattributed replacement'; return { selectedCandidateId: 'candidate-1', dialogue: reply(r, 'verify') }; },
    review: () => assert.fail('changed candidate must not reach review'),
  }), /validated saved artifact/);
});

test('the selected author next action is retained without launching an unrequested revision', async t => {
  const opts = fixture(t); let reviews = 0;
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    draft: r => ({ plan: r.candidateId, gate: [], dialogue: reply(r, 'propose', { next: { seat: 'codex', action: 'ask', reason: 'Clarify the source question first' } }) }),
    select: r => ({ selectedCandidateId: 'candidate-1', dialogue: reply(r, 'verify') }),
    review: r => { reviews++; assert.equal(r.action, 'ask'); return { dialogue: reply(r, 'stop', { content: 'A human clarification is needed.' }) }; },
  });
  assert.equal(result.approved, false);
  assert.equal(reviews, 1);
  assert.equal(result.resources.providerLaunches, 4);
});

test('artifact-format repair of an alternative does not erase its earlier unresolved concern', async t => {
  const opts = fixture(t); let attempts = 0;
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    draft: r => {
      if (r.candidateId === 'candidate-1' && ++attempts === 1) return { answer: '<PLAN_MD>Missing gate</PLAN_MD>',
        dialogue: reply(r, 'propose', { issues: [{ id: 'earlier-blocker', title: 'An unresolved earlier concern', blocking: true, status: 'open', claimIds: [] }] }) };
      return { plan: r.candidateId, gate: [], dialogue: reply(r, 'propose') };
    }, select: r => ({ selectedCandidateId: 'candidate-1', dialogue: reply(r, 'verify') }),
    review: r => { assert.equal(r.state.issues['earlier-blocker']?.status, 'open'); return approve(r); },
  });
  assert.equal(result.approved, false);
  assert.equal(result.dialogue.issues['earlier-blocker']?.status, 'open');
  assert.equal(result.dialogue.artifactRepairs, 1);
});

test('authenticated material from a rejected malformed alternative remains attributed history', async t => {
  const opts = fixture(t);
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    draft: r => {
      if (r.candidateId === 'candidate-2') return { plan: 'Keep login', gate: [], dialogue: reply(r, 'propose') };
      const evidence = captureEvidence({ projectId: r.state.projectId, root: opts.target, directory: join(opts.out, '__uro_evidence'),
        evidence: { id: 'rejected-source', kind: 'code', projectId: r.state.projectId, claimIds: [],
          locator: { path: 'source.js', line: 1 }, sourceIdentity: r.state.snapshot.sourceRevision } });
      return { content: 'Unparsed rejected alternative with an actual read', observations: { evidence: [evidence],
        receipts: [createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' })] } };
    }, review: r => {
      assert.ok(r.state.snapshot.evidence.some(e => e.id === 'rejected-source'));
      assert.match(r.input, /Unparsed rejected alternative with an actual read/);
      assert.equal(Object.keys(r.state.claims).length, 0);
      return approve(r);
    },
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.selected.id, 'candidate-2');
});
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'uro-planning-dialogue-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const target = join(base, 'repo'); mkdirSync(target);
  writeFileSync(join(target, 'source.js'), 'export const localLogin = true;\n');
  return { target, out: join(base, 'out'), artifactRoot: join(base, 'artifacts'), goal: 'Preserve local login', superpowers };
}
function reply(r, action, extra = {}) {
  return { schemaVersion: 1, action, artifactDigest: r.state?.artifactDigest ?? 'missing',
    contextDigest: r.state?.snapshot.digest ?? 'missing', replyTo: null, content: 'Preserve the requested behavior.',
    claims: [], issues: [], evidence: [], verifications: [], next: null, ...extra };
}
function approve(r) {
  if (!r.state) return { content: 'AGREE: yes', agree: true, readable: true, artifactDigest: r.artifactDigest };
  const evidence = r.state.evidence.find(e => e.kind === 'requirement');
  readFileSync(evidence.capturedPath);
  const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'codex', evidence: [evidence], inspected: true, result: 'read' });
  return { dialogue: reply(r, 'approve', {
    claims: [{ id: 'briefing-requirement', kind: 'fact', text: 'The briefing requires preserving local login.', evidenceIds: [evidence.id] }],
    verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'I inspected the exact captured user requirement.' }],
  }), observations: { evidence: [], receipts: [receipt] }, usage: { inputTokens: 3, outputTokens: 1 } };
}

test('real fresh candidate review receives the frozen failed plan, ledger and pivot grounding', async t => {
  const opts = fixture(t), inputs = [];
  const result = await runPlanCandidateSet({ ...opts, count: 1, failedPlan: 'Do not repeat the table rewrite',
    ledger: { rounds: [{ finding: 'offline access broke' }] }, pivot: 'Preserve local login',
    draft: async r => { inputs.push(r); return { plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') }; },
    review: async r => { inputs.push(r); return approve(r); },
  });
  assert.match(inputs[1].input ?? '', /Do not repeat the table rewrite/);
  assert.match(inputs[1].input, /offline access broke/);
  assert.match(inputs[1].input, /Preserve local login/);
  assert.equal(inputs[0].state.snapshot.digest, inputs[1].state.snapshot.digest);
  assert.equal(result.approved, true, result.reason);
  assert.equal(Number.isSafeInteger(result.rounds), true);
  assert.equal(result.resources.providerLaunches, 2);
  assert.ok(existsSync(join(result.directory, '__uro_dialogue', 'journal-tail.jsonl')));
});

test('explicit alternative preparation allows one accounted protocol-format repair of the saved response', async t => {
  const opts = fixture(t); let firstCalls = 0;
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, count: 2,
    draft: async r => {
      if (r.candidateId === 'candidate-1' && ++firstCalls === 1) return { content: 'delivered malformed protocol', usage: { inputTokens: 5, outputTokens: 1 } };
      if (r.candidateId === 'candidate-1') assert.match(r.input, /delivered malformed protocol/);
      return { plan: r.candidateId, gate: [], dialogue: reply(r, 'propose'), usage: { inputTokens: 2, outputTokens: 1 } };
    },
    select: r => ({ selectedCandidateId: 'candidate-1', dialogue: reply(r, 'verify'), usage: { inputTokens: 1, outputTokens: 1 } }),
    review: approve,
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.selected.id, 'candidate-1');
  assert.equal(result.resources.providerLaunches, 5);
  assert.equal(result.resources.repairLaunches, 1);
  assert.equal(result.resources.knownUsage.inputTokens, 13);
});

test('omitted fresh candidate breadth remains three at the direct planning entry point', async t => {
  const opts = fixture(t); let drafts = 0;
  const result = await runPlanCandidateSet({ ...opts, directory: opts.out, mode: 'fresh',
    draft: r => { drafts++; return { plan: r.candidateId, gate: [], dialogue: reply(r, 'propose') }; },
    select: r => ({ selectedCandidateId: 'candidate-1', dialogue: reply(r, 'verify') }), review: approve });
  assert.equal(result.approved, true, result.reason);
  assert.equal(drafts, 3);
});

test('new standalone planning refuses legacy AGREE without a dialogue envelope', async t => {
  const opts = fixture(t);
  const result = await runPlan({ ...opts, adapters: {
    author: async () => ({ plan: 'Keep local login', gate: [], agree: true, readable: true }),
    reviewer: async r => ({ agree: true, readable: true, content: 'AGREE: yes', artifactDigest: r.artifactDigest }),
  } });
  assert.equal(result.approved, false);
  assert.equal(existsSync(join(opts.out, 'plan.md')), false);
  assert.match(result.reason, /envelope|format/i);
});

test('same-artifact question and answer never parse or write artifact text and do not consume a round', async t => {
  const opts = fixture(t); let authors = 0, reviews = 0;
  const result = await runPlan({ ...opts, rounds: 1, adapters: {
    author: async r => {
      authors++;
      if (authors === 1) return { plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') };
      assert.equal(existsSync(join(opts.out, 'plan.md')), false);
      return { answer: '<PLAN_MD>malformed artifact on a read-only answer', dialogue: reply(r, 'answer', {
        next: { seat: 'codex', action: 'verify', reason: 'Assess the explanation' },
      }) };
    },
    reviewer: async r => ++reviews === 1 ? { dialogue: reply(r, 'ask', {
      next: { seat: 'claude', action: 'answer', reason: 'Explain local login' },
    }) } : approve(r),
  } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(readFileSync(join(opts.out, 'plan.md'), 'utf8'), 'Keep local login\n');
  assert.equal(result.rounds, 1);
  assert.equal(result.resources.providerLaunches, 4);
  assert.equal(readdirSync(join(opts.out, '__uro_context')).filter(p => p.endsWith('.json')).length, 1);
});

test('explicit alternatives share grounding and selected review receives its attributed history extension', async t => {
  const opts = fixture(t), calls = []; let active = 0;
  const result = await runPlanCandidateSet({ ...opts, count: 2,
    draft: async r => {
      assert.equal(active++, 0);
      await Promise.resolve(); active--;
      calls.push(['draft', r.state?.snapshot.digest, r.input]);
      return { plan: r.candidateId, gate: [], dialogue: reply(r, 'propose'), usage: { inputTokens: 10, outputTokens: 2 } };
    },
    select: async r => { calls.push(['select', r.state?.snapshot.digest, r.input]);
      return { selectedCandidateId: 'candidate-2', dialogue: reply(r, 'verify'), usage: { inputTokens: 5, outputTokens: 1 } }; },
    review: async r => { calls.push(['review', r.state?.snapshot.digest, r.input]); return approve(r); },
  });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.selected.id, 'candidate-2');
  assert.equal(result.resources.providerLaunches, 4);
  assert.equal(result.tokens.total.inputTokens, 28);
  assert.equal(new Set(calls.slice(0, 3).map(c => c[1])).size, 1);
  assert.equal(result.sharedContext.parentDigest, calls[0][1]);
  assert.equal(calls[3][1], result.sharedContext.digest);
  assert.ok(result.sharedContext.entries.some(entry => entry.id === 'candidate-preparation-history' && entry.status === 'historical'));
  assert.ok(calls.every(c => /Preserve local login/.test(c[2])));
});

test('new manual disputed planning saves v2 and applies an identified human approval without another draft', async t => {
  const opts = fixture(t);
  const pending = await runPlan({ ...opts, adapters: {
    author: async r => ({ plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') }),
    reviewer: async r => ({ dialogue: reply(r, 'decide', { issues: [
      { id: 'I1', title: 'Keep local login', status: 'disputed', blocking: true, claimIds: [] },
    ] }) }),
  } });
  assert.equal(pending.reason, 'needs-decision', pending.reason);
  const checkpoint = JSON.parse(readFileSync(join(opts.out, 'uro-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.schemaVersion, 2);
  assert.equal(checkpoint.continuation.version, 2);
  const decisionFile = join(opts.artifactRoot, 'answers.json');
  writeFileSync(decisionFile, JSON.stringify({ schemaVersion: 1, runId: pending.runId,
    artifactDigest: checkpoint.artifactDigest, answers: [{ id: checkpoint.pending.questions[0].id, answer: 'approve: Keep local login.' }] }));
  const adapters = { author: () => assert.fail('approval must consume the saved artifact'), reviewer: () => assert.fail('human approval requires no inference') };
  const result = await resumeRun({ runDirectory: opts.out, decisionFile, adapters });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.approval.decidedBy, 'human');
  assert.equal(readFileSync(result.planPath, 'utf8'), 'Keep local login\n');
  assert.deepEqual(await resumeRun({ runDirectory: opts.out, decisionFile, adapters }), result);
});

test('both planning seats can independently inspect a new source and the next input extends material context', async t => {
  const opts = fixture(t), digests = []; let authors = 0, reviews = 0;
  const result = await runPlan({ ...opts, adapters: {
    author: async r => {
      digests.push(r.state.snapshot.digest);
      if (++authors === 1) return { dialogue: reply(r, 'inspect', { requests: [{ path: 'source.js', line: 1, claimIds: ['source-author'] }] }) };
      if (authors === 2) { assert.match(r.input, /export const localLogin = true/);
        return { dialogue: reply(r, 'answer', { next: { seat: 'claude', action: 'propose', reason: 'Author the inspected proposal' } }) }; }
      return { plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') };
    },
    reviewer: async r => {
      if (++reviews === 1) return { dialogue: reply(r, 'inspect', { requests: [{ path: 'source.js', line: 1, claimIds: ['source-reviewer'] }] }) };
      assert.match(r.input, /export const localLogin = true/);
      return approve(r);
    },
  } });
  assert.equal(result.approved, true, result.reason);
  assert.notEqual(digests[0], digests[1]);
  assert.equal(result.sharedContext.evidence.filter(e => e.kind === 'code').length, 2);
  assert.equal(result.rounds, 1);
  assert.equal(result.resources.providerLaunches, 5);
});

test('approved notebook proposals are recalled as immutable historical versions by the next work item only in the same project', async t => {
  const opts = fixture(t);
  const adapters = { author: async r => ({ plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') }),
    reviewer: async r => { const response = approve(r); response.dialogue.memoryProposals = [
      { id: 'login-decision', kind: 'decision', content: 'Preserve local login', claimIds: ['briefing-requirement'], tags: ['login'] },
    ]; return response; } };
  const first = await runPlan({ ...opts, adapters });
  assert.equal(first.approved, true, first.reason);
  const seen = [];
  const second = await runPlan({ ...opts, out: join(opts.out, '..', 'second'), adapters: {
    author: async r => { seen.push(r.state.snapshot); return { plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') }; }, reviewer: approve,
  } });
  assert.equal(second.approved, true, second.reason);
  assert.equal(seen[0].recalled.length, 1);
  assert.equal(seen[0].recalled[0].id, seen[0].recalled[0].versionId);
  assert.equal(seen[0].recalled[0].notebookEntryId, 'login-decision');
  assert.equal(seen[0].recalled[0].status, 'historical');
  const other = fixture(t);
  const separate = await runPlan({ ...other, artifactRoot: opts.artifactRoot, adapters: {
    author: async r => { assert.equal(r.state.snapshot.recalled.length, 0); return { plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') }; }, reviewer: approve,
  } });
  assert.equal(separate.approved, true, separate.reason);
});

test('optional recall outage is visible while the current requirement remains required', async t => {
  const opts = fixture(t);
  const result = await runPlan({ ...opts, searchIndex: () => { throw new Error('index offline'); }, adapters: {
    author: async r => {
      assert.match(r.input, /index offline/);
      assert.equal(r.state.snapshot.entries.find(e => e.id === 'requirements').status, 'required');
      return { plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') };
    }, reviewer: approve,
  } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.recall.status, 'fallback');
});

test('a malformed first artifact repairs from its saved response within rounds1', async t => {
  const opts = fixture(t); let calls = 0;
  const result = await runPlan({ ...opts, rounds: 1, adapters: {
    author: async r => {
      if (++calls === 1) return { answer: '<PLAN_MD>Missing gate</PLAN_MD>', dialogue: reply(r, 'propose') };
      assert.match(r.input, /Missing gate/);
      assert.match(r.input, /PLAN_MD and GATE_JSON/);
      return { plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') };
    }, reviewer: approve,
  } });
  assert.equal(result.approved, true, result.reason);
  assert.equal(result.rounds, 1);
  assert.equal(result.dialogue.artifactRepairs, 1);
  assert.equal(result.resources.providerLaunches, 3);
});

test('artifact repair exhaustion stops at five repair launches without writing or reviewing', async t => {
  const opts = fixture(t); let calls = 0;
  const result = await runPlan({ ...opts, rounds: 1, adapters: {
    author: async r => { calls++; return { answer: '<PLAN_MD>Missing gate</PLAN_MD>', dialogue: reply(r, 'propose') }; },
    reviewer: () => assert.fail('invalid artifact cannot reach review'),
  } });
  assert.equal(result.reason, 'proposal-irreparable');
  assert.equal(result.approved, false);
  assert.equal(calls, 6);
  assert.equal(result.resources.providerLaunches, 6);
  assert.equal(existsSync(join(opts.out, 'plan.md')), false);
});

test('current plan approval rejects a changed or unrelated nested sidecar before queue allowance', async t => {
  const opts = fixture(t);
  const result = await runPlan({ ...opts, adapters: {
    author: async r => ({ plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') }), reviewer: approve,
  } });
  assert.equal(result.approved, true, result.reason);
  writeFileSync(join(opts.out, '__uro_context', 'unrelated.json'), '{}');
  assert.throws(() => assertCurrentPlanApproval({ unit: { out: opts.out, goal: opts.goal }, result }), /sidecar|manifest/);
});

test('a notebook proposal recorded before claim retirement is never promoted as a verified fact', async t => {
  const opts = fixture(t); let reviews = 0;
  const result = await runPlan({ ...opts, adapters: {
    author: async r => ({ plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') }),
    reviewer: async r => {
      if (++reviews === 1) {
        const response = approve(r);
        response.dialogue.action = 'verify';
        response.dialogue.issues = [{ id: 'withdraw-me', title: 'Retired premise', status: 'open', blocking: false, claimIds: ['briefing-requirement'] }];
        response.dialogue.memoryProposals = [{ id: 'retired-note', kind: 'decision', content: 'Preserve local login', issueId: 'withdraw-me', claimIds: ['briefing-requirement'], tags: [] }];
        response.dialogue.next = { seat: 'codex', action: 'withdraw', reason: 'Withdraw this premise' };
        return response;
      }
      if (reviews === 2) return { dialogue: reply(r, 'withdraw', {
        issues: [{ id: 'withdraw-me', status: 'withdrawn', disposition: { kind: 'withdrawn', reason: 'Not retained as a premise.', claimIds: [] } }],
        next: { seat: 'codex', action: 'stop', reason: 'Stop after withdrawal' },
      }) };
      return { dialogue: reply(r, 'stop') };
    },
  } });
  assert.equal(result.dialogue.claims['briefing-requirement'].status, 'retired');
  const memory = openProjectMemory({ artifactRoot: opts.artifactRoot, project: resolveProjectIdentity({ target: opts.target }) });
  const entries = memory.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'unsupported');
});

for (const target of ['snapshot', 'journal-and-tail']) test(`planning refuses modified ${target} before approval or another provider launch`, async t => {
  const opts = fixture(t); let authors = 0, reviewers = 0;
  await assert.rejects(runPlan({ ...opts, adapters: {
    author: async r => { authors++; return { plan: 'Keep local login', gate: [], dialogue: reply(r, 'propose') }; },
    reviewer: async r => {
      reviewers++;
      if (target === 'snapshot') writeFileSync(join(opts.out, '__uro_context', `${r.state.snapshot.id}.json`), '{}');
      else for (const name of ['journal.jsonl', 'journal-tail.jsonl']) {
        const path = join(opts.out, '__uro_dialogue', name);
        const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
        writeFileSync(path, `${lines.slice(0, -1).join('\n')}\n`);
      }
      return approve(r);
    },
  } }), /context changed|journal.*tail|rollback/);
  assert.equal(authors, 1);
  assert.equal(reviewers, 1);
  assert.equal(existsSync(join(opts.out, 'plan.md')), false);
});
