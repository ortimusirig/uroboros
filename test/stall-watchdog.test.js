import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, formatEventSummary } from '../src/events.js';
import {
  createGapWatchdog,
  createProgressWatchdog,
  DEFAULT_PROGRESS_THRESHOLD_MS,
  DEFAULT_STALL_POLICY,
  DEFAULT_STALL_RESTARTS,
  DEFAULT_STALL_THRESHOLD_MS,
  resolveStallConfig,
} from '../src/stall-watchdog.js';

function fakeClock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) {
      const id = ++nextId;
      timers.set(id, { at: time + delay, fn });
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

function event(clock, type, fields = {}) {
  return createEvent({
    runId: 'gap-run', stage: 'executor', type, fields,
    now: () => new Date(clock.now()),
  });
}

test('steady events reset the gap beyond one total threshold, with silence as a positive control', () => {
  const clock = fakeClock();
  const events = [];
  const watchdog = createGapWatchdog({
    reporter: (item) => events.push(item), runId: 'gap-run', thresholdMs: 100,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  watchdog.reporter(event(clock, 'start', { attempt: 1 }));
  for (let index = 1; index <= 5; index++) {
    clock.advance(90);
    watchdog.reporter(event(clock, 'file_change', { file: `file-${index}.js` }));
  }
  assert.equal(clock.now(), 450, 'positive setup: total elapsed time must far exceed 100 ms');
  assert.equal(events.some((item) => item.type === 'stalled'), false,
    'a total-elapsed watchdog would have fired despite every gap staying below 100 ms');

  clock.advance(100);
  const stalls = events.filter((item) => item.type === 'stalled');
  assert.equal(stalls.length, 1,
    'positive control: the same armed watchdog must fire when a real 100 ms gap follows');
  assert.equal(stalls[0].gapMs, 100);
  assert.equal(stalls[0].lastEvent.file, 'file-5.js');
  watchdog.dispose();
});

test('a silent stage emits one stalled event carrying its stage, gap, and last event', () => {
  const clock = fakeClock();
  const events = [];
  const watchdog = createGapWatchdog({
    reporter: (item) => events.push(item), runId: 'gap-run', thresholdMs: 75,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  watchdog.reporter(event(clock, 'start', { attempt: 4 }));
  clock.advance(500);
  const stalls = events.filter((item) => item.type === 'stalled');
  assert.equal(stalls.length, 1, 'one silence produces one notification, not a timer storm');
  assert.equal(stalls[0].stage, 'executor');
  assert.equal(stalls[0].gapMs, 75);
  assert.equal(stalls[0].lastEvent.type, 'start');
  assert.equal(stalls[0].lastEvent.attempt, 4);
  assert.equal(stalls[0].setting, 'URO_STALL_THRESHOLD_MS');
  watchdog.dispose();
});

test('stall configuration defaults to fifteen-minute liveness and five-minute progress with no elapsed ceiling', () => {
  assert.deepEqual(resolveStallConfig({}), {
    thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
    progressThresholdMs: DEFAULT_PROGRESS_THRESHOLD_MS,
    policy: DEFAULT_STALL_POLICY,
    restartLimit: DEFAULT_STALL_RESTARTS,
  });
  assert.equal(DEFAULT_STALL_THRESHOLD_MS, 15 * 60 * 1000);
  assert.equal(DEFAULT_PROGRESS_THRESHOLD_MS, 5 * 60 * 1000);
  assert.equal(DEFAULT_STALL_POLICY, 'report');
  assert.equal(DEFAULT_STALL_RESTARTS, 1);
  assert.deepEqual(resolveStallConfig({
    URO_STALL_THRESHOLD_MS: '1234', URO_PROGRESS_THRESHOLD_MS: '2345',
    URO_STALL_POLICY: 'restart', URO_STALL_RESTARTS: '2',
  }), {
    thresholdMs: 1234, progressThresholdMs: 2345,
    policy: 'restart', restartLimit: 2,
  });
  assert.throws(() => resolveStallConfig({ URO_STALL_POLICY: 'kill' }), /URO_STALL_POLICY/);
  assert.throws(() => resolveStallConfig({ URO_STALL_THRESHOLD_MS: '0' }),
    /URO_STALL_THRESHOLD_MS/);
  assert.throws(() => resolveStallConfig({ URO_PROGRESS_THRESHOLD_MS: 'soon' }),
    /URO_PROGRESS_THRESHOLD_MS must be a positive integer number of milliseconds/);
});

test('progress silence reports the last action while raw bytes keep liveness from killing', () => {
  const clock = fakeClock();
  const events = [];
  let kills = 0;
  const liveness = createGapWatchdog({
    reporter: (item) => events.push(item), runId: 'gap-run', thresholdMs: 100,
    onStall: () => { kills++; },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const progress = createProgressWatchdog({
    reporter: liveness.reporter, runId: 'gap-run', thresholdMs: 100,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  try {
    const started = event(clock, 'start', { attempt: 1 });
    liveness.reporter(started);
    progress.observe(started);
    const completed = event(clock, 'file_change', { attempt: 1, file: 'src/foo.js' });
    liveness.reporter(completed);
    progress.observe(completed);
    for (let index = 0; index < 5; index++) {
      clock.advance(80);
      liveness.touch('executor');
    }

    assert.ok(clock.now() > 100, 'positive setup: total elapsed time exceeds both thresholds');
    assert.equal(kills, 0, 'raw stdout bytes must keep the liveness tier healthy');
    const notices = events.filter((item) => item.type === 'stalled' && item.tier === 'progress');
    assert.equal(notices.length, 1, 'one progress gap produces one informational event');
    assert.equal(notices[0].gapMs, 100);
    assert.equal(notices[0].lastEvent.file, 'src/foo.js');
    assert.equal(notices[0].setting, 'URO_PROGRESS_THRESHOLD_MS');
    assert.match(formatEventSummary(notices[0]),
      /no completed work for 100ms.*last action=editing src\/foo[.]js/i);

    clock.advance(100);
    assert.equal(kills, 1,
      'positive control: the same liveness watchdog kills after raw bytes stop');
  } finally {
    progress.dispose();
    liveness.dispose();
  }
});
