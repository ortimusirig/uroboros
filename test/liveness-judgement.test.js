import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutor } from '../src/executor.js';
import { createLivenessDeadline } from '../src/spawn.js';
import { run } from '../src/run.js';
import {
  createLivenessJudge,
  DEFAULT_LIVENESS_JUDGE_TIMEOUT_MS,
} from '../src/liveness-judge.js';

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

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
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

function deadlineHarness({
  thresholdMs = 50,
  judge,
  judgeTimeoutMs = 20,
  processTree = { available: true, rootPid: 7, liveDescendantCount: 0, descendants: [] },
  worktreeActivity = { available: true, changed: false, changedFiles: [] },
  onDecision,
} = {}) {
  const clock = controlledClock();
  const events = [];
  const decisions = [];
  const killed = [];
  let lastByteAt = 0;
  let lastEvent = { stage: 'executor', type: 'item_completed', itemType: 'agent_message' };
  let lastAgentMessage = 'still working';
  const deadline = createLivenessDeadline({
    thresholdMs,
    judgeTimeoutMs,
    judge,
    getProcessTree: () => processTree,
    getWorktreeActivity: () => worktreeActivity,
    getLiveness: () => ({
      seat: 'executor',
      gapMs: clock.now() - lastByteAt,
      lastEvent,
      lastEvents: [{ ...lastEvent, ts: new Date(lastByteAt).toISOString() }],
      lastAgentMessage,
    }),
    onEvent: (type, fields) => events.push({ type, ...fields }),
    onDecision: (decision) => {
      decisions.push(decision);
      onDecision?.(decision);
    },
    onKill: (reason) => killed.push(reason),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    clock, deadline, events, decisions, killed,
    get lastByteAt() { return lastByteAt; },
    byte(event = lastEvent, message = lastAgentMessage) {
      lastByteAt = clock.now();
      lastEvent = event;
      lastAgentMessage = message;
    },
  };
}

test('silence asks a judge; working leaves the executor alive and emits its reason', async () => {
  const clock = controlledClock();
  const child = fakeChild();
  const events = [];
  const kills = [];
  const inputs = [];
  const message = 'The implementer is still in its RED→GREEN cycle, so I am waiting on a subagent.';
  const processTree = {
    available: true,
    rootPid: child.pid,
    liveDescendantCount: 1,
    descendants: [{ pid: 12346, parentPid: child.pid, status: 'R', name: 'codex' }],
  };
  const worktreeActivity = {
    available: true, changed: true, changedFiles: ['src/controller.js'],
  };
  const pending = runExecutor({
    plan: 'delegate safely', cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'],
    env: {}, reporter: (event) => events.push(event), runId: 'delegated-seat', attempt: 1,
    livenessThresholdMs: 50, progressThresholdMs: 500,
    judgeLiveness: (input) => {
      inputs.push(input);
      return {
        status: 'working',
        reasoning: 'The parent explicitly awaits a live delegated child that is still running.',
        nextIntervalMs: 120,
      };
    },
    getProcessTree: () => processTree,
    getWorktreeActivity: () => worktreeActivity,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    spawnProcess: () => child,
    killProcessTree: () => { kills.push('kill'); },
  });
  await flush();
  clock.advance(30);
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'item.completed', item: { type: 'agent_message', text: message },
  })}\n`));
  clock.advance(50);
  await flush();

  assert.equal(inputs.length, 1, 'silence must invoke the separate judge');
  assert.deepEqual(kills, [], 'a working judgement must not kill the seat');
  assert.equal(inputs[0].gapMs, 50,
    'the first stdout byte must reset lastByteAt rather than measuring from process start');
  assert.equal(inputs[0].lastAgentMessage, message, 'the last message must remain verbatim');
  assert.deepEqual(inputs[0].processTree, processTree);
  assert.deepEqual(inputs[0].worktreeActivity, worktreeActivity);
  assert.ok(inputs[0].lastEvents.every((event) => typeof event.ts === 'string'));
  assert.ok(events.some((event) => event.stage === 'liveness' && event.type === 'asked'));
  assert.ok(events.some((event) => event.stage === 'liveness'
    && event.type === 'working'
    && /delegated child/.test(event.reasoning)));
  const extended = events.find((event) => event.stage === 'executor'
    && event.type === 'extended');
  assert.equal(extended.nextIntervalMs, 120);
  assert.match(extended.reasoning, /delegated child/);

  child.emit('close', 0, null);
  await pending;
});

test('a judge finds no descendants or worktree activity stuck and the kill records evidence', async () => {
  const harness = deadlineHarness({
    judge: (input) => input.processTree.liveDescendantCount === 0
      && input.worktreeActivity.changed === false
      ? { status: 'stuck', reasoning: 'No descendants are alive and no file changed during silence.' }
      : { status: 'working', reasoning: 'There is continuing activity.' },
  });
  harness.clock.advance(50);
  await flush();

  assert.equal(harness.events[0].type, 'asked');
  assert.equal(harness.events[1].type, 'stuck');
  assert.deepEqual(harness.killed, [{
    kind: 'liveness', timeoutMs: 50, gapMs: 50,
    lastEvent: { stage: 'executor', type: 'item_completed', itemType: 'agent_message' },
    setting: 'URO_STALL_THRESHOLD_MS', judged: true,
    reasoning: 'No descendants are alive and no file changed during silence.',
  }]);
});

test('two successive working judgements do not kill and each judged interval is honored', async () => {
  let calls = 0;
  const harness = deadlineHarness({
    judge: () => ++calls === 1
      ? { status: 'working', reasoning: 'Large delegated task is active.', nextIntervalMs: 80 }
      : { status: 'working', reasoning: 'The same child remains active.' },
  });

  harness.clock.advance(50);
  await flush();
  assert.equal(calls, 1);
  harness.clock.advance(50);
  await flush();
  assert.equal(calls, 1, 'the default interval must not replace the judge-selected interval');
  harness.clock.advance(30);
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(harness.killed, []);

  harness.clock.advance(79);
  await flush();
  assert.equal(calls, 2, 'omitting an interval must reuse the previous 80ms interval');
  harness.clock.advance(1);
  await flush();
  assert.equal(calls, 3);
  assert.deepEqual(harness.events.filter((event) => event.type === 'working')
    .map((event) => ({ interval: event.nextIntervalMs, reused: event.intervalReused })), [
    { interval: 80, reused: false },
    { interval: 80, reused: true },
    { interval: 80, reused: true },
  ]);
  assert.deepEqual(harness.killed, [], 'being asked repeatedly is not evidence of death');
  harness.deadline.dispose();
});

test('a working verdict with an invalid interval stays alive and reuses the previous interval', async () => {
  let calls = 0;
  const harness = deadlineHarness({
    judge: () => {
      calls++;
      return {
        status: 'working',
        reasoning: 'The worker is alive even though this cadence is malformed.',
        nextIntervalMs: 0,
      };
    },
  });

  harness.clock.advance(50);
  await flush();

  assert.equal(calls, 1);
  assert.deepEqual(harness.killed, [], 'an invalid advisory cadence must never kill a working seat');
  assert.equal(harness.decisions[0].status, 'working');
  assert.equal(harness.decisions[0].judged, true);
  assert.equal(harness.decisions[0].nextIntervalMs, 50);
  assert.equal(harness.decisions[0].intervalReused, true);
  assert.equal(harness.decisions[0].invalidNextIntervalMs, 0);
  assert.match(harness.decisions[0].nextIntervalError, /positive safe timer integer/);

  harness.clock.advance(49);
  await flush();
  assert.equal(calls, 1, 'the invalid cadence must not silently shorten the previous interval');
  harness.clock.advance(1);
  await flush();
  assert.equal(calls, 2, 'the previous interval must be reused for the next check');
  assert.deepEqual(harness.killed, []);
  harness.deadline.dispose();
});

test('a working verdict with a valid interval still honors the new cadence', async () => {
  let calls = 0;
  const harness = deadlineHarness({
    judge: () => {
      calls++;
      return { status: 'working', reasoning: 'The worker is alive.', nextIntervalMs: 75 };
    },
  });

  harness.clock.advance(50);
  await flush();
  harness.clock.advance(74);
  await flush();
  assert.equal(calls, 1);
  harness.clock.advance(1);
  await flush();

  assert.equal(calls, 2);
  assert.equal(harness.decisions[0].nextIntervalMs, 75);
  assert.equal(harness.decisions[0].intervalReused, false);
  assert.deepEqual(harness.killed, []);
  harness.deadline.dispose();
});

test('no judge falls back to an explicitly unjudged kill', () => {
  const harness = deadlineHarness();
  harness.clock.advance(50);

  assert.deepEqual(harness.events.map((event) => event.type), ['asked', 'stuck']);
  assert.equal(harness.killed.length, 1);
  assert.equal(harness.killed[0].judged, false);
  assert.equal(harness.killed[0].unjudged, true);
  assert.match(harness.killed[0].reasoning, /no liveness judge was available/i);
});

test('a judge that hangs is bounded and cannot hang the run', async () => {
  const harness = deadlineHarness({ judge: () => new Promise(() => {}), judgeTimeoutMs: 20 });
  harness.clock.advance(50);
  await flush();
  assert.deepEqual(harness.killed, []);
  harness.clock.advance(19);
  await flush();
  assert.deepEqual(harness.killed, []);
  harness.clock.advance(1);
  await flush();

  assert.equal(harness.killed.length, 1);
  assert.equal(harness.killed[0].unjudged, true);
  assert.match(harness.killed[0].reasoning, /exceeded its 20ms bound/);
});

test('normal output indefinitely postpones both asking and killing, with silence as control', async () => {
  let judgeCalls = 0;
  const harness = deadlineHarness({
    judge: () => {
      judgeCalls++;
      return { status: 'stuck', reasoning: 'Only the positive-control silence reaches me.' };
    },
  });
  for (let index = 0; index < 10; index++) {
    harness.clock.advance(40);
    harness.byte({ stage: 'executor', type: 'item_completed', itemType: 'command_execution' });
    assert.equal(harness.lastByteAt, harness.clock.now(),
      'each observed byte must reset lastByteAt directly');
    await flush();
  }
  assert.ok(harness.clock.now() > 50);
  assert.equal(judgeCalls, 0);
  assert.deepEqual(harness.killed, []);

  harness.clock.advance(50);
  await flush();
  assert.equal(judgeCalls, 1, 'positive control: genuine silence must ask the judge');
  assert.equal(harness.killed.length, 1);
});

test('the production fresh judge is read-only, bounded, and receives verbatim evidence', async () => {
  const calls = [];
  const evidence = {
    lastAgentMessage: 'waiting on child "alpha"',
    processTree: { descendants: [{ pid: 9, name: 'worker' }] },
    worktreeActivity: { changed: false, changedFiles: [] },
  };
  const judge = createLivenessJudge({
    cwd: tmpdir(),
    superpowersDir: null,
    runSeat: async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return {
        code: 0, timedOut: false,
        stdout: `${JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: JSON.stringify({
              status: 'working', reasoning: 'The worker child is live.', nextIntervalMs: 90,
            }),
          },
        })}\n`,
      };
    },
  });
  const result = await judge(evidence);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('-s'), calls[0].args.indexOf('-s') + 2),
    ['-s', 'read-only']);
  assert.equal(calls[0].opts.timeoutMs, DEFAULT_LIVENESS_JUDGE_TIMEOUT_MS);
  assert.match(calls[0].opts.input, /waiting on child \\"alpha\\"/);
  assert.deepEqual(result, {
    status: 'working', reasoning: 'The worker child is live.', nextIntervalMs: 90,
  });
});

test('the production fresh judge preserves a working verdict with a malformed cadence', async () => {
  const judge = createLivenessJudge({
    cwd: tmpdir(),
    superpowersDir: null,
    runSeat: async () => ({
      code: 0,
      timedOut: false,
      stdout: `${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({
            status: 'working', reasoning: 'The worker child is live.', nextIntervalMs: 0,
          }),
        },
      })}\n`,
    }),
  });

  assert.deepEqual(await judge({}), {
    status: 'working',
    reasoning: 'The worker child is live.',
    invalidNextIntervalMs: 0,
    nextIntervalError: 'nextIntervalMs must be a positive safe timer integer',
  });
});

test('mutation control: post-parse else-if invalidNextIntervalMs branch records the deadline decision', async () => {
  const judge = createLivenessJudge({
    cwd: tmpdir(),
    superpowersDir: null,
    runSeat: async () => ({
      code: 0,
      timedOut: false,
      stdout: `${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({
            status: 'working', reasoning: 'The worker child is live.', nextIntervalMs: 0,
          }),
        },
      })}\n`,
    }),
  });
  const harness = deadlineHarness({ judge });

  harness.clock.advance(50);
  await flush();
  await flush();

  assert.deepEqual(harness.killed, [], 'a malformed advisory cadence must not kill a working seat');
  assert.equal(harness.decisions.length, 1);
  assert.equal(harness.decisions[0].status, 'working');
  assert.equal(harness.decisions[0].nextIntervalMs, 50);
  assert.equal(harness.decisions[0].intervalReused, true);
  assert.equal(harness.decisions[0].invalidNextIntervalMs, 0,
    'the post-parse malformed cadence must be recorded by createLivenessDeadline');
  assert.equal(harness.decisions[0].nextIntervalError,
    'nextIntervalMs must be a positive safe timer integer');
  harness.deadline.dispose();
});

test('run facts mutation control records createLivenessDeadline via decide(decision)', async () => {
  const root = mkdtempSync(join(process.cwd(), '.liveness-run-'));
  const scratchRoot = join(root, 'scratch');
  const worktree = join(root, 'worktree');
  const target = join(root, 'target');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(scratchRoot, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(target, { recursive: true });
  const judgeLiveness = async () => ({
    status: 'working', reasoning: 'Injected integration judge.', nextIntervalMs: 0,
  });
  try {
    const facts = await run({
      task: 'Observe a liveness decision.', target, gate: [], gateRetries: 0,
      scratchRoot, artifactRoot, runId: 'liveness-facts', reporter: () => {},
      stallThresholdMs: 50,
      adapters: {
        judgeLiveness,
        isolate: async () => ({
          dir: worktree, isRepo: false, baseRef: 'HEAD', baseCommit: null,
          branch: 'uro/liveness-facts',
        }),
        runExecutor: async (options) => {
          assert.equal(options.judgeLiveness, judgeLiveness);
          const harness = deadlineHarness({
            thresholdMs: options.livenessThresholdMs,
            judge: options.judgeLiveness,
            onDecision: options.onLivenessDecision,
          });
          harness.clock.advance(options.livenessThresholdMs);
          await flush();
          assert.deepEqual(harness.killed, []);
          harness.deadline.dispose();
          return { changedFiles: [], lastMessage: 'No source change.', exitCode: 0 };
        },
        diffText: async () => '',
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => { throw new Error('a no-op must not verify'); },
      },
    });
    assert.equal(facts.outcome, 'no-op');
    assert.equal(facts.livenessChecks.length, 1,
      'removing decide(decision) from createLivenessDeadline must make this mutation control fail');
    assert.equal(facts.livenessChecks[0].nextIntervalMs, 50);
    assert.equal(facts.livenessChecks[0].intervalReused, true);
    assert.equal(facts.livenessChecks[0].invalidNextIntervalMs, 0);
    assert.match(facts.livenessChecks[0].nextIntervalError, /positive safe timer integer/);
    assert.equal(facts.livenessChecks[0].reasoning,
      'Injected integration judge.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a normal run without a liveness check leaves facts and behavior unchanged', async () => {
  const root = mkdtempSync(join(process.cwd(), '.liveness-control-run-'));
  const scratchRoot = join(root, 'scratch');
  const worktree = join(root, 'worktree');
  const target = join(root, 'target');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(scratchRoot, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(target, { recursive: true });
  try {
    const facts = await run({
      task: 'Complete without a liveness check.', target, gate: [], gateRetries: 0,
      scratchRoot, artifactRoot, runId: 'liveness-control', reporter: () => {},
      adapters: {
        isolate: async () => ({
          dir: worktree, isRepo: false, baseRef: 'HEAD', baseCommit: null,
          branch: 'uro/liveness-control',
        }),
        runExecutor: async () => ({
          changedFiles: [], lastMessage: 'No source change.', exitCode: 0,
        }),
        diffText: async () => '',
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => { throw new Error('a no-op must not verify'); },
      },
    });

    assert.equal(facts.outcome, 'no-op');
    assert.deepEqual(facts.livenessChecks, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
