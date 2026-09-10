import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutor } from '../src/executor.js';
import { runReviewPass } from '../src/verifier.js';

for (const mode of ['no-judge', 'no-reporter', 'stuck', 'working', 'malformed', 'hung-judge', 'progress', 'deadline']) {
  test(`production review bundle supervises ${mode} with injected clocks and process cleanup`, async t => {
    const cwd = mkdtempSync(join(tmpdir(), 'uro-review-supervision-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const clock = controlledClock(), child = fakeChild(), events = [], inputs = [];
    let kills = 0;
    const pending = runReviewPass({ cwd, bin: process.execPath, env: {},
      ...(mode === 'deadline' ? { timeoutMs: 20 } : {}),
      ...(mode === 'no-reporter' ? {} : { reporter: event => events.push(event) }), runId: 'review-supervision', pass: 'review',
      livenessThresholdMs: 50, progressThresholdMs: 35, livenessJudgeTimeoutMs: 20,
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      spawnProcess: () => child, killProcessTree: process => { kills++; process.emit('close', 1); },
      getProcessTree: () => ({ available: true, descendants: [] }),
      getWorktreeActivity: () => ({ available: true, changed: false, changedFiles: [] }),
      ...(mode === 'no-judge' ? {} : { judgeLiveness: input => {
        inputs.push(input);
        if (mode === 'hung-judge') return new Promise(() => {});
        return mode === 'malformed' ? {} : { status: mode === 'working' ? 'working' : 'stuck',
          reasoning: 'Injected review process evidence.', nextIntervalMs: 50 };
      } }),
    });
    await flush();
    if (mode === 'progress') {
      for (let i = 0; i < 10; i++) {
        clock.advance(30);
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `checked path ${i}` }] } }) + '\n'));
        await flush();
      }
      assert.equal(inputs.length, 0);
      assert.equal(kills, 0);
    } else {
      clock.advance(mode === 'deadline' ? 20 : 50);
      await flush(); await flush();
      if (mode === 'hung-judge') { clock.advance(20); await flush(); await flush(); }
      if (mode === 'working') {
        assert.equal(inputs.length, 1);
        assert.equal(inputs[0].seat, 'verifier');
        assert.equal(kills, 0);
      } else assert.equal(kills, 1);
    }
    if (mode === 'working' || mode === 'progress') {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        result: JSON.stringify({ version: 1, conclusion: 'clean', report: 'All required paths checked.', tests: [] }) }) + '\n'));
      child.emit('close', 0);
    } else if (!kills) child.emit('close', 1);
    const result = await pending;
    assert.equal(result.artifactFailed, !['working', 'progress'].includes(mode));
    if (!['working', 'progress'].includes(mode)) assert.equal(result.timedOut, true);
    if (mode === 'deadline') assert.equal(result.timeoutReason.kind, 'deadline');
    if (!['deadline', 'no-reporter'].includes(mode)) assert.ok(events.some(event => event.type === 'stalled' && event.tier === 'progress'));
  });
}
import { createLivenessDeadline, spawnCapture } from '../src/spawn.js';
import { run as executeRun } from '../src/run.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { createInspectionReceipt } from '../src/context-evidence.js';
import {
  createLivenessJudge,
  DEFAULT_LIVENESS_JUDGE_TIMEOUT_MS,
} from '../src/liveness-judge.js';

const run = (options) => executeRun(withVerifiedSuperpowers(options));
const runScratchBase = process.platform === 'win32' ? 'C:/ccc-test' : tmpdir();
function runScratch() { mkdirSync(runScratchBase, { recursive: true }); return mkdtempSync(join(runScratchBase, 'liveness-scratch-')); }
function nativeEnvelope(r, action, extra = {}) {
  return { schemaVersion: 1, action, artifactDigest: r.state.artifactDigest, contextDigest: r.state.snapshot.digest,
    replyTo: null, content: 'Observed current task', claims: [], issues: [], evidence: [], verifications: [], next: null, ...extra };
}
function nativeReview(r) {
  const evidence = r.state.evidence.find(item => item.id === 'requirement-briefing');
  const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' });
  return { usage: { inputTokens: 1, outputTokens: 1 }, observations: { evidence: [], receipts: [receipt] }, dialogue: nativeEnvelope(r, 'approve', {
    claims: [{ id: 'briefing-requirement', kind: 'fact', text: 'Observed the supplied task.', evidenceIds: [evidence.id] }],
    verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read the captured task.' }],
  }) };
}

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
  onDecisionRequired,
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
    onDecisionRequired,
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

test('required liveness decision is awaited before kill and failure cannot grant working extension', async () => {
  let release;
  const harness = deadlineHarness({ judge: async () => ({ status: 'working', reasoning: 'Live child' }),
    onDecisionRequired: () => new Promise((resolve, reject) => { release = () => reject(new Error('decision journal failed')); }),
  });
  harness.clock.advance(50);
  await flush(); await flush();
  assert.equal(typeof release, 'function');
  assert.equal(harness.killed.length, 0);
  release();
  await flush();
  assert.equal(harness.killed.length, 1);
  assert.match(harness.killed[0].persistenceFailure, /decision journal failed/);
  harness.deadline.dispose();
});

for (const end of ['dispose', 'timeout']) test(`native liveness ${end} prevents late evidence gathering from launching a judge`, async () => {
  const clock = controlledClock(); let release, launches = 0;
  const deadline = createLivenessDeadline({ thresholdMs: 50, judgeTimeoutMs: 20,
    getLiveness: () => ({ gapMs: 50 }),
    getProcessTree: () => new Promise(resolve => { release = resolve; }),
    judge: async () => { launches++; return { status: 'working', reasoning: 'late judge' }; },
    onDecisionRequired: async () => {}, onKill: () => {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  clock.advance(50); await flush();
  if (end === 'dispose') deadline.dispose(); else clock.advance(20);
  release({ descendants: [] }); await flush(); await flush();
  assert.equal(launches, 0);
  deadline.dispose();
});

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
  const env = { CODEX_HOME: 'C:/registered-liveness-home' };
  const evidence = {
    lastAgentMessage: 'waiting on child "alpha"',
    processTree: { descendants: [{ pid: 9, name: 'worker' }] },
    worktreeActivity: { changed: false, changedFiles: [] },
  };
  const judge = createLivenessJudge({
    cwd: tmpdir(),
    env,
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
  assert.equal(calls[0].opts.env.CODEX_HOME, env.CODEX_HOME);
  assert.equal(calls[0].opts.env[Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'], process.env[Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH']);
  assert.match(calls[0].opts.input, /waiting on child \\"alpha\\"/);
  assert.partialDeepStrictEqual(result, {
    status: 'working', reasoning: 'The worker child is live.', nextIntervalMs: 90,
  });
});

test('liveness transport retains actual launch, stdin delivery and parsed usage from an owned child', async () => {
  const script = 'process.stdin.resume(); process.stdin.on("end", () => { console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({status:"working",reasoning:"Observed child"})}})); console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:7,output_tokens:3}})); });';
  const judge = createLivenessJudge({ cwd: tmpdir(), runSeat: (bin, args, options) => {
    assert.equal(args[args.indexOf('-s') + 1], 'read-only');
    return spawnCapture(process.execPath, ['-e', script], options);
  } });
  const result = await judge({ lastAgentMessage: 'retained current task' });
  assert.equal(result.status, 'working');
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0, reasoningOutputTokens: 0, cacheWriteTokens: 0 });
  assert.equal(result.launch.argv[0], process.execPath);
  assert.equal(result.delivery.kind, 'stdin-submitted');
  assert.equal(result.delivery.consumption, 'unknown');
  assert.equal(result.exitCode, 0);
});

test('failed liveness launch retains its requested read-only transport without inventing delivery', async () => {
  const judge = createLivenessJudge({ cwd: tmpdir(), bin: 'missing-test-seat', runSeat: async () => { throw new Error('fixture launch failed'); } });
  const result = await judge({ checkCount: 1 });
  assert.equal(result.available, false);
  assert.equal(result.requestedLaunch.bin, 'missing-test-seat');
  assert.equal(result.requestedLaunch.cwd, tmpdir());
  assert.equal(result.requestedLaunch.args[result.requestedLaunch.args.indexOf('-s') + 1], 'read-only');
  assert.equal(result.launch, null);
  assert.equal(result.delivery, null);
  assert.equal(result.usage, null);
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

  assert.partialDeepStrictEqual(await judge({}), {
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
  const root = mkdtempSync(join(tmpdir(), '.liveness-run-'));
  const scratchRoot = runScratch();
  const worktree = join(root, 'worktree');
  const target = join(root, 'target');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(scratchRoot, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(target, { recursive: true });
  const judgeLiveness = async () => ({
    status: 'working', reasoning: 'Injected integration judge.', nextIntervalMs: 0, usage: { inputTokens: 2, outputTokens: 1 },
  });
  writeFileSync(join(target, 'seed.txt'), 'existing task source\n');
  try {
    const facts = await run({
      task: 'Observe a liveness decision.', target, gate: [], gateRetries: 0,
      scratchRoot, artifactRoot, runId: 'liveness-facts', reporter: () => {},
      stallThresholdMs: 50,
      adapters: {
        judgeLiveness,
        runExecutor: async (options) => {
          assert.equal(typeof options.judgeLiveness, 'function');
          let decisionRecorded;
          const recorded = new Promise(resolve => { decisionRecorded = resolve; });
          const harness = deadlineHarness({
            thresholdMs: options.livenessThresholdMs,
            judge: options.judgeLiveness,
            onDecision: decision => { options.onLivenessDecision(decision); decisionRecorded(); },
            onDecisionRequired: options.onLivenessDecisionRequired,
          });
          harness.clock.advance(options.livenessThresholdMs);
          await recorded;
          assert.deepEqual(harness.killed, []);
          harness.deadline.dispose();
          return { dialogue: nativeEnvelope(options, 'propose'), usage: { inputTokens: 1, outputTokens: 1 }, exitCode: 0 };
        },
        runGate: async () => ({ passed: true, results: [] }),
        runReview: nativeReview,
      },
    });
    assert.equal(facts.approved, true, facts.reason);
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
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('a normal run without a liveness check leaves facts and behavior unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), '.liveness-control-run-'));
  const scratchRoot = runScratch();
  const worktree = join(root, 'worktree');
  const target = join(root, 'target');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(scratchRoot, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'seed.txt'), 'existing task source\n');
  try {
    const facts = await run({
      task: 'Complete without a liveness check.', target, gate: [], gateRetries: 0,
      scratchRoot, artifactRoot, runId: 'liveness-control', reporter: () => {},
      adapters: {
        runExecutor: async r => ({
          dialogue: nativeEnvelope(r, 'propose'), usage: { inputTokens: 1, outputTokens: 1 }, exitCode: 0,
        }),
        runGate: async () => ({ passed: true, results: [] }),
        runReview: nativeReview,
      },
    });

    assert.equal(facts.approved, true, facts.reason);
    assert.deepEqual(facts.livenessChecks, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});
