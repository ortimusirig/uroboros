import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutonomousDecisionResolver,
  operatorPresenceEvidence,
} from '../src/decision-resolver.js';

const question = (kind = 'technical', recommendation = 'use the existing convention') => ({
  id: 'Q1',
  kind,
  question: 'Which approach should be used?',
  options: 'invent a new approach, use the existing convention',
  recommendation,
});

test('the autonomous resolver adopts only stated recommendations without a model call', async () => {
  const resolver = createAutonomousDecisionResolver({
    ttyAttached: true,
    invocation: 'interactive',
  });
  assert.deepEqual(await resolver({
    questions: [question()], plan: 'approved plan', task: 'task text',
  }), { answers: [{ id: 'Q1', answer: 'use the existing convention' }] });
  assert.deepEqual(await resolver({
    questions: [question('technical', null)], plan: 'approved plan', task: 'task text',
  }), { answers: [] });
});

test('authority resolution requires no-TTY evidence and records its reasoning', async () => {
  const present = createAutonomousDecisionResolver({
    ttyAttached: true,
    invocation: 'interactive',
  });
  assert.deepEqual(await present({ questions: [question('authority')] }), { answers: [] });

  const absent = createAutonomousDecisionResolver({
    ttyAttached: false,
    invocation: 'non-interactive',
  });
  const resolution = await absent({ questions: [question('authority')] });
  assert.deepEqual(resolution.answers, [{ id: 'Q1', answer: 'use the existing convention' }]);
  assert.equal(resolution.escalation, 'operator-absent');
  assert.deepEqual(resolution.presenceEvidence, {
    ttyAttached: false,
    invocation: 'non-interactive',
    operatorWait: 'not-acknowledged',
  });
  assert.match(resolution.reasoning, /No TTY.*non-interactively/i);
});

test('presence evidence distinguishes interactive and non-interactive invocation', () => {
  assert.deepEqual(operatorPresenceEvidence({ ttyAttached: true }), {
    ttyAttached: true,
    invocation: 'interactive',
    operatorWait: 'available',
  });
  assert.deepEqual(operatorPresenceEvidence({ ttyAttached: false }), {
    ttyAttached: false,
    invocation: 'non-interactive',
    operatorWait: 'not-acknowledged',
  });
});
