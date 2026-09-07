import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutonomousDecisionResolver, operatorPresenceEvidence } from '../src/decision-resolver.js';
const question = { id: 'Q1', kind: 'authority', question: 'Choose an approach?', options: 'A, B' };
test('autonomous phase reviewer resolves authority with or without a terminal and is attributed', async () => {
  for (const [phase, provider] of [['planning','codex'],['execution','claude']]) {
    for (const ttyAttached of [true,false]) {
      const resolver = createAutonomousDecisionResolver({ phase, ttyAttached, reviewer: async r => {
        assert.equal(r.phase, phase);
        return { answer: 'B', reason: 'B meets the requirement' };
      } });
      const result = await resolver({ questions: [question], plan: 'plan' });
      assert.deepEqual(result.answers, [{ id: 'Q1', answer: 'B' }]);
      assert.equal(result.decidedBy, provider);
      assert.equal(result.role, 'reviewer');
      assert.equal(result.basis, 'reviewer');
      assert.equal(result.escalation, undefined);
    }
  }
});
test('headless manual mode preserves questions and never delegates authority', async () => {
  const resolver = createAutonomousDecisionResolver({ interactionMode: 'manual', phase: 'planning',
    ttyAttached: false, reviewer: () => { throw new Error('must not be called'); } });
  assert.deepEqual((await resolver({ questions: [question] })).answers, []);
});
test('execution arbiter alias remains usable and unavailable reviewers supply no answers', async () => {
  const resolver = createAutonomousDecisionResolver({ arbiter: async () => ({ answer: 'A' }) });
  assert.deepEqual((await resolver({ questions: [question] })).answers, [{ id:'Q1', answer:'A' }]);
  for (const reviewer of [undefined, async () => ({}), async () => { throw new Error('offline'); }]) {
    const unavailable = createAutonomousDecisionResolver({ phase: 'planning', reviewer });
    assert.deepEqual((await unavailable({ questions: [question] })).answers, []);
  }
});
test('presence evidence remains presentation data', () => {
  assert.equal(operatorPresenceEvidence({ ttyAttached:false }).operatorWait, 'not-acknowledged');
  assert.equal(operatorPresenceEvidence({ ttyAttached:true }).operatorWait, 'available');
});
