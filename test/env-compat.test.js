import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnv, resetDeprecationWarnings } from '../src/env-compat.js';

test('URO_ wins when both prefixes are set', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const value = readEnv(
    { URO_SCRATCH_ROOT: 'C:/uro/w', CCC_SCRATCH_ROOT: 'C:/ccc/w' },
    'SCRATCH_ROOT',
    { warn: (m) => warnings.push(m) },
  );
  assert.equal(value, 'C:/uro/w');
  assert.deepEqual(warnings, [], 'no deprecation warning when the current name is set');
});

test('an aliased variable falls back to CCC_ and warns once', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const env = { CCC_PUBLISH_BLOCKLIST: 'C:/uro/blocklist.txt' };
  const warn = (m) => warnings.push(m);
  assert.equal(readEnv(env, 'PUBLISH_BLOCKLIST', { warn }), 'C:/uro/blocklist.txt');
  assert.equal(readEnv(env, 'PUBLISH_BLOCKLIST', { warn }), 'C:/uro/blocklist.txt');
  assert.equal(warnings.length, 1, 'the deprecation warning is emitted once per variable');
  assert.match(warnings[0], /CCC_PUBLISH_BLOCKLIST/);
  assert.match(warnings[0], /URO_PUBLISH_BLOCKLIST/);
});

test('CCC_ remains the fallback when the bare variable is also set', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const value = readEnv(
    { CCC_EXECUTOR_TIMEOUT_MS: '1200000', EXECUTOR_TIMEOUT_MS: '3600000' },
    'EXECUTOR_TIMEOUT_MS',
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(value, '1200000');
  assert.deepEqual(warnings, [
    'CCC_EXECUTOR_TIMEOUT_MS is deprecated; rename it to URO_EXECUTOR_TIMEOUT_MS',
  ]);
});

test('a non-aliased variable does not fall back to CCC_', () => {
  // Positive control: proves the alias list is consulted rather than every name
  // falling back, which would make the previous assertion pass vacuously.
  resetDeprecationWarnings();
  const warnings = [];
  const value = readEnv(
    { CCC_TEST_SCRATCH_ROOT: 'C:/legacy' },
    'TEST_SCRATCH_ROOT',
    { warn: (m) => warnings.push(m) },
  );
  assert.equal(value, undefined, 'internal variables have no compatibility alias');
  assert.deepEqual(warnings, []);
});

test('returns undefined when neither prefix is set', () => {
  resetDeprecationWarnings();
  assert.equal(readEnv({}, 'SCRATCH_ROOT', { warn: () => {} }), undefined);
});

test('a recognised unprefixed variable is ignored with a corrective warning', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const value = readEnv(
    { EXECUTOR_TIMEOUT_MS: '3600000' },
    'EXECUTOR_TIMEOUT_MS',
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(value, undefined, 'the bare value remains ignored');
  assert.deepEqual(warnings, [
    'EXECUTOR_TIMEOUT_MS is set but ignored — did you mean URO_EXECUTOR_TIMEOUT_MS?',
  ]);
});

test('a recognised unprefixed variable warns only once per suffix', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const env = { EXECUTOR_TIMEOUT_MS: '3600000' };
  const warn = (message) => warnings.push(message);
  assert.equal(readEnv(env, 'EXECUTOR_TIMEOUT_MS', { warn }), undefined);
  assert.equal(readEnv(env, 'EXECUTOR_TIMEOUT_MS', { warn }), undefined);
  assert.equal(warnings.length, 1);
});

test('resetDeprecationWarnings re-arms an unprefixed-variable warning', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const env = { EXECUTOR_TIMEOUT_MS: '3600000' };
  const warn = (message) => warnings.push(message);
  readEnv(env, 'EXECUTOR_TIMEOUT_MS', { warn });
  resetDeprecationWarnings();
  readEnv(env, 'EXECUTOR_TIMEOUT_MS', { warn });
  assert.equal(warnings.length, 2);
});

test('URO_ wins over an unprefixed variable without warning', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const value = readEnv(
    { URO_EXECUTOR_TIMEOUT_MS: '1200000', EXECUTOR_TIMEOUT_MS: '3600000' },
    'EXECUTOR_TIMEOUT_MS',
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(value, '1200000');
  assert.deepEqual(warnings, []);
});

test('an unprefixed variable outside the alias list is ignored without warning', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const value = readEnv(
    { TEST_SCRATCH_ROOT: 'C:/scratch' },
    'TEST_SCRATCH_ROOT',
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(value, undefined);
  assert.deepEqual(warnings, []);
});
