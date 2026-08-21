import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
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
      watchdog.reporter(executorEvent(clock, runId, 'finish', { code: 0, attempt: 1 }));

      assert.ok(clock.now() > thresholdMs,
        'positive setup: total executor duration must exceed the watchdog threshold');
      assert.equal(delivered.filter((event) => event.type === 'file_change').length, 1,
        'positive setup: a completed file change must reach the watchdog');
      assert.equal(delivered.filter((event) => event.type === 'item_completed').length, 5,
        'other completed items must also count as real intra-stage progress');
      assert.equal(delivered.some((event) => event.type === 'stalled'), false,
        'steady executor items must reset the gap timer');
    } finally {
      watchdog.dispose();
    }
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
