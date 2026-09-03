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

test('a debate-stage silence is reported, not fatal — the R5 crash regression', () => {
  // Observed in production: the watchdog armed for stage "debate", the pair
  // was undeclared, and createEvent threw inside a timer — killing the run it
  // was supervising. Silence in ANY stage must now be reportable.
  const clock = fakeClock();
  const events = [];
  const watchdog = createGapWatchdog({
    reporter: (item) => events.push(item), runId: 'gap-run', thresholdMs: 100,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  watchdog.reporter(createEvent({
    runId: 'gap-run', stage: 'debate', type: 'round',
    fields: { debateRound: 2 }, now: () => new Date(clock.now()),
  }));
  assert.doesNotThrow(() => clock.advance(150));
  const stalled = events.find((item) => item.type === 'stalled');
  assert.equal(stalled.stage, 'debate');
  assert.equal(stalled.gapMs >= 100, true);
});

test('flowing file_change events are progress, not a stall', () => {
  // Field evidence: `executor/stalled no completed work for 300013ms last
  // action=editing agent/__init__.py` fired during a healthy 22-minute
  // single-file edit — file_change events were flowing the whole time, but
  // only item_completed advanced lastProgressAt. A steady stream of
  // file_change events (evidence of work product) must keep the progress
  // tier from ever seeing a gap as large as the threshold.
  const clock = fakeClock();
  const events = [];
  const progress = createProgressWatchdog({
    reporter: (item) => events.push(item), runId: 'gap-run', thresholdMs: 300000,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  progress.observe(event(clock, 'start', { attempt: 1 }));
  for (let index = 1; index <= 6; index++) {
    clock.advance(60000);
    progress.observe(event(clock, 'file_change', { file: 'agent/__init__.py', attempt: 1 }));
  }
  assert.equal(clock.now(), 360000,
    'positive setup: total elapsed time exceeds the 300s progress threshold');
  assert.equal(events.some((item) => item.type === 'stalled'), false,
    'a flowing single-file edit is progress, not a stall');
  progress.dispose();
});

test('true silence still stalls', () => {
  // Control for the test above: with no events at all, the progress tier
  // must still fire — existing behavior pinned, exactly one stalled event.
  const clock = fakeClock();
  const events = [];
  const progress = createProgressWatchdog({
    reporter: (item) => events.push(item), runId: 'gap-run', thresholdMs: 300000,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  progress.observe(event(clock, 'start', { attempt: 1 }));
  clock.advance(301000);
  const stalls = events.filter((item) => item.type === 'stalled');
  assert.equal(stalls.length, 1,
    'positive control: true silence across the threshold still fires exactly one stalled event');
  progress.dispose();
});

test('an unconstructible silence report is contained instead of escaping the timer', () => {
  // Raw reporter payloads are not guaranteed to have vocabulary stages. If the
  // report cannot be constructed, the watchdog swallows it — a stall report
  // must never be the thing that ends the run.
  const clock = fakeClock();
  const events = [];
  const watchdog = createGapWatchdog({
    reporter: (item) => events.push(item), runId: 'gap-run', thresholdMs: 100,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  watchdog.reporter({ runId: 'gap-run', stage: 'not-a-vocabulary-stage', type: 'start' });
  assert.doesNotThrow(() => clock.advance(150));
  assert.equal(events.some((item) => item.type === 'stalled'), false,
    'the unreportable stall is dropped, never thrown');
});
