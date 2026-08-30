import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GATE_TIMEOUT_MS,
  resolveStageTimeouts,
} from '../src/timeouts.js';

test('agent seats default to no elapsed timeout while the gate keeps sixty minutes', () => {
  assert.deepEqual(resolveStageTimeouts({}), {
    executor: undefined,
    verifier: undefined,
    gate: DEFAULT_GATE_TIMEOUT_MS,
  });
  assert.equal(DEFAULT_GATE_TIMEOUT_MS, 60 * 60 * 1000);
});

test('each stage timeout is overridable by its URO_ environment variable', () => {
  assert.deepEqual(resolveStageTimeouts({
    URO_EXECUTOR_TIMEOUT_MS: '101',
    URO_VERIFIER_TIMEOUT_MS: '202',
    URO_GATE_TIMEOUT_MS: '303',
  }), { executor: 101, verifier: 202, gate: 303 });
});

test('explicit stage timeout values override their environment variables', () => {
  assert.deepEqual(resolveStageTimeouts({
    URO_EXECUTOR_TIMEOUT_MS: '101',
    URO_VERIFIER_TIMEOUT_MS: '202',
    URO_GATE_TIMEOUT_MS: '303',
  }, {
    executorTimeout: 404,
    verifierTimeout: 505,
    gateTimeout: 606,
  }), { executor: 404, verifier: 505, gate: 606 });
});

test('an omitted explicit timeout still resolves from the environment and defaults', () => {
  assert.deepEqual(resolveStageTimeouts({
    URO_VERIFIER_TIMEOUT_MS: '202',
  }, {
    executorTimeout: 404,
  }), {
    executor: 404,
    verifier: 202,
    gate: DEFAULT_GATE_TIMEOUT_MS,
  });
});

test('invalid configured timeouts fail loudly', () => {
  assert.throws(() => resolveStageTimeouts({ URO_EXECUTOR_TIMEOUT_MS: '0' }),
    new Error('URO_EXECUTOR_TIMEOUT_MS must be between 1 and 2147483647 milliseconds'));
  assert.throws(() => resolveStageTimeouts({ URO_GATE_TIMEOUT_MS: 'tomorrow' }),
    new Error('URO_GATE_TIMEOUT_MS must be a positive integer number of milliseconds'));
});
