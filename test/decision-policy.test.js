import test from 'node:test';
import assert from 'node:assert/strict';
test('authority follows phase and explicit mode, rejecting unknown values', async () => {
  const policy = await import('../src/decision-policy.js').catch(() => ({}));
  assert.equal(typeof policy.decisionAuthority, 'function', 'phase authority policy is available');
  for (const [interactionMode, phase, expected] of [
    ['manual', 'planning', 'human'], ['manual', 'execution', 'human'],
    ['autonomous', 'planning', 'codex'], ['autonomous', 'execution', 'claude'],
  ]) assert.equal(policy.decisionAuthority({ interactionMode, phase }), expected);
  assert.equal(policy.decisionAuthority({ phase: 'planning' }), 'human');
  assert.throws(() => policy.decisionAuthority({ phase: 'goal' }), /phase/);
  assert.throws(() => policy.decisionAuthority({ interactionMode: 'automatic', phase: 'planning' }), /mode/);
});
