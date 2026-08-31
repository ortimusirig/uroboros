import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixPlan, validateFindings } from '../src/fix-plan.js';

// --- validateFindings ---

test('validateFindings accepts all findings when all are valid', () => {
  const findings = [
    { id: 'F1', severity: 'blocking', category: 'correctness', description: 'Division by zero.', test: 't.py' },
    { id: 'F2', severity: 'suggestion', category: 'edge-case', description: 'NaN not handled.', test: null },
  ];
  const result = validateFindings(findings);
  assert.deepEqual(result.accepted, ['F1', 'F2']);
  assert.deepEqual(result.rejected, []);
});

test('validateFindings rejects findings with empty description', () => {
  const findings = [
    { id: 'F1', severity: 'blocking', category: 'correctness', description: '', test: 't.py' },
  ];
  const result = validateFindings(findings);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected, ['F1']);
});

test('validateFindings handles mixed valid and invalid findings', () => {
  const findings = [
    { id: 'F1', severity: 'blocking', description: 'Real bug.', test: 't.py' },
    { id: 'F2', severity: 'blocking', description: '', test: null },
    { id: 'F3', severity: 'suggestion', description: 'Minor issue.', test: null },
  ];
  const result = validateFindings(findings);
  assert.deepEqual(result.accepted, ['F1', 'F3']);
  assert.deepEqual(result.rejected, ['F2']);
});

test('validateFindings returns empty accepted for null input', () => {
  const result = validateFindings(null);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected, []);
});

test('validateFindings returns empty accepted for empty array', () => {
  const result = validateFindings([]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected, []);
});

test('arbiter-invalid findings enter rejected and render as overruled', async () => {
  const findings = [
    { id: 'F1', severity: 'blocking', description: 'Real bug.', test: 't.py' },
    { id: 'F2', severity: 'blocking', description: 'False positive.', test: 'f.py' },
  ];
  const result = await validateFindings(findings, {
    arbiter: async ({ finding }) => finding.id === 'F2'
      ? { verdict: 'invalid', reason: 'The diff already guards this path.' }
      : { verdict: 'valid' },
    diff: 'diff',
    plan: 'plan',
  });
  assert.deepEqual(result.accepted, ['F1']);
  assert.deepEqual(result.rejected, ['F2']);
  assert.match(buildFixPlan({ findings, ...result, originalTask: 'Task.' }),
    /F2 rejected \(overruled\)/);
});

test('an unavailable arbiter accepts the reviewer objection', async () => {
  const findings = [{ id: 'F1', severity: 'blocking', description: 'Keep me.', test: 't.py' }];
  const result = await validateFindings(findings, {
    arbiter: async () => ({ verdict: 'UNVERIFIED' }),
  });
  assert.deepEqual(result.accepted, ['F1']);
  assert.deepEqual(result.rejected, []);
});

// --- buildFixPlan ---

test('buildFixPlan produces markdown with validated findings section', () => {
  const findings = [
    { id: 'F1', severity: 'blocking', category: 'correctness', description: 'Division by zero in compute_psi.', test: '__uro_review/tests/test_f1.py' },
    { id: 'F2', severity: 'suggestion', category: 'edge-case', description: 'NaN inputs not handled.', test: null },
  ];
  const plan = buildFixPlan({
    findings,
    accepted: ['F1', 'F2'],
    rejected: [],
    originalTask: 'Implement PSI calculator.',
  });

  assert.equal(typeof plan, 'string');
  assert.match(plan, /## Validated Findings/);
  assert.match(plan, /F1.*blocking/);
  assert.match(plan, /F2.*suggestion/);
  assert.match(plan, /Division by zero/);
  assert.match(plan, /NaN inputs/);
});

test('buildFixPlan includes original task context', () => {
  const plan = buildFixPlan({
    findings: [{ id: 'F1', severity: 'blocking', description: 'Bug.', test: 't.py' }],
    accepted: ['F1'],
    rejected: [],
    originalTask: 'Build the drift calculator.',
  });

  assert.match(plan, /Build the drift calculator/);
});

test('buildFixPlan includes test file paths in cursor tests section', () => {
  const findings = [
    { id: 'F1', severity: 'blocking', description: 'Bug.', test: '__uro_review/tests/test_f1.py' },
    { id: 'F2', severity: 'blocking', description: 'Bug 2.', test: '__uro_review/tests/test_f2.py' },
  ];
  const plan = buildFixPlan({
    findings,
    accepted: ['F1', 'F2'],
    rejected: [],
    originalTask: 'Build something.',
  });

  assert.match(plan, /__uro_review\/tests\/test_f1\.py/);
  assert.match(plan, /__uro_review\/tests\/test_f2\.py/);
  assert.match(plan, /Do NOT modify or delete/i);
});

test('buildFixPlan marks rejected findings as overruled', () => {
  const findings = [
    { id: 'F1', severity: 'blocking', description: 'Real bug.', test: 't.py' },
    { id: 'F2', severity: 'suggestion', description: 'Not a real issue.', test: null },
  ];
  const plan = buildFixPlan({
    findings,
    accepted: ['F1'],
    rejected: ['F2'],
    originalTask: 'Task.',
  });

  assert.match(plan, /F1/);
  assert.match(plan, /F2.*overruled|rejected/i);
});

test('buildFixPlan returns empty string when no findings accepted', () => {
  const plan = buildFixPlan({
    findings: [],
    accepted: [],
    rejected: [],
    originalTask: 'Task.',
  });

  assert.equal(plan, '');
});
