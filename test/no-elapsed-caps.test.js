import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { runExecutor } from '../src/executor.js';
import { DEFAULT_GATE_TIMEOUT_MS, resolveStageTimeouts } from '../src/timeouts.js';
import { runVerifier } from '../src/verifier.js';

function controlledClock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delayMs) {
      const id = ++nextId;
      timers.set(id, { at: time + delayMs, fn });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = time + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
      }
      time = target;
    },
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => {};
  return child;
}

async function started() {
  await Promise.resolve();
  await Promise.resolve();
}

function injectedSeat(clock, child, kills, order = kills) {
  return {
    env: {},
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    spawnProcess: () => child,
    killProcessTree: () => {
      kills.push('kill');
      if (order !== kills) order.push('kill');
      child.emit('close', null, 'SIGKILL');
    },
  };
}

test('agent seats have no invented elapsed timeout while the gate keeps its default', () => {
  assert.deepEqual(resolveStageTimeouts({}), {
    executor: undefined,
    verifier: undefined,
    gate: DEFAULT_GATE_TIMEOUT_MS,
  });
  assert.equal(DEFAULT_GATE_TIMEOUT_MS, 60 * 60 * 1000);
});

test('operator executor and verifier timeout overrides remain honored', () => {
  assert.deepEqual(resolveStageTimeouts({
    URO_EXECUTOR_TIMEOUT_MS: '101',
    URO_VERIFIER_TIMEOUT_MS: '202',
  }, {
    executorTimeout: 303,
    verifierTimeout: 404,
  }), {
    executor: 303,
    verifier: 404,
    gate: DEFAULT_GATE_TIMEOUT_MS,
  });
});

test('direct verifier launches honor the operator liveness threshold from their environment',
  async () => {
    const clock = controlledClock();
    const child = fakeChild();
    const kills = [];
    const pending = runVerifier({
      cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'], superpowersDir: null,
      env: { URO_STALL_THRESHOLD_MS: '25' },
      runId: 'environment-liveness', pass: 'correctness',
      progressThresholdMs: 250,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      spawnProcess: () => child,
      killProcessTree: () => {
        kills.push('kill');
        child.emit('close', null, 'SIGKILL');
      },
    });
    await started();
    clock.advance(25);
    await pending;
    assert.deepEqual(kills, ['kill']);
  });

test('a chatty executor runs beyond both former elapsed caps and progress silence never kills',
  async () => {
    const clock = controlledClock();
    const child = fakeChild();
    const kills = [];
    const events = [];
    const pending = runExecutor({
      plan: 'keep working', cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'],
      reporter: (event) => events.push(event), runId: 'long-executor', attempt: 1,
      livenessThresholdMs: 5 * 60 * 1000,
      progressThresholdMs: 5 * 60 * 1000,
      ...injectedSeat(clock, child, kills),
    });
    await started();

    for (let index = 0; index < 100; index++) {
      clock.advance(4 * 60 * 1000);
      child.stdout.emit('data', Buffer.from('thinking'));
    }
    assert.ok(clock.now() > 6 * 60 * 60 * 1000,
      'positive setup: simulated duration crosses the removed six-hour ceiling');
    assert.deepEqual(kills, []);
    assert.ok(events.some((event) => event.type === 'stalled' && event.tier === 'progress'),
      'no completed items remains visible even while bytes prove liveness');

    child.emit('close', 0, null);
    const result = await pending;
    assert.equal(result.timedOut, false);
    assert.equal(result.timeoutMs, null);
  });

test('a chatty verifier runs beyond the former ten-minute default without being killed',
  async () => {
    const clock = controlledClock();
    const child = fakeChild();
    const kills = [];
    const events = [];
    const pending = runVerifier({
      cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'], superpowersDir: null,
      reporter: (event) => events.push(event), runId: 'long-verifier', pass: 'correctness',
      livenessThresholdMs: 5 * 60 * 1000,
      progressThresholdMs: 5 * 60 * 1000,
      ...injectedSeat(clock, child, kills),
    });
    await started();

    for (let index = 0; index < 5; index++) {
      clock.advance(3 * 60 * 1000);
      child.stdout.emit('data', Buffer.from('{"type":"thinking"}\n'));
    }
    assert.ok(clock.now() > 10 * 60 * 1000,
      'positive setup: simulated duration crosses the removed verifier default');
    assert.deepEqual(kills, []);
    assert.ok(events.some((event) => event.type === 'stalled' && event.tier === 'progress'));

    child.stdout.emit('data', Buffer.from(
      '{"type":"result","is_error":false,"result":"NO_BLOCKERS"}\n',
    ));
    child.emit('close', 0, null);
    const result = await pending;
    assert.equal(result.verdict, 'NO_BLOCKERS');
    assert.equal(result.timedOut, false);
    assert.equal(result.timeoutMs, null);
  });

test('silence kills the executor after preserving partial work and records liveness evidence',
  async () => {
    const clock = controlledClock();
    const child = fakeChild();
    const kills = [];
    const order = [];
    const pending = runExecutor({
      plan: 'write something', cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'],
      runId: 'silent-executor', attempt: 1, livenessThresholdMs: 50,
      progressThresholdMs: 500,
      beforeKill: async () => { order.push('preserve'); },
      ...injectedSeat(clock, child, kills, order),
    });
    await started();
    clock.advance(50);
    const result = await pending;

    assert.deepEqual(order, ['preserve', 'kill']);
    assert.equal(result.timedOut, true);
    assert.equal(result.timeoutReason.kind, 'liveness');
    assert.equal(result.timeoutReason.gapMs, 50);
    assert.equal(result.timeoutReason.lastEvent.type, 'start');
    assert.equal(result.timeoutReason.setting, 'URO_STALL_THRESHOLD_MS');
  });

for (const pass of ['correctness', 'intent']) {
  test(`silence kills the ${pass} verifier pass and an inconclusive partial stream is UNVERIFIED`,
    async () => {
      const clock = controlledClock();
      const child = fakeChild();
      const kills = [];
      const pending = runVerifier({
        cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'], superpowersDir: null,
        runId: `silent-${pass}`, pass, livenessThresholdMs: 40,
        progressThresholdMs: 400,
        ...injectedSeat(clock, child, kills),
      });
      await started();
      child.stdout.emit('data', Buffer.from(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"still reviewing"}]}}\n',
      ));
      clock.advance(40);
      const result = await pending;

      assert.deepEqual(kills, ['kill']);
      assert.equal(result.verdict, 'UNVERIFIED');
      assert.notEqual(result.verdict, 'ISSUES');
      assert.equal(result.timeoutReason.kind, 'liveness');
      assert.equal(result.timeoutReason.gapMs, 40);
      assert.equal(result.timeoutReason.lastEvent.type, 'assistant');
      assert.equal(result.timeoutReason.setting, 'URO_STALL_THRESHOLD_MS');
    });
}

test('a verifier killed after parsing a verdict marker keeps that verdict', async () => {
  const clock = controlledClock();
  const child = fakeChild();
  const kills = [];
  const pending = runVerifier({
    cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'], superpowersDir: null,
    runId: 'verdict-before-silence', pass: 'correctness', livenessThresholdMs: 30,
    progressThresholdMs: 300,
    ...injectedSeat(clock, child, kills),
  });
  await started();
  child.stdout.emit('data', Buffer.from(
    '{"type":"result","is_error":false,"result":"NO_BLOCKERS"}\n',
  ));
  clock.advance(30);
  const result = await pending;

  assert.equal(result.timedOut, true);
  assert.equal(result.verdict, 'NO_BLOCKERS');
});

for (const seat of ['executor', 'verifier']) {
  test(`an explicit ${seat} timeout remains an elapsed-time operator kill`, async () => {
    const clock = controlledClock();
    const child = fakeChild();
    const kills = [];
    const common = {
      cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'], timeoutMs: 25,
      livenessThresholdMs: 250, progressThresholdMs: 250,
      ...injectedSeat(clock, child, kills),
    };
    const pending = seat === 'executor'
      ? runExecutor({ ...common, plan: 'bounded', runId: 'bounded-executor', attempt: 1 })
      : runVerifier({ ...common, superpowersDir: null,
          runId: 'bounded-verifier', pass: 'correctness' });
    await started();
    clock.advance(25);
    const result = await pending;
    assert.deepEqual(kills, ['kill']);
    assert.equal(result.timedOut, true);
    assert.equal(result.timeoutReason.kind, 'deadline');
    assert.equal(result.timeoutMs, 25);
  });
}

test('positive control: quickly completed seats keep their normal outcomes', async () => {
  const executorClock = controlledClock();
  const executorChild = fakeChild();
  const executorKills = [];
  const executorPending = runExecutor({
    plan: 'finish', cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'],
    runId: 'quick-executor', attempt: 1, livenessThresholdMs: 50,
    progressThresholdMs: 50,
    ...injectedSeat(executorClock, executorChild, executorKills),
  });
  await started();
  executorChild.emit('close', 0, null);
  const executor = await executorPending;
  assert.equal(executor.timedOut, false);
  assert.deepEqual(executorKills, []);

  const verifierClock = controlledClock();
  const verifierChild = fakeChild();
  const verifierKills = [];
  const verifierPending = runVerifier({
    cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'], superpowersDir: null,
    runId: 'quick-verifier', pass: 'intent', livenessThresholdMs: 50,
    progressThresholdMs: 50,
    ...injectedSeat(verifierClock, verifierChild, verifierKills),
  });
  await started();
  verifierChild.stdout.emit('data', Buffer.from(
    '{"type":"result","is_error":false,"result":"NO_BLOCKERS"}\n',
  ));
  verifierChild.emit('close', 0, null);
  const verifier = await verifierPending;
  assert.equal(verifier.verdict, 'NO_BLOCKERS');
  assert.equal(verifier.timedOut, false);
  assert.deepEqual(verifierKills, []);
});
