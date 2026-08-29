import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runPlanGate } from '../src/plan-gate.js';

function fixture() {
  const target = mkdtempSync(join(process.cwd(), '.ccc-test-plan-gate-'));
  mkdirSync(join(target, 'src'));
  mkdirSync(join(target, 'test'));
  writeFileSync(join(target, 'src', 'real.js'), 'export const real = true;\n');
  writeFileSync(join(target, 'test', 'real.test.js'), 'test placeholder\n');
  return { target, cleanup: () => rmSync(target, { recursive: true, force: true }) };
}

function validPlan(testRequirement = '1. Verify the real behavior with an observable assertion.') {
  return [
    '## Title',
    '',
    'Checked plan',
    '',
    '## Required behavior',
    '',
    'Use `src/real.js:1` as repository evidence.',
    '',
    '## Invariants',
    '',
    'Existing behavior remains stable.',
    '',
    '## Test requirements',
    '',
    testRequirement,
    '',
    '## Out of scope',
    '',
    'Unrelated changes.',
    '',
  ].join('\n');
}

const validGate = [{ bin: 'node', args: ['--test', 'test/real.test.js'] }];
const passes = async ({ commands }) => ({
  passed: true,
  results: commands.map((command) => ({ ...command, code: 0 })),
});

test('positive control: a well-formed plan passes every mechanical check', async () => {
  const item = fixture();
  try {
    const result = await runPlanGate({
      plan: validPlan('1. Assert the sentinel is absent, with a positive control that first creates it.'),
      gate: validGate,
      target: item.target,
      executeGate: passes,
    });
    assert.deepEqual(result, { passed: true, failures: [] });
  } finally {
    item.cleanup();
  }
});

test('an unrunnable proposed gate fails independently and names the command', async () => {
  const item = fixture();
  try {
    const result = await runPlanGate({
      plan: validPlan(), gate: validGate, target: item.target,
      executeGate: async ({ commands }) => ({
        passed: false, results: [{ ...commands[0], code: 9 }],
      }),
    });
    assert.equal(result.passed, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /exited 9.*test[/\\]real[.]test[.]js/i);
  } finally { item.cleanup(); }
});

test('a cited path that does not exist fails independently', async () => {
  const item = fixture();
  try {
    const result = await runPlanGate({
      plan: validPlan().replace('`src/real.js:1`', '`src/missing.js`'),
      gate: validGate, target: item.target, executeGate: passes,
    });
    assert.deepEqual(result.failures.map((item) => item.check), ['cited-paths']);
    assert.match(result.failures[0].message, /src[/\\]missing[.]js/);
  } finally { item.cleanup(); }
});

test('a cited line beyond the real file length fails independently', async () => {
  const item = fixture();
  try {
    const result = await runPlanGate({
      plan: validPlan().replace('src/real.js:1', 'src/real.js:99'),
      gate: validGate, target: item.target, executeGate: passes,
    });
    assert.deepEqual(result.failures.map((item) => item.check), ['cited-lines']);
    assert.match(result.failures[0].message, /src[/\\]real[.]js:99.*has 1 lines/i);
  } finally { item.cleanup(); }
});

test('a gate-named test file that does not exist fails independently', async () => {
  const item = fixture();
  try {
    const result = await runPlanGate({
      plan: validPlan(),
      gate: [{ bin: 'node', args: ['--test', 'test/imaginary.test.js'] }],
      target: item.target,
      executeGate: passes,
    });
    assert.deepEqual(result.failures.map((item) => item.check), ['named-test-files']);
    assert.match(result.failures[0].message, /test[/\\]imaginary[.]test[.]js/);
  } finally { item.cleanup(); }
});

test('a missing required section fails independently', async () => {
  const item = fixture();
  try {
    const plan = validPlan().replace(/## Invariants[\s\S]*?(?=## Test requirements)/, '');
    const result = await runPlanGate({ plan, gate: validGate, target: item.target, executeGate: passes });
    assert.deepEqual(result.failures.map((item) => item.check), ['required-sections']);
    assert.match(result.failures[0].message, /Invariants/);
  } finally { item.cleanup(); }
});

test('an absence assertion without an adjacent positive control fails independently', async () => {
  const item = fixture();
  try {
    const result = await runPlanGate({
      plan: validPlan('1. Assert the obsolete output is absent.'),
      gate: validGate, target: item.target, executeGate: passes,
    });
    assert.deepEqual(result.failures.map((item) => item.check), ['absence-controls']);
    assert.match(result.failures[0].message, /positive control/i);
  } finally { item.cleanup(); }
});
