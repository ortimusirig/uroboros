import assert from 'node:assert/strict';
import test from 'node:test';
import { CLI_USAGE } from '../src/cli-help.js';
import { executeQueueCommand as executeQueue } from '../src/queue-cli.js';

const VERIFIED_SUPERPOWERS = {
  ok: true,
  seats: {
    codex: { seat: 'codex', verified: true, evidence: 'registry', version: '6.3.0' },
    cursor: { seat: 'cursor', verified: true, evidence: 'manifest', version: '6.0.2' },
    claude: { seat: 'claude', verified: true, evidence: 'manifest', version: '6.0.2' },
  },
};

const executeQueueCommand = (options, dependencies = {}) => executeQueue(options, {
  verifySuperpowers: async () => VERIFIED_SUPERPOWERS,
  ...dependencies,
});

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
    acceptGoalSpec: 'goals/G1-first/spec.md',
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
    acceptGoalSpec: 'goals/G1-first/spec.md',
    dryRun: true,
    dependencies: runtime,
  }]);
});

test('the queue command creates the production runtime when one is not injected', async () => {
  const runtime = { production: true };
  const env = { CODEX_HOME: 'C:/registered-codex-home' };
  let runtimeCreations = 0;
  let runtimeOptions;
  let received;

  await executeQueueCommand({
    command: 'queue',
    file: 'queue.json',
    mode: 'manual',
    dryRun: false,
  }, {
    target: 'C:/target',
    env,
    createRuntime: (options) => { runtimeCreations++; runtimeOptions = options; return runtime; },
    runQueueFn: async (options) => { received = options; return { summary: '' }; },
  });

  assert.equal(runtimeCreations, 1);
  assert.deepEqual(runtimeOptions, { env });
  assert.equal(received.dependencies, runtime);
  assert.equal(Object.hasOwn(received, 'maxRuns'), false);
  assert.equal(Object.hasOwn(received, 'tokenBudget'), false);
  assert.equal(Object.hasOwn(received, 'acceptGoalSpec'), false);
});

test('help documents the queue file, autonomous mode, limits, acceptance, and dry-run', () => {
  assert.match(CLI_USAGE, /queue --file <queue[.]json>/);
  assert.match(CLI_USAGE, /--accept-goal <spec[.]md>/);
  assert.match(CLI_USAGE, /--mode <manual\|autonomous>/);
  assert.match(CLI_USAGE, /--max-runs <n>/);
  assert.match(CLI_USAGE, /--token-budget <tokens>/);
  assert.match(CLI_USAGE, /--dry-run/);
  assert.match(CLI_USAGE, /queue\s+Run and safely land queue units in order/);
});

test('queue refuses an unverified seat before creating a runtime or running the queue', async () => {
  let runtimeCreations = 0;
  let queueCalls = 0;
  await assert.rejects(executeQueueCommand({
    command: 'queue', file: 'queue.json', mode: 'manual', dryRun: false,
  }, {
    target: 'C:/target',
    verifySuperpowers: async () => ({
      ok: false,
      seats: {
        ...VERIFIED_SUPERPOWERS.seats,
        cursor: {
          seat: 'cursor', verified: false, evidence: 'Cursor manifest missing', version: null,
          remediation: 'Cursor: URO_SUPERPOWERS_DIR=<directory-with-.cursor-plugin>',
        },
      },
    }),
    createRuntime: () => { runtimeCreations++; return {}; },
    runQueueFn: async () => { queueCalls++; return {}; },
  }), /Cursor.*[.]cursor-plugin/i);
  assert.equal(runtimeCreations, 0);
  assert.equal(queueCalls, 0);
});
