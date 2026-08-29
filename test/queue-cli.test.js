import assert from 'node:assert/strict';
import test from 'node:test';
import { CLI_USAGE } from '../src/cli-help.js';
import { executeQueueCommand } from '../src/queue-cli.js';

test('the queue command sends parsed limits, mode, target, and runtime seams to runQueue', async () => {
  const runtime = { launchRun: async () => {} };
  const calls = [];
  const expected = { summary: 'Units landed: 2\n', stop: null };

  const result = await executeQueueCommand({
    command: 'queue',
    file: 'queue.json',
    mode: 'autonomous',
    maxRuns: 2,
    tokenBudget: 5000,
    dryRun: true,
  }, {
    target: 'C:/target',
    runtime,
    runQueueFn: async (options) => {
      calls.push(options);
      return expected;
    },
  });

  assert.equal(result, expected);
  assert.deepEqual(calls, [{
    file: 'queue.json',
    target: 'C:/target',
    mode: 'autonomous',
    maxRuns: 2,
    tokenBudget: 5000,
    dryRun: true,
    dependencies: runtime,
  }]);
});

test('the queue command creates the production runtime when one is not injected', async () => {
  const runtime = { production: true };
  let runtimeCreations = 0;
  let received;

  await executeQueueCommand({
    command: 'queue',
    file: 'queue.json',
    mode: 'manual',
    dryRun: false,
  }, {
    target: 'C:/target',
    createRuntime: () => { runtimeCreations++; return runtime; },
    runQueueFn: async (options) => { received = options; return { summary: '' }; },
  });

  assert.equal(runtimeCreations, 1);
  assert.equal(received.dependencies, runtime);
  assert.equal(Object.hasOwn(received, 'maxRuns'), false);
  assert.equal(Object.hasOwn(received, 'tokenBudget'), false);
});

test('help documents the queue file, autonomous mode, limits, and dry-run', () => {
  assert.match(CLI_USAGE, /queue --file <queue[.]json>/);
  assert.match(CLI_USAGE, /--mode <manual\|autonomous>/);
  assert.match(CLI_USAGE, /--max-runs <n>/);
  assert.match(CLI_USAGE, /--token-budget <tokens>/);
  assert.match(CLI_USAGE, /--dry-run/);
  assert.match(CLI_USAGE, /queue\s+Run and safely land queue units in order/);
});
