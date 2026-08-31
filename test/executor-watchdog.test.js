import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { runExecutor } from '../src/executor.js';
import { createEvent } from '../src/events.js';
import { createGapWatchdog } from '../src/stall-watchdog.js';

function controlledClock() {
  let time = 0;
  let nextTimerId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delayMs) {
      const id = ++nextTimerId;
      timers.set(id, { dueAt: time + delayMs, fn });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) { time += ms; },
    fireDueTimers() {
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= time)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

function executorEvent(clock, runId, type, fields = {}) {
  return createEvent({
    runId, stage: 'executor', type, fields,
    now: () => new Date(clock.now()),
  });
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

function executorWithWatchdog({ source, thresholdMs, runId }) {
  const delivered = [];
  const watchdog = createGapWatchdog({
    reporter: (event) => delivered.push(event),
    runId,
    thresholdMs,
  });
  const pending = runExecutor({
    plan: 'watch the stream', cwd: tmpdir(),
    bin: process.execPath, extraArgv: ['-e', source],
    reporter: watchdog.reporter, runId, attempt: 1, timeoutMs: 5000,
  });
  return { delivered, watchdog, pending };
}

test('a healthy executor outliving the threshold stays unstalled when items keep completing',
  () => {
    const thresholdMs = 750;
    const runId = 'healthy-executor';
    const clock = controlledClock();
    const delivered = [];
    const watchdog = createGapWatchdog({
      reporter: (event) => delivered.push(event),
      runId,
      thresholdMs,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    try {
      watchdog.reporter(executorEvent(clock, runId, 'start', { attempt: 1 }));
      for (let index = 0; index < 6; index++) {
        clock.advance(200);
        clock.fireDueTimers();
        watchdog.reporter(executorEvent(
          clock,
          runId,
          index === 0 ? 'file_change' : 'item_completed',
          index === 0
            ? { file: 'file-0.js', attempt: 1 }
            : { itemType: 'command_execution', attempt: 1 },
        ));
      }
      assert.ok(clock.now() > thresholdMs,
        'positive setup: total executor duration must exceed the watchdog threshold');
      assert.equal(delivered.filter((event) => event.type === 'file_change').length, 1,
        'positive setup: a completed file change must reach the watchdog');
      assert.equal(delivered.filter((event) => event.type === 'item_completed').length, 5,
        'other completed items must also count as real intra-stage progress');
      assert.equal(delivered.some((event) => event.type === 'stalled'), false,
        'steady executor items must reset the gap timer');

      clock.advance(thresholdMs);
      clock.fireDueTimers();
      const stalls = delivered.filter((event) => event.type === 'stalled');
      assert.equal(stalls.length, 1,
        'positive control: the same controlled clock must deliver a stall after silence');
      assert.equal(stalls[0].stage, 'executor');
      assert.equal(stalls[0].lastEvent.type, 'item_completed');

      watchdog.reporter(executorEvent(clock, runId, 'finish', { code: 0, attempt: 1 }));
      clock.advance(thresholdMs);
      clock.fireDueTimers();
      assert.equal(delivered.filter((event) => event.type === 'stalled').length, 1,
        'finishing the stage must prevent any further stall notification');
    } finally {
      watchdog.dispose();
    }
  });

test('raw bytes keep the real executor coordinator alive while progress silence only reports',
  async () => {
    const clock = controlledClock();
    const child = fakeChild();
    const events = [];
    let kills = 0;
    const pending = runExecutor({
      plan: 'think without completing an item', cwd: tmpdir(),
      bin: process.execPath, extraArgv: ['unused'], env: {},
      reporter: (event) => events.push(event), runId: 'chatty-thinking', attempt: 1,
      livenessThresholdMs: 50, progressThresholdMs: 100,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      spawnProcess: () => child,
      killProcessTree: () => { kills++; },
    });
    await Promise.resolve();

    clock.advance(40);
    child.stdout.emit('data', Buffer.from('thinking'));
    clock.fireDueTimers();
    clock.advance(40);
    child.stdout.emit('data', Buffer.from(' more'));
    clock.fireDueTimers();
    clock.advance(20);
    clock.fireDueTimers();

    assert.equal(kills, 0, 'progress silence must never kill the child');
    assert.equal(events.filter((event) => event.type === 'extended').length, 0,
      'there is no elapsed deadline to extend');
    assert.equal(events.filter((event) => event.type === 'stalled'
      && event.tier === 'progress').length, 1,
    'progress silence must still emit its informational event');

    child.emit('close', 0, null);
    const result = await pending;
    assert.equal(result.timedOut, false);
    assert.equal(kills, 0);
  });

test('raw stdout resets the executor liveness gap through the runExecutor observer', async () => {
  const clock = controlledClock();
  const child = fakeChild();
  const livenessChecks = [];
  let kills = 0;
  const pending = runExecutor({
    plan: 'measure the raw stream', cwd: tmpdir(),
    bin: process.execPath, extraArgv: ['unused'], env: {}, runId: 'executor-observer', attempt: 1,
    livenessThresholdMs: 50,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    spawnProcess: () => child,
    killProcessTree: () => { kills++; },
    judgeLiveness: async (evidence) => {
      livenessChecks.push(evidence);
      return { status: 'working', reasoning: 'Raw stdout proves the executor is live.' };
    },
    getProcessTree: () => ({ available: true, descendants: [] }),
    getWorktreeActivity: (sinceMs) => ({
      available: true, changed: false, changedFiles: [], sinceMs,
    }),
  });
  await Promise.resolve();

  clock.advance(40);
  child.stdout.emit('data', Buffer.from('thinking'));
  clock.advance(50);
  clock.fireDueTimers();
  await new Promise((resolve) => setImmediate(resolve));

  // Removing executor.js's onStdout lastByteAt reset makes this 90, measured from start.
  assert.equal(livenessChecks.length, 1, 'the controlled liveness deadline must consult its judge');
  assert.equal(livenessChecks[0].gapMs, 50,
    'the judge must measure from stdout observed by runExecutor, not process start');
  assert.equal(kills, 0, 'the fresh stdout gap must not terminate the executor');

  child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(kills, 0);
});

test('a genuinely silent executor still emits one stall event', async () => {
  const { delivered, watchdog, pending } = executorWithWatchdog({
    source: 'setTimeout(() => {}, 350)', thresholdMs: 100, runId: 'silent-executor',
  });
  try {
    await pending;
    const stalls = delivered.filter((event) => event.type === 'stalled');
    assert.equal(stalls.length, 1,
      'silence must still fire once; the incremental fix cannot merely disable the watchdog');
    assert.equal(stalls[0].stage, 'executor');
    assert.equal(stalls[0].lastEvent.type, 'start');
  } finally {
    watchdog.dispose();
  }
});
