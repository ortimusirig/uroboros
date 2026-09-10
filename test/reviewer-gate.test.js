import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewerTestCommands } from '../src/gate.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runNestedGate } from './fixtures/nested-gate.js';

test('nested gate runs actual Node test bodies and restores the parent marker on success and rejection', async t => {
  const root = mkdtempSync(join(tmpdir(), 'nested-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const present = Object.hasOwn(process.env, 'NODE_TEST_CONTEXT'), previous = process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (present) process.env.NODE_TEST_CONTEXT = previous; else delete process.env.NODE_TEST_CONTEXT; });
  writeFileSync(join(root, 'proof.test.cjs'), "require('node:test')('actual body',()=>{require('node:fs').writeFileSync('body.txt','executed');process.stdout.write('nested-proof-output')});");
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  const receipts = [];
  const result = await runNestedGate({ cwd: root, commands: [{ bin: process.execPath, args: ['--test', 'proof.test.cjs'] }], requiredEvidence: true,
    codeIdentity: () => 'fixture-before-command', onEvidence: entry => receipts.push(entry) });
  assert.equal(result.passed, true); assert.equal(readFileSync(join(root, 'body.txt'), 'utf8'), 'executed');
  assert.match(receipts[0].stdout, /nested-proof-output/); assert.doesNotMatch(receipts[0].stderr, /skipping running files/);
  assert.deepEqual(receipts[0].argv, [process.execPath, '--test', 'proof.test.cjs']); assert.equal(receipts[0].cwd, root);
  assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8');
  await assert.rejects(runNestedGate({ cwd: root, commands: [], requiredEvidence: true }), /required command evidence/);
  assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8');
  delete process.env.NODE_TEST_CONTEXT;
  await assert.rejects(runNestedGate({ cwd: root, commands: [], requiredEvidence: true }), /required command evidence/);
  assert.equal(Object.hasOwn(process.env, 'NODE_TEST_CONTEXT'), false);
});

test('reviewer tests run after operator commands with the target gate framework', () => {
  const operatorCommands = [
    { bin: 'node', args: ['--test', 'test/original.test.js'] },
    { bin: 'python', args: ['-m', 'pytest', 'test'] },
  ];
  const reviewerTests = [
    '__uro_review/tests/f1.test.js',
    '__uro_review/tests/test_f2.py',
  ];

  const reviewerCommands = buildReviewerTestCommands(operatorCommands, reviewerTests);

  assert.deepEqual(reviewerCommands, [
    { bin: 'node', args: ['--test', 'test/original.test.js', '__uro_review/tests/f1.test.js'],
      harness: 'uro-review-tests' },
    { bin: 'python', args: ['-m', 'pytest', 'test', '__uro_review/tests/test_f2.py'],
      harness: 'uro-review-tests' },
  ]);
  assert.deepEqual([...operatorCommands, ...reviewerCommands].slice(0, operatorCommands.length),
    operatorCommands, 'operator commands must remain first and byte-for-byte unchanged');
});

test('reviewer test command construction de-duplicates accumulated files', () => {
  const commands = [{ bin: 'node', args: ['--test'] }];
  assert.deepEqual(buildReviewerTestCommands(commands, [
    '__uro_review/tests/f1.test.js',
    '__uro_review/tests/f1.test.js',
    '__uro_review/tests/f2.test.mjs',
  ])[0].args, [
    '--test', '__uro_review/tests/f1.test.js', '__uro_review/tests/f2.test.mjs',
  ]);
});

test('package-script gates receive reviewer paths after the argument separator', () => {
  assert.deepEqual(buildReviewerTestCommands(
    [{ bin: 'npm', args: ['test'] }],
    ['__uro_review/tests/f1.test.js'],
  )[0].args, ['test', '--', '__uro_review/tests/f1.test.js']);
});

test('collected languages without a verified file invocation fail closed', () => {
  const commands = [
    { bin: 'go', args: ['test', './...'] },
    { bin: 'cargo', args: ['test', '--workspace'] },
    { bin: 'dotnet', args: ['test'] },
    { bin: 'mvn', args: ['test'] },
  ];
  const reviewerCommands = buildReviewerTestCommands(commands, [
    '__uro_review/tests/f1_test.go',
    '__uro_review/tests/f2_test.rs',
    '__uro_review/tests/F3Tests.cs',
    '__uro_review/tests/F4Test.java',
  ]);

  assert.equal(reviewerCommands.length, 1);
  assert.equal(reviewerCommands[0].bin, process.execPath);
  assert.equal(reviewerCommands[0].harness, 'uro-review-tests');
  const failureScript = reviewerCommands[0].args.join(' ');
  for (const file of [
    '__uro_review/tests/f1_test.go',
    '__uro_review/tests/f2_test.rs',
    '__uro_review/tests/F3Tests.cs',
    '__uro_review/tests/F4Test.java',
  ]) assert.match(failureScript, new RegExp(file.replaceAll('.', '[.]')));
  assert.match(failureScript, /No operator gate command can run reviewer tests/);
});

test('bare ruby fails closed because trailing paths are only ARGV, while rspec is supported', () => {
  const file = '__uro_review/tests/f1_spec.rb';
  const bareRuby = buildReviewerTestCommands(
    [{ bin: 'ruby', args: ['test/original_test.rb'] }],
    [file],
  );
  assert.equal(bareRuby[0].bin, process.execPath);
  assert.match(bareRuby[0].args.join(' '), /No operator gate command/);

  assert.deepEqual(buildReviewerTestCommands(
    [{ bin: 'bundle', args: ['exec', 'rspec', 'spec'] }],
    [file],
  )[0], {
    bin: 'bundle',
    args: ['exec', 'rspec', 'spec', file],
    harness: 'uro-review-tests',
  });
});
