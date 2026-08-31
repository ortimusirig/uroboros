import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewerTestCommands } from '../src/gate.js';

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
