import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import test from 'node:test';
import { collectPlanCitations, runPlanGate } from '../src/plan-gate.js';

const posix = (value) => value.split(sep).join('/');

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

test('a Windows file-URL citation resolves inside the target, not outside it', async () => {
  // Codex on Windows cites files as /C:/repo/src/thing.js. resolve() turns that
  // into C:\C:\repo\src\thing.js, so a TRUE citation was reported as "outside
  // the target" — a peer measured 11 of 13 failures in one round being this.
  const target = process.cwd();
  const cited = `/${posix(target)}/package.json`;
  const { paths } = collectPlanCitations(`See [manifest](${cited}) for the name.`);

  assert.deepEqual(paths, [`${posix(target)}/package.json`],
    'the leading slash before the drive letter must be stripped');

  const result = await runPlanGate({
    plan: `## Title\n\nSee [manifest](${cited}).\n`,
    gate: [{ bin: 'node', args: ['--test'] }],
    target,
  });
  const citationFailures = (result.failures ?? []).filter((f) => f.check === 'cited-paths');
  assert.deepEqual(citationFailures, [], 'a real file inside the target must not fail');
});

test('a backticked dotted identifier is not claimed to be a missing file', async () => {
  // `args.instruction` and `facts.runId` match name.ext exactly as README.md
  // does. Nothing distinguishes them without a path separator, so a missing bare
  // token is not reported rather than reported wrongly.
  const { paths, ambiguousPaths } = collectPlanCitations(
    'The field `args.instruction` carries the goal, and `src/run.js` reads it.',
  );
  assert.deepEqual(paths, ['src/run.js']);
  assert.deepEqual(ambiguousPaths, ['args.instruction']);

  const result = await runPlanGate({
    plan: '## Title\n\nThe field `args.instruction` carries the goal.\n',
    gate: [{ bin: 'node', args: ['--test'] }],
    target: process.cwd(),
  });
  assert.deepEqual((result.failures ?? []).filter((f) => f.check === 'cited-paths'), [],
    'an identifier must not be reported as a missing file');
});

test('a genuinely missing path with a separator is still reported', async () => {
  // Narrowness control: separating out bare tokens must not stop the check
  // catching a real broken citation.
  const result = await runPlanGate({
    plan: '## Title\n\nSee `src/definitely-not-here.js` for the loop.\n',
    gate: [{ bin: 'node', args: ['--test'] }],
    target: process.cwd(),
  });
  const missing = (result.failures ?? []).filter((f) => f.check === 'cited-paths');
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /does not exist: src\/definitely-not-here\.js/);
});
