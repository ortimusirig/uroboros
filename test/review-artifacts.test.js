import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as artifacts from '../src/review.js';

const bundle = { version: 1, report: 'No blocking findings after checking the required behavior.', tests: [] };
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'uro-bundle-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

for (const [name, report] of [
  ['conflicting severity', '## F1\nSeverity: blocking\nDescription: Bug\nTest: __uro_review/tests/f1.js\nSeverity: suggestion'],
  ['duplicate description', '## F1\nSeverity: blocking\nDescription: Bug\nDescription: Excused\nTest: __uro_review/tests/f1.js'],
  ['duplicate test', '## F1\nSeverity: blocking\nDescription: Bug\nTest: __uro_review/tests/f1.js\nTest: missing'],
  ['duplicate category casing', '## F1\nSeverity: suggestion\nDescription: Bug\nCategory: correctness\ncategory: security'],
  ['duplicate identical field', '## F1\nSeverity: blocking\nSeverity: blocking\nDescription: Bug\nTest: __uro_review/tests/f1.js'],
  ['duplicate normalized ID', '## F1\nSeverity: blocking\nDescription: Bug\nTest: __uro_review/tests/f1.js\n## f1\nSeverity: suggestion\nDescription: Not a bug'],
  ['invalid finding heading', '## F1 extra\nSeverity: blocking\nDescription: Bug\nTest: __uro_review/tests/f1.js'],
]) test(`${name} is rejected before any review artifacts are written`, async t => {
  const cwd = fixture(t);
  await assert.rejects(() => artifacts.materializeReviewBundle({ cwd, bundle: { ...bundle, report,
    tests: [{ path: 'tests/f1.js', content: 'throw new Error("proof")' }] } }), /report/);
  assert.equal(existsSync(join(cwd, '__uro_review')), false);
});

test('review bundle materializes sanctioned artifacts with round and diff binding', async (t) => {
  const cwd = fixture(t);
  assert.equal(typeof artifacts.materializeReviewBundle, 'function');
  const receipt = await artifacts.materializeReviewBundle({ cwd, bundle: { ...bundle,
    report: '## F1\nSeverity: blocking\nDescription: Wrong branch\nTest: __uro_review/tests/nested/f1.test.js\n',
    tests: [{ path: 'tests/nested/f1.test.js', content: 'throw new Error("proof");\n' }],
  }, round: 2, diffDigest: 'abc' });
  assert.equal(receipt.round, 2);
  assert.equal(receipt.diffDigest, 'abc');
  assert.equal(readFileSync(join(cwd, '__uro_review/tests/nested/f1.test.js'), 'utf8'), 'throw new Error("proof");\n');
  assert.equal(artifacts.detectReview({ dir: cwd, artifact: receipt, round: 2, diffDigest: 'abc' }).reviewed, true);
  assert.equal(artifacts.detectReview({ dir: cwd, artifact: receipt, round: 3, diffDigest: 'abc' }).reviewed, false);
  assert.equal(artifacts.detectReview({ dir: cwd, artifact: receipt, round: 2, diffDigest: 'changed' }).reviewed, false);
});

for (const path of ['../outside.test.js', '/absolute.js', 'C:\\outside.js', '\\\\host\\x.js', 'tests/../x.js', 'tests\\..\\x.js', 'tests//x.js', 'tests/./x.js', 'tests/x\0.js', 'tests/x.txt', 'tests/CON.js']) {
  test(`invalid bundle path ${JSON.stringify(path)} fails before any write`, async (t) => {
    const cwd = fixture(t);
    assert.equal(typeof artifacts.materializeReviewBundle, 'function');
    await assert.rejects(async () => artifacts.materializeReviewBundle({ cwd, bundle: { ...bundle,
      tests: [{ path: 'tests/valid.js', content: 'valid' }, { path, content: 'bad' }],
    }, round: 1, diffDigest: 'abc' }));
    assert.equal(existsSync(join(cwd, '__uro_review')), false);
  });
}

test('duplicate and ancestor destinations are rejected as a whole', async (t) => {
  const cwd = fixture(t);
  assert.equal(typeof artifacts.materializeReviewBundle, 'function');
  for (const paths of [['tests/A.js', 'tests/a.js'], ['tests/a.js', 'tests/a.js/b.js']]) {
    await assert.rejects(async () => artifacts.materializeReviewBundle({ cwd, bundle: { ...bundle,
      tests: paths.map((path) => ({ path, content: '' })),
    }, round: 1, diffDigest: 'abc' }));
    assert.equal(existsSync(join(cwd, '__uro_review')), false);
  }
});

test('symlink review root is rejected without touching its target', async (t) => {
  const cwd = fixture(t), outside = join(cwd, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(cwd, '__uro_review'), 'junction');
  assert.equal(typeof artifacts.materializeReviewBundle, 'function');
  await assert.rejects(async () => artifacts.materializeReviewBundle({ cwd, bundle, round: 1, diffDigest: 'abc' }));
  assert.equal(existsSync(join(outside, 'REVIEW.md')), false);
});

test('invalid reviewer test references cannot carry blocking authority', async (t) => {
  const cwd = fixture(t);
  assert.equal(typeof artifacts.materializeReviewBundle, 'function');
  const receipt = await artifacts.materializeReviewBundle({ cwd, bundle: { ...bundle,
    report: '## F1\nSeverity: blocking\nDescription: Allegation\nTest: ../../external.js\n',
  }, round: 1, diffDigest: 'abc' });
  const review = artifacts.detectReview({ dir: cwd, artifact: receipt, round: 1, diffDigest: 'abc' });
  assert.equal(review.findings[0].severity, 'suggestion');
  writeFileSync(join(cwd, '__uro_review/REVIEW.md'), 'tampered');
  assert.equal(artifacts.detectReview({ dir: cwd, artifact: receipt, round: 1, diffDigest: 'abc' }).reviewed, false);
});

test('symlink parent and destination cannot redirect reviewer test writes', async (t) => {
  const cwd = fixture(t), outside = join(cwd, 'outside');
  mkdirSync(outside);
  mkdirSync(join(cwd, '__uro_review/tests'), { recursive: true });
  symlinkSync(outside, join(cwd, '__uro_review/tests/nested'), 'junction');
  await assert.rejects(() => artifacts.materializeReviewBundle({ cwd, bundle: { ...bundle,
    tests: [{ path: 'tests/nested/proof.js', content: 'must not escape' }] } }));
  assert.equal(existsSync(join(outside, 'proof.js')), false);
});

test('late write failure restores every previous artifact and leaves no partial success', async (t) => {
  const cwd = fixture(t);
  const before = await artifacts.materializeReviewBundle({ cwd, bundle: { ...bundle,
    tests: [{ path: 'tests/original.js', content: 'original' }] }, round: 1, diffDigest: 'before' });
  const write = fs.writeFileSync;
  let failed = false;
  fs.writeFileSync = (path, ...args) => {
    if (!failed && String(path).endsWith('manifest.json')) { failed = true; throw new Error('simulated disk failure'); }
    return write(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => artifacts.materializeReviewBundle({ cwd, bundle: { ...bundle, report: 'replacement',
      tests: [{ path: 'tests/original.js', content: 'changed' }, { path: 'tests/new.js', content: 'new' }] }, round: 2, diffDigest: 'after' }), /disk failure/);
  } finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal(readFileSync(join(cwd, '__uro_review/tests/original.js'), 'utf8'), 'original');
  assert.equal(existsSync(join(cwd, '__uro_review/tests/new.js')), false);
  assert.equal(artifacts.detectReview({ dir: cwd, artifact: before, round: 1, diffDigest: 'before' }).reviewed, true);
});

test('malformed schema and resource limits reject without touching old review artifacts', async (t) => {
  const cwd = fixture(t);
  for (const invalid of [{ ...bundle, version: 2 }, { ...bundle, report: '' }, { ...bundle, tests: {} },
    { ...bundle, tests: [{ path: 'tests/a.js', content: Buffer.from('binary') }] },
    { ...bundle, report: 'x'.repeat(1024 * 1024 + 1) },
    { ...bundle, tests: Array.from({ length: 101 }, (_, i) => ({ path: `tests/f${i}.js`, content: '' })) },
  ]) {
    await assert.rejects(() => artifacts.materializeReviewBundle({ cwd, bundle: invalid }));
    assert.equal(existsSync(join(cwd, '__uro_review')), false);
  }
});

test('a malformed structured report cannot masquerade as an empty findings review', async (t) => {
  const cwd = fixture(t);
  await assert.rejects(() => artifacts.materializeReviewBundle({ cwd, bundle: { ...bundle,
    report: '## F1\nSeverity: blocking\nCategory: correctness\n' } }), /report/);
  assert.equal(existsSync(join(cwd, '__uro_review')), false);
});
