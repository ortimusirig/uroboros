import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createLivenessDeadline, spawnCapture, commandExists } from '../src/spawn.js';

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

function livenessHarness({ thresholdMs = 50 } = {}) {
  const clock = controlledClock();
  const killed = [];
  let lastByteAt = null;
  let lastEvent = { stage: 'executor', type: 'start', attempt: 1 };
  const deadline = createLivenessDeadline({
    thresholdMs,
    getLiveness: () => ({
      gapMs: clock.now() - (lastByteAt ?? 0),
      lastEvent,
    }),
    onKill: (reason) => killed.push(reason),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    clock,
    deadline,
    killed,
    byte(event = lastEvent) {
      lastByteAt = clock.now();
      lastEvent = event;
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

function livenessSupervision(clock) {
  return {
    thresholdMs: 50,
    getLiveness: () => ({
      gapMs: clock.now(),
      lastEvent: { stage: 'executor', type: 'start' },
    }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
}

test('bytes keep liveness alive for arbitrarily many thresholds', () => {
  const harness = livenessHarness();
  for (let index = 0; index < 100; index++) {
    harness.clock.advance(40);
    harness.byte({ stage: 'executor', type: 'item_completed', itemType: 'command_execution' });
  }
  assert.equal(harness.clock.now(), 4000,
    'positive setup: total elapsed time far exceeds one liveness threshold');
  assert.equal(harness.killed.length, 0);
  harness.clock.advance(50);
  assert.equal(harness.killed.length, 1,
    'positive control: a real full silence gap still kills');
  harness.deadline.dispose();
});

test('silence past liveness kills with gap, last event, and controlling setting', () => {
  const harness = livenessHarness({ thresholdMs: 30 });
  harness.clock.advance(20);
  harness.byte({ stage: 'executor', type: 'item_completed', itemType: 'file_change' });
  harness.clock.advance(30);

  assert.deepEqual(harness.killed, [{
    kind: 'liveness',
    timeoutMs: 30,
    gapMs: 30,
    lastEvent: { stage: 'executor', type: 'item_completed', itemType: 'file_change' },
    setting: 'URO_STALL_THRESHOLD_MS',
    judged: false,
    unjudged: true,
    reasoning: 'Liveness check was unjudged: no liveness judge was available',
  }]);
});

test('no hard ceiling kills a continuously chatty executor', () => {
  const thresholdMs = 5 * 60 * 1000;
  const harness = livenessHarness({ thresholdMs });
  for (let elapsed = 0; elapsed < 7 * 60 * 60 * 1000; elapsed += 4 * 60 * 1000) {
    harness.clock.advance(4 * 60 * 1000);
    harness.byte();
  }
  assert.ok(harness.clock.now() > 6 * 60 * 60 * 1000,
    'positive setup: the removed ceiling is crossed');
  assert.equal(harness.killed.length, 0);

  harness.clock.advance(thresholdMs);
  assert.equal(harness.killed.length, 1);
  assert.equal(harness.killed[0].kind, 'liveness');
  assert.equal(harness.killed[0].setting, 'URO_STALL_THRESHOLD_MS');
});

test('a seat with no output is killed at the liveness threshold', () => {
  const harness = livenessHarness({ thresholdMs: 500 });
  harness.clock.advance(500);

  assert.equal(harness.killed.length, 1);
  assert.equal(harness.killed[0].kind, 'liveness');
  assert.equal(harness.killed[0].gapMs, 500);
  assert.equal(harness.killed[0].lastEvent.type, 'start');
  assert.equal(harness.killed[0].setting, 'URO_STALL_THRESHOLD_MS');
});

test('spawnCapture awaits preservation before invoking the injected process-tree kill', async () => {
  const clock = controlledClock();
  const child = fakeChild();
  const order = [];
  const pending = spawnCapture(process.execPath, ['unused'], {
    beforeKill: async () => { order.push('preserve'); },
    spawnProcess: () => child,
    killProcessTree: () => {
      order.push('kill');
      child.emit('close', null, 'SIGKILL');
    },
    livenessSupervision: livenessSupervision(clock),
  });

  await Promise.resolve();
  clock.advance(50);
  const result = await pending;
  assert.deepEqual(order, ['preserve', 'kill']);
  assert.equal(result.timedOut, true);
});

test('child close during preservation waits for preservation and never kills a closed pid', async () => {
  const clock = controlledClock();
  const child = fakeChild();
  const order = [];
  let releasePreservation;
  const pending = spawnCapture(process.execPath, ['unused'], {
    beforeKill: () => new Promise((resolve) => {
      order.push('preserve-start');
      releasePreservation = () => {
        order.push('preserve-finish');
        resolve();
      };
    }),
    spawnProcess: () => child,
    killProcessTree: () => { order.push('kill'); },
    livenessSupervision: livenessSupervision(clock),
  });
  let resolved = false;
  pending.then(() => { resolved = true; });

  await Promise.resolve();
  clock.advance(50);
  await Promise.resolve();
  child.emit('close', 0, null);
  await Promise.resolve();
  assert.equal(resolved, false, 'spawnCapture must not outrun an in-flight preservation');
  releasePreservation();

  const result = await pending;
  assert.deepEqual(order, ['preserve-start', 'preserve-finish']);
  assert.equal(result.timedOut, true);
});

test('captures stdout and exit code 0', async () => {
  const r = await spawnCapture(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hi');
});

test('captures a non-zero exit code without throwing', async () => {
  const r = await spawnCapture(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(r.code, 3);
});

test('feeds stdin when input is provided', async () => {
  const r = await spawnCapture(process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'echoed' });
  assert.equal(r.stdout, 'echoed');
});

test('rejects when the binary does not exist', async () => {
  await assert.rejects(() => spawnCapture('definitely-not-a-real-binary-xyz', []));
});

test('commandExists is true for node, false for nonsense', async () => {
  assert.equal(await commandExists(process.execPath), true);
  assert.equal(await commandExists('definitely-not-a-real-binary-xyz'), false);
});

test('captures multi-byte UTF-8 output without corruption', async () => {
  const s = 'café ☕ 🚀 日本語';
  const r = await spawnCapture(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(s)})`]);
  assert.equal(r.stdout, s);
});

test('returns a known NDJSON fixture stdout byte-identically in full', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/codex-stream-schema-sample.ndjson', import.meta.url));
  const expected = readFileSync(fixture);
  const r = await spawnCapture(process.execPath, [
    '-e',
    'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))',
    fixture,
  ]);
  assert.equal(r.code, 0);
  assert.ok(Buffer.from(r.stdout, 'utf8').equals(expected),
    'the complete returned stdout must retain every fixture byte');
});

test('incremental stdout observation preserves known fixture bytes exactly', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/codex-stream-schema-sample.ndjson', import.meta.url));
  const expected = readFileSync(fixture);
  const observed = [];
  const r = await spawnCapture(process.execPath, [
    '-e',
    'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))',
    fixture,
  ], { onStdout: (chunk) => {
    observed.push(chunk);
    throw new Error('observation failure must stay contained');
  } });
  assert.equal(r.code, 0);
  assert.ok(Buffer.from(r.stdout, 'utf8').equals(expected),
    'activating observation must not change any byte of returned stdout');
  assert.ok(Buffer.concat(observed).equals(expected),
    'even a failing additive observer must see the same complete byte sequence');
});

test('runs a .cmd on Windows and preserves space-bearing args', { skip: process.platform !== 'win32' }, async () => {
  const cmd = fileURLToPath(new URL('../fixtures/echoargs.cmd', import.meta.url));
  const r = await spawnCapture(cmd, ['hello', 'a b c']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ARG=\[hello\]/);
  assert.match(r.stdout, /ARG=\[a b c\]/, 'space-bearing arg must survive as one arg');
});

test('a short timeout kills a clearly slower child and marks the result', async () => {
  const started = Date.now();
  const r = await spawnCapture(process.execPath, ['-e', [
    'process.stdout.write("started")',
    'process.stderr.write("warning")',
    'setTimeout(() => process.stdout.write("finished"), 5000)',
  ].join(';')], { timeoutMs: 500 });
  assert.equal(r.timedOut, true, 'returning alone is insufficient: the timeout must be marked');
  assert.equal(r.timeoutMs, 500);
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, 'started', 'partial output captured before termination must survive');
  assert.equal(r.stderr, 'warning', 'partial stderr captured before termination must survive');
  assert.ok(Date.now() - started < 4000, 'the five-second child must actually be terminated');
});

test('spawnCapture without a timeout remains unbounded', async () => {
  const started = Date.now();
  const r = await spawnCapture(process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write("completed"), 250)']);
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.timeoutMs, null);
  assert.equal(r.stdout, 'completed');
  assert.ok(Date.now() - started >= 200, 'the child must be allowed to finish on its own');
});

test('an abort signal uses process termination without masquerading as a timeout', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = spawnCapture(process.execPath, ['-e', [
    'process.stdout.write("started")',
    'setTimeout(() => process.stdout.write("finished"), 5000)',
  ].join(';')], { timeoutMs: 10_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false, 'stall restart accounting must stay separate from timeouts');
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, 'started');
  assert.ok(Date.now() - started < 4000, 'the slow child must actually be terminated');
});

test('a Windows .cmd timeout kills its underlying child process',
  { skip: process.platform !== 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-tree-'));
    const marker = join(dir, 'orphan-marker.txt');
    const cmd = fileURLToPath(new URL('../fixtures/timeout-tree.cmd', import.meta.url));
    try {
      const r = await spawnCapture(cmd, [process.execPath, marker], { timeoutMs: 300 });
      assert.equal(r.timedOut, true);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      assert.equal(existsSync(marker), false,
        'the node process behind cmd.exe must not survive long enough to write its marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
