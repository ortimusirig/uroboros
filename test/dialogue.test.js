import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureEvidence } from '../src/context-evidence.js';
import { createDialogueState, parseDialogueEnvelope, applyDialogueEnvelope, canApproveDialogue } from '../src/dialogue.js';
import { fixture, envelope, claim, observe, support } from './fixtures/dialogue-fixture.js';

test('product clarification and autonomous technical disputes do not invent missing human decisions', t => {
  const { state } = fixture(t, { phase: 'execution' });
  for (const [kind, status] of [['product', 'awaiting-answer'], ['technical', 'disputed']]) {
    const result = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'ask', {
      evidence: ['E1'], issues: [{ id: 'Q1', kind, title: 'Explain existing evidence', blocking: true, status, needsHuman: false }],
    }) });
    assert.equal(result.pendingDecision, null);
  }
});

test('a missing human decision cannot be silently relabelled by a counterpart answer', t => {
  const { state } = fixture(t, { phase: 'execution' });
  const pending = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'ask', {
    issues: [{ id: 'Q1', kind: 'permission', needsHuman: true, title: 'Missing user permission', blocking: true, status: 'awaiting-answer' }],
  }) });
  assert.equal(pending.pendingDecision?.authority, 'human');
  assert.throws(() => applyDialogueEnvelope({ state: pending, seat: 'claude', envelope: envelope(pending, 'answer', {
    issues: [{ id: 'Q1', kind: 'technical', needsHuman: false, status: 'open' }],
  }) }), /human|kind/);
  assert.equal(pending.pendingDecision.authority, 'human');
});

test('a later explicit missing decision retains every affected human question', t => {
  const { state } = fixture(t, { phase: 'execution' });
  const clarification = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'ask', {
    issues: [{ id: 'Q1', kind: 'product', needsHuman: false, title: 'Clarification', blocking: true, status: 'awaiting-answer' }],
  }) });
  const pending = applyDialogueEnvelope({ state: clarification, seat: 'codex', envelope: envelope(clarification, 'ask', {
    issues: [{ id: 'Q1', kind: 'product', needsHuman: true, blocking: true, status: 'awaiting-answer' },
      { id: 'Q2', kind: 'permission', needsHuman: true, title: 'Permission', blocking: true, status: 'awaiting-answer' }],
  }) });
  assert.equal(pending.issues.Q1.needsHuman, true);
  assert.deepEqual(pending.pendingDecision.issueIds, ['Q1', 'Q2']);
});

test('acknowledgment cannot approve and clean reviewer sign-off can finish in either mode', (t) => {
  for (const interactionMode of ['manual', 'autonomous']) {
    const { state } = fixture(t, { interactionMode });
    assert.ok(state, 'a real state is created');
    const answered = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'answer') });
    assert.equal(canApproveDialogue({ state: answered, seat: 'codex' }).approved, false);
    const receipt = observe(answered);
    const approved = applyDialogueEnvelope({ state: answered, seat: 'codex', envelope: envelope(answered, 'approve', {
      claims: [claim], verifications: [support(receipt)],
    }) });
    assert.equal(canApproveDialogue({ state: approved, seat: 'codex' }).approved, true);
    assert.equal(canApproveDialogue({ state: approved, seat: 'claude' }).approved, false);
    assert.equal(approved.pendingDecision, null);
  }
});

test('parsing accepts one tagged block or object adapter and refuses ambiguous legacy text', (t) => {
  const { state } = fixture(t), value = envelope(state, 'ask');
  assert.deepEqual(parseDialogueEnvelope({ response: { dialogue: value } }), value);
  const tagged = `<UROBOROS_DIALOGUE>${JSON.stringify(value)}</UROBOROS_DIALOGUE>`;
  assert.deepEqual(parseDialogueEnvelope({ response: `<PLAN>unchanged</PLAN>${tagged}` }), value);
  for (const response of ['APPROVED', tagged + tagged, '<UROBOROS_DIALOGUE>{}']) {
    assert.throws(() => parseDialogueEnvelope({ response }), /dialogue|envelope|block/i);
  }
});

test('invalid identities, spoofed attribution, unsupported facts and references reject atomically', (t) => {
  const { state } = fixture(t);
  const cases = [
    { sender: 'claude' }, { artifactDigest: 'old' }, { contextDigest: 'old' }, { action: 'invented' },
    { replyTo: 'missing' }, { claims: [{ ...claim, evidenceIds: [] }] },
    { issues: [{ id: 'I1', title: 'Concern', status: 'magically-fixed', blocking: true }] },
    { verifications: [{ claimId: 'missing', evidenceIds: ['E1'], inspectionReceiptIds: [], result: 'supports', reason: 'yes' }] },
  ];
  const original = structuredClone(state);
  for (const overrides of cases) {
    assert.throws(() => applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'answer', overrides) }));
    assert.deepEqual(state, original);
  }
  assert.throws(() => applyDialogueEnvelope({ state, seat: 'human', envelope: envelope(state, 'approve') }), /seat/);
  assert.throws(() => applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'revise') }), /author/);
});

test('verification resolves only registered same-seat receipts with completed operation bindings', (t) => {
  const { state } = fixture(t), receipt = observe(state);
  const valid = envelope(state, 'approve', { claims: [claim], verifications: [support(receipt)] });
  for (const mutate of [
    copy => delete copy.inspectionReceipts[receipt.id],
    copy => delete copy.operations[receipt.operationId],
    copy => { copy.operations[receipt.operationId].status = 'prepared'; },
    copy => { copy.operations[receipt.operationId].receiptIds = []; },
    copy => { copy.inspectionReceipts[receipt.id].seat = 'claude'; },
  ]) {
    const copy = structuredClone(state); mutate(copy);
    assert.throws(() => applyDialogueEnvelope({ state: copy, seat: 'codex', envelope: valid }), /receipt|operation|seat/);
  }
  const forged = structuredClone(valid);
  forged.verifications[0].inspectionReceiptIds = ['forged'];
  forged.verifications[0].inspectionReceipts = [{ ...receipt, id: 'forged' }];
  assert.throws(() => applyDialogueEnvelope({ state, seat: 'codex', envelope: forged }), /receipt/);
});

test('counterpart support is required and contrary source assessment blocks approval', (t) => {
  const { state } = fixture(t);
  const authored = applyDialogueEnvelope({ state, seat: 'claude', envelope: envelope(state, 'answer', { claims: [claim] }) });
  assert.throws(() => applyDialogueEnvelope({ state: authored, seat: 'codex', envelope: envelope(authored, 'approve', { claims: [claim] }) }), /verif|support/);
  const receipt = observe(authored);
  const challenged = applyDialogueEnvelope({ state: authored, seat: 'codex', envelope: envelope(authored, 'verify', {
    verifications: [support(receipt, { result: 'contradicts' })],
  }) });
  assert.throws(() => applyDialogueEnvelope({ state: challenged, seat: 'codex', envelope: envelope(challenged, 'approve', { claims: [claim] }) }), /contradic|support|verif/);
});

test('blocking issues require explicit authorized dispositions and manual disputes route to human', (t) => {
  for (const interactionMode of ['manual', 'autonomous']) {
    const { state } = fixture(t, { interactionMode });
    const raised = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'challenge', {
      issues: [{ id: 'I1', title: 'Enabled requirement disputed', status: 'disputed', blocking: true, claimIds: ['C1'] }], claims: [claim],
    }) });
    const receipt = observe(raised);
    assert.throws(() => applyDialogueEnvelope({ state: raised, seat: 'codex', envelope: envelope(raised, 'approve', { claims: [claim], verifications: [support(receipt)] }) }), /blocking|disput/);
    const decision = applyDialogueEnvelope({ state: raised, seat: 'codex', envelope: envelope(raised, 'decide', {
      claims: [claim], verifications: [support(receipt)],
      issues: [{ id: 'I1', status: 'resolved', disposition: { kind: 'accepted', reason: 'The requirement controls.', claimIds: ['C1'] } }],
    }) });
    if (interactionMode === 'manual') {
      assert.equal(decision.pendingDecision.authority, 'human');
      assert.equal(decision.issues.I1.status, 'disputed');
      assert.equal(canApproveDialogue({ state: decision, seat: 'codex' }).approved, false);
    } else assert.equal(decision.issues.I1.disposition.by, 'codex');
  }
});

test('an unapplied proposal invalidates approval and Q&A preserves identity and cycle counts', (t) => {
  const { state } = fixture(t), receipt = observe(state);
  const approved = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'approve', { claims: [claim], verifications: [support(receipt)] }) });
  const proposed = applyDialogueEnvelope({ state: approved, seat: 'claude', envelope: envelope(approved, 'revise') });
  assert.equal(proposed.artifactDigest, 'a1');
  assert.equal(proposed.proposalCycles, 1);
  assert.equal(proposed.correctionCycles, 1);
  assert.equal(canApproveDialogue({ state: proposed, seat: 'codex' }).approved, false);
  const answer = applyDialogueEnvelope({ state: proposed, seat: 'codex', envelope: envelope(proposed, 'answer') });
  assert.equal(answer.proposalCycles, 1);
  assert.equal(answer.artifactDigest, 'a1');
});

test('memory proposals from either seat bind harness provenance and reject unknown references', (t) => {
  for (const seat of ['claude', 'codex']) {
    const { state } = fixture(t);
    const proposal = { id: 'M1', content: 'Feature must remain enabled.', kind: 'decision', claimIds: ['C1'], tags: ['feature'], status: 'verified', proposer: 'human' };
    const saved = applyDialogueEnvelope({ state, seat, envelope: envelope(state, 'answer', { claims: [claim], memoryProposals: [proposal] }) });
    assert.equal(saved.memoryProposals[0].status, 'proposed');
    assert.equal(saved.memoryProposals[0].provenance.seat, seat);
    assert.equal(saved.memoryProposals[0].provenance.messageId, saved.messages[0].id);
    assert.equal(saved.memoryProposals[0].provenance.contextDigest, state.snapshot.digest);
    for (const bad of [{ ...proposal, claimIds: ['unknown'] }, { ...proposal, issueId: 'unknown' }]) {
      assert.throws(() => applyDialogueEnvelope({ state, seat, envelope: envelope(state, 'answer', { claims: [claim], memoryProposals: [bad] }) }), /unknown|reference/);
    }
  }
});

test('source roots cannot be replaced by matching source bytes in the evidence-capture root', (t) => {
  const { state, root, directory } = fixture(t);
  const code = captureEvidence({ projectId: 'p1', root, directory, evidence: { id: 'E2', kind: 'code', projectId: 'p1',
    claimIds: ['C2'], locator: { path: 'source.js', line: 1 }, sourceIdentity: 'base' } });
  state.evidence.push(code);
  copyFileSync(join(root, 'source.js'), join(directory, 'source.js'));
  writeFileSync(join(root, 'source.js'), 'export const enabled = false;\n');
  assert.throws(() => applyDialogueEnvelope({ state, seat: 'claude', envelope: envelope(state, 'answer', {
    claims: [{ id: 'C2', kind: 'fact', text: 'Feature enabled', evidenceIds: ['E2'] }],
  }) }), /source|stale|digest/);
});

test('model-created evidence cannot enter trusted registry even with self-consistent captured bytes', (t) => {
  const { state, root, directory } = fixture(t);
  const invented = captureEvidence({ projectId: 'p1', root, directory, evidence: { id: 'fake', kind: 'requirement', projectId: 'p1',
    claimIds: ['fake-claim'], locator: { briefingId: 'fake' }, text: 'Invented permission', sourceIdentity: 'fake' } });
  assert.throws(() => applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'answer', {
    evidence: [invented], claims: [{ id: 'fake-claim', kind: 'fact', text: 'Permission exists', evidenceIds: ['fake'] }],
  }) }), /registry|trusted|unknown|evidence/);
});

test('phase ownership reverses for execution and explicit cycles reject invalid limits or overrun', (t) => {
  const { state } = fixture(t, { phase: 'execution', limits: { rounds: 1, challenges: 1 } });
  assert.equal(state.reviewer, 'claude');
  assert.equal(state.author, 'codex');
  const proposed = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'propose') });
  assert.throws(() => applyDialogueEnvelope({ state: proposed, seat: 'codex', envelope: envelope(proposed, 'propose') }), /limit/);
  const challenged = applyDialogueEnvelope({ state, seat: 'claude', envelope: envelope(state, 'challenge') });
  assert.throws(() => applyDialogueEnvelope({ state: challenged, seat: 'claude', envelope: envelope(challenged, 'challenge') }), /limit/);
  for (const rounds of [-1, NaN, '1', 1.5]) assert.throws(() => createDialogueState({ ...state, limits: { rounds } }), /limit/);
});

test('counterpart may not rewrite or waive another seat blocking issue without disposition', (t) => {
  const { state } = fixture(t);
  const raised = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'ask', {
    issues: [{ id: 'I1', title: 'Safety concern', status: 'open', blocking: true }],
  }) });
  const updated = applyDialogueEnvelope({ state: raised, seat: 'claude', envelope: envelope(raised, 'answer', {
    issues: [{ id: 'I1', title: 'Trivial', status: 'awaiting-verification', blocking: false }],
  }) });
  assert.equal(updated.issues.I1.blocking, true);
  assert.equal(updated.issues.I1.title, 'Safety concern');
  assert.throws(() => applyDialogueEnvelope({ state: raised, seat: 'claude', envelope: envelope(raised, 'withdraw', {
    issues: [{ id: 'I1', status: 'withdrawn', disposition: { kind: 'withdrawn', reason: 'Ignore it' } }],
  }) }), /authority/);
});

test('reserved object property names cannot hide blocking issues or manufacture known claims', (t) => {
  const { state } = fixture(t);
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'ask', {
      issues: [{ id, title: 'Blocking concern', status: 'open', blocking: true }],
    }) }), /identifier|reserved/);
  }
  assert.throws(() => applyDialogueEnvelope({ state, seat: 'claude', envelope: envelope(state, 'answer', {
    claims: [claim], memoryProposals: [{ id: 'M1', content: 'A decision', kind: 'decision', claimIds: ['constructor'] }],
  }) }), /unknown/);
});

test('manual dispute cannot be downgraded to bypass human disposition authority', (t) => {
  const { state } = fixture(t, { interactionMode: 'manual' });
  const disputed = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'challenge', {
    issues: [{ id: 'I1', title: 'Disagreement', status: 'disputed', blocking: true }],
  }) });
  const answer = applyDialogueEnvelope({ state: disputed, seat: 'claude', envelope: envelope(disputed, 'answer', {
    issues: [{ id: 'I1', status: 'awaiting-verification' }],
  }) });
  assert.equal(answer.issues.I1.status, 'disputed');
});

test('decide resolves authorized issues without silently signing off the artifact', (t) => {
  const { state } = fixture(t), receipt = observe(state);
  const result = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'decide', { claims: [claim], verifications: [support(receipt)] }) });
  assert.equal(canApproveDialogue({ state: result, seat: 'codex' }).approved, false);
});

function mistakenFinding(t) {
  const f = fixture(t);
  const evidence = captureEvidence({ projectId: 'p1', root: f.root, directory: f.directory, evidence: {
    id: 'source', kind: 'code', projectId: 'p1', claimIds: ['mistake', 'correct'],
    locator: { path: 'source.js', line: 1 }, sourceIdentity: 'base',
  } });
  f.state.evidence.push(evidence);
  const mistake = { id: 'mistake', kind: 'fact', text: 'The source disables the feature.', evidenceIds: ['source'] };
  const correct = { id: 'correct', kind: 'fact', text: 'The source enables the feature.', evidenceIds: ['source'] };
  let state = applyDialogueEnvelope({ state: f.state, seat: 'codex', envelope: envelope(f.state, 'challenge', {
    claims: [mistake], issues: [{ id: 'I1', title: 'Feature appears disabled', status: 'disputed', blocking: true, claimIds: ['mistake'] }],
  }) });
  const authorRead = observe(state, 'claude', [evidence], 'author-read');
  state = applyDialogueEnvelope({ state, seat: 'claude', envelope: envelope(state, 'rebut', {
    claims: [correct], verifications: [{ claimId: 'mistake', evidenceIds: ['source'], inspectionReceiptIds: [authorRead.id], result: 'contradicts', reason: 'The actual source sets enabled to true.' }],
  }) });
  const reviewerRead = observe(state, 'codex', [evidence], 'reviewer-read');
  const approval = envelope(state, 'approve', { claims: [correct], verifications: [{ claimId: 'correct', evidenceIds: ['source'], inspectionReceiptIds: [reviewerRead.id], result: 'supports', reason: 'The source enables the feature.' }] });
  return { ...f, state, mistake, correct, approval };
}

for (const kind of ['withdrawn', 'rejected']) {
  test(`an explicit applicable ${kind} finding retires the factual mistake and approves unchanged artifact`, (t) => {
    const { state, approval } = mistakenFinding(t);
    const next = applyDialogueEnvelope({ state, seat: 'codex', envelope: { ...approval, issues: [{ id: 'I1', status: kind === 'withdrawn' ? 'withdrawn' : 'resolved',
      disposition: { kind, reason: 'I misread the enabled flag; the counterpart supplied the exact source.', claimIds: ['correct'] } }] } });
    assert.equal(canApproveDialogue({ state: next, seat: 'codex' }).approved, true);
    assert.equal(next.artifactDigest, 'a1');
    assert.equal(next.proposalCycles, 0);
    assert.equal(next.claims.mistake.status, 'retired');
    assert.equal(next.claims.mistake.retirement.issueId, 'I1');
    assert.equal(next.claims.mistake.text, 'The source disables the feature.');
    assert.ok(next.verifications.some(v => v.claimId === 'mistake' && v.result === 'contradicts'));
    assert.equal(next.claims.correct.status, 'active');
  });
}

test('unrelated disposition or another open issue cannot hide the contradicted claim', (t) => {
  for (const related of [false, true]) {
    const { state, approval } = mistakenFinding(t);
    const another = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'ask', {
      issues: [{ id: 'I2', title: 'Another concern', status: 'open', blocking: true, claimIds: related ? ['mistake'] : ['correct'] }],
    }) });
    assert.throws(() => applyDialogueEnvelope({ state: another, seat: 'codex', envelope: { ...approval, issues: [{ id: related ? 'I1' : 'I2', status: 'withdrawn',
      disposition: { kind: 'withdrawn', reason: 'Withdraw this issue.', claimIds: ['correct'] } }] } }), /blocking|verif|contradic/);
  }
});

test('retired findings cannot be reused as approval or notebook premises', (t) => {
  const { state, approval, mistake } = mistakenFinding(t);
  const retired = applyDialogueEnvelope({ state, seat: 'codex', envelope: envelope(state, 'withdraw', {
    issues: [{ id: 'I1', status: 'withdrawn', disposition: { kind: 'withdrawn', reason: 'I was mistaken.' } }],
  }) });
  assert.equal(retired.claims.mistake.status, 'retired');
  assert.throws(() => applyDialogueEnvelope({ state: retired, seat: 'codex', envelope: { ...approval, claims: [mistake] } }), /retired/);
  assert.throws(() => applyDialogueEnvelope({ state: retired, seat: 'claude', envelope: envelope(retired, 'answer', {
    memoryProposals: [{ id: 'M1', kind: 'fact', content: mistake.text, claimIds: ['mistake'], status: 'verified' }],
  }) }), /retired/);
});
