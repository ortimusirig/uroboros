import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan, runPlanCandidateSet, assertCurrentPlanApproval } from '../src/plan.js';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { resumeRun } from '../src/resume.js';
import { openProjectMemory, resolveProjectIdentity } from '../src/project-memory.js';

const superpowers = { seats: { claude: { verified: true }, codex: { verified: true } } };
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

test('explicit alternatives and selector are serialized durable calls over the same shared snapshot', async t => {
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
  assert.equal(new Set(calls.map(c => c[1])).size, 1);
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
