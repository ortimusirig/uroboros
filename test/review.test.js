import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReview, detectReview, REVIEW_DIR } from '../src/review.js';

// --- parseReview ---

test('parseReview returns structured findings for valid review markdown', () => {
  const findings = parseReview(`
## F1
Severity: blocking
Category: correctness
Description: The PSI calculation divides by zero when a bin has zero reference count.
Test: __uro_review/tests/test_review_f1.py

## F2
Severity: suggestion
Category: edge-case
Description: No handling for NaN inputs in the reference series.
  `);

  assert.deepEqual(findings, [
    {
      id: 'F1',
      severity: 'blocking',
      category: 'correctness',
      description: 'The PSI calculation divides by zero when a bin has zero reference count.',
      test: '__uro_review/tests/test_review_f1.py',
    },
    {
      id: 'F2',
      severity: 'suggestion',
      category: 'edge-case',
      description: 'No handling for NaN inputs in the reference series.',
      test: null,
    },
  ]);
});

test('parseReview returns null for empty or malformed content', () => {
  assert.equal(parseReview('   \n'), null);
  assert.equal(parseReview('# Review\n\nDescription: Missing an F heading'), null);
  assert.equal(parseReview('## F1\nSeverity: critical\nDescription: Invalid severity'), null);
  assert.equal(parseReview('## F1\nSeverity: blocking'), null);
});

test('parseReview accepts both blocking and suggestion severities', () => {
  const findings = parseReview(`
## F1
Severity: blocking
Description: A real bug.
Test: __uro_review/tests/test_f1.py

## F2
Severity: suggestion
Description: A nice-to-have improvement.
  `);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'blocking');
  assert.equal(findings[1].severity, 'suggestion');
});

test('parseReview demotes blocking finding without test to suggestion', () => {
  const findings = parseReview(`
## F1
Severity: blocking
Description: A bug with no test to prove it.
  `);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'suggestion');
});

test('parseReview preserves multi-word descriptions', () => {
  const findings = parseReview(`
## F1
Severity: suggestion
Category: performance
Description: The nested loop in compute() has O(n^2) complexity when the input exceeds 10k rows.
  `);
  assert.equal(findings[0].description,
    'The nested loop in compute() has O(n^2) complexity when the input exceeds 10k rows.');
});

// --- detectReview ---

test('detectReview returns findings when REVIEW.md exists in __uro_review/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  try {
    const reviewDir = join(dir, REVIEW_DIR);
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(reviewDir, 'REVIEW.md'), `
## F1
Severity: blocking
Category: correctness
Description: Off-by-one in the loop boundary.
Test: __uro_review/tests/test_f1.py
`);
    mkdirSync(join(reviewDir, 'tests'), { recursive: true });
    writeFileSync(join(reviewDir, 'tests', 'test_f1.py'), 'def test_boundary(): pass\n');

    const result = detectReview({ dir });
    assert.equal(result.reviewed, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].id, 'F1');
    assert.deepEqual(result.testFiles, ['__uro_review/tests/test_f1.py']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectReview returns reviewed false when __uro_review/ does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  try {
    assert.deepEqual(detectReview({ dir }), { reviewed: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectReview returns reviewed false when REVIEW.md is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  try {
    const reviewDir = join(dir, REVIEW_DIR);
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(reviewDir, 'REVIEW.md'), '   \n');
    assert.deepEqual(detectReview({ dir }), { reviewed: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectReview lists all test files under __uro_review/tests/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  try {
    const reviewDir = join(dir, REVIEW_DIR);
    mkdirSync(join(reviewDir, 'tests'), { recursive: true });
    writeFileSync(join(reviewDir, 'REVIEW.md'), `
## F1
Severity: blocking
Description: Bug A.
Test: __uro_review/tests/test_a.py

## F2
Severity: blocking
Description: Bug B.
Test: __uro_review/tests/test_b.py
`);
    writeFileSync(join(reviewDir, 'tests', 'test_a.py'), 'def test_a(): pass\n');
    writeFileSync(join(reviewDir, 'tests', 'test_b.py'), 'def test_b(): pass\n');

    const result = detectReview({ dir });
    assert.equal(result.testFiles.length, 2);
    assert.ok(result.testFiles.includes('__uro_review/tests/test_a.py'));
    assert.ok(result.testFiles.includes('__uro_review/tests/test_b.py'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- REVIEW_DIR export ---

test('REVIEW_DIR is the string __uro_review', () => {
  assert.equal(REVIEW_DIR, '__uro_review');
});
