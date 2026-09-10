import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportEvent } from '../src/events.js';
import { exitCodeFor } from '../src/exit.js';
import { run as executeRun } from '../src/run.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { runExecutor } from '../src/executor.js';
import { spawn, execFileSync } from 'node:child_process';

const run = (options) => executeRun(withVerifiedSuperpowers(options));

test('native stalled partial writer is preserved once and paused even with restart configured', async () => {
  const scr = scratch(), tgt = target(); let writers = 0;
  try {
    const facts = await run({ task: 'Retain partial work', target: tgt, scratchRoot: scr, gate: [], runId: 'native-partial-stall',
      reporter: () => {}, stallPolicy: 'restart', stallRestartLimit: 3, stallThresholdMs: 150,
      adapters: { runExecutor: options => {
        writers++;
        return runExecutor({ ...options, bin: process.execPath,
          spawnProcess: (bin, args, spawnOptions) => spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync("partial.txt", "useful partial bytes\\n"); process.stdout.write("ready"); setInterval(() => {},100);'], spawnOptions),
          getProcessTree: () => ({ available: true, descendants: [] }),
          getWorktreeActivity: () => ({ available: true, changed: true, changedFiles: ['partial.txt'] }),
        });
      } },
    });
    assert.equal(writers, 1);
    assert.equal(facts.approved, false);
    assert.equal(facts.nextAction, 'paused');
    assert.equal(readFileSync(join(facts.dir, 'partial.txt'), 'utf8'), 'useful partial bytes\n');
    const supervision = facts.checkpointState.supervision;
    const preserves = supervision.operations.filter(item => item.purpose === 'preservation');
    assert.equal(preserves.length, 1);
    assert.equal(preserves[0].status, 'completed');
    assert.equal(preserves[0].result.head, execFileSync('git', ['-C', facts.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    assert.match(preserves[0].result.diff, /useful partial bytes/);
    assert.ok(preserves[0].result.affectedFiles.includes('partial.txt'));
    assert.equal(supervision.uncertainty.at(-1).outcome, 'unknown');
    assert.equal(facts.retryCounts.stall, 0);
    assert.equal(facts.checkpointState.supervision.stallConfig.policy, 'restart');
  } finally { rmSync(tgt, { recursive: true, force: true }); rmSync(scr, { recursive: true, force: true }); }
});

const SAFE_SCRATCH_BASE = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

function scratch() {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SAFE_SCRATCH_BASE, '.stall-'));
}

function target() {
  const directory = mkdtempSync(join(tmpdir(), 'stall-target-'));
  writeFileSync(join(directory, 'seed.txt'), 'seed\n');
  return directory;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function executorEvent(opts, type, fields = {}) {
  reportEvent(opts.reporter, opts.runId, 'executor', type, {
    attempt: opts.attempt, ...fields,
  });
}

test('report policy records a required liveness kill without scheduling a restart',
  async () => {
    const scr = scratch();
    const tgt = target();
    const events = [];
    try {
      const facts = await run({
        task: 'Think, then make no change.', target: tgt, gate: [], gateRetries: 0,
        scratchRoot: scr, runId: 'report-stall', reporter: (event) => events.push(event),
        stallPolicy: 'report', stallThresholdMs: 25, stallRestartLimit: 1,
        adapters: {
          runExecutor: async (opts) => {
            assert.equal(opts.signal, undefined, 'report policy must allocate no restart signal');
            executorEvent(opts, 'start');
            await delay(70);
            executorEvent(opts, 'finish', { code: -1, timedOut: true });
            return {
              changedFiles: [], lastMessage: 'killed after silence', timedOut: true,
              timeoutMs: 25, exitCode: -1,
              timeoutReason: { kind: 'liveness', timeoutMs: 25, gapMs: 25,
                lastEvent: { stage: 'executor', type: 'start' },
                setting: 'URO_STALL_THRESHOLD_MS' },
            };
          },
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => { throw new Error('a no-op must not verify'); },
        },
      });
      assert.equal(facts.nextAction, 'paused');
      assert.equal(facts.approved, false);
      assert.equal(facts.retryCounts.stall, 0);
      assert.ok(facts.stallEvents.some((event) => event.stage === 'executor'));
      assert.ok(events.some((event) => event.stage === 'executor' && event.type === 'stalled'),
        'positive control: report behavior must be proved with a stall that actually fired');
      assert.match(readFileSync(join(facts.dir, 'uro-report.md'), 'utf8'), /## Stalls/);
    } finally {
      rmSync(tgt, { recursive: true, force: true });
      rmSync(scr, { recursive: true, force: true });
    }
  });

test('saved restart policy terminates one uncertain writer and never grants relaunch',
  async () => {
    const scr = scratch();
    const tgt = target();
    const plans = [];
    const killed = [];
    let calls = 0;
    try {
      const facts = await run({
        task: 'Complete the original task.', target: tgt, gate: [], gateRetries: 0,
        scratchRoot: scr, runId: 'restart-stall', reporter: () => {},
        stallPolicy: 'restart', stallThresholdMs: 25, stallRestartLimit: 1,
        adapters: {
          runExecutor: async (opts) => {
            plans.push(opts.plan);
            executorEvent(opts, 'start');
            calls++;
            if (calls === 1) {
              assert.ok(opts.signal, 'restart policy needs a signal while budget remains');
              await new Promise((resolve) => opts.signal.addEventListener('abort', resolve,
                { once: true }));
              killed.push(opts.signal.aborted);
              executorEvent(opts, 'finish', { code: -1 });
              return { changedFiles: [], lastMessage: 'stopped', aborted: true };
            }
            assert.equal(opts.signal, undefined,
              'the exhausted restart budget must not arm another destructive action');
            await delay(70);
            executorEvent(opts, 'finish', { code: 0 });
            return {
              changedFiles: [], lastMessage: 'killed after second silence', timedOut: true,
              timeoutMs: 25, exitCode: -1,
              timeoutReason: { kind: 'liveness', timeoutMs: 25, gapMs: 25,
                lastEvent: { stage: 'executor', type: 'start' },
                setting: 'URO_STALL_THRESHOLD_MS' },
            };
          },
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => { throw new Error('a no-op must not verify'); },
        },
      });
      assert.deepEqual(killed, [true], 'the first stalled launch must actually receive abort');
      assert.equal(calls, 1, 'uncertain writer cannot restart');
      assert.match(plans[0], /Complete the original task/);
      assert.equal(facts.retryCounts.stall, 0);
      assert.equal(facts.limits.stall.restartLimit, 1);
      assert.ok(facts.stallEvents.some((event) => event.action === 'pause'));
      assert.equal(facts.nextAction, 'paused');
      assert.equal(facts.approved, false);
    } finally {
      rmSync(tgt, { recursive: true, force: true });
      rmSync(scr, { recursive: true, force: true });
    }
  });

test('stall termination neither consumes restart allowance nor reaches evidence commands', async () => {
  const scr = scratch();
  const tgt = target();
  let executorCalls = 0;
  let gateCalls = 0;
  try {
    const facts = await run({
      task: 'Make a gated change.', target: tgt, gate: [], gateRetries: 2,
      scratchRoot: scr, runId: 'separate-retries', reporter: () => {},
      stallPolicy: 'restart', stallThresholdMs: 25, stallRestartLimit: 1,
      adapters: {
        runExecutor: async (opts) => {
          executorCalls++;
          executorEvent(opts, 'start');
          if (executorCalls === 1) {
            writeFileSync(join(opts.cwd, 'changed.txt'), 'partial work\n');
            await new Promise((resolve) => opts.signal.addEventListener('abort', resolve,
              { once: true }));
            executorEvent(opts, 'finish', { code: -1 });
            return { changedFiles: [], lastMessage: 'stopped', aborted: true };
          }
          writeFileSync(join(opts.cwd, 'changed.txt'), `attempt ${executorCalls}\n`);
          executorEvent(opts, 'file_change', { file: 'changed.txt' });
          executorEvent(opts, 'finish', { code: 0 });
          return { changedFiles: ['changed.txt'], lastMessage: 'changed', timedOut: false };
        },
        runGate: async () => { gateCalls++; return { passed: true, results: [] }; },
        runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
      },
    });
    assert.equal(facts.nextAction, 'paused');
    assert.deepEqual(facts.retryCounts, { stall: 0 });
    assert.equal(facts.limits.stall.restartLimit, 1);
    assert.equal(executorCalls, 1);
    assert.equal(gateCalls, 0, 'uncertain writer reaches no command effect');
    assert.equal(readFileSync(join(facts.dir, 'changed.txt'), 'utf8'), 'partial work\n');
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('a run that remains stalled until its stage timeout has a non-zero outcome', async () => {
  const scr = scratch();
  const tgt = target();
  try {
    const facts = await run({
      task: 'Do not report a stalled timeout as success.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'stalled-timeout', reporter: () => {},
      stallPolicy: 'report', stallThresholdMs: 25,
      adapters: {
        runExecutor: async (opts) => {
          executorEvent(opts, 'start');
          await delay(70);
          executorEvent(opts, 'finish', { code: -1, timedOut: true });
          return { changedFiles: [], lastMessage: 'timed out', timedOut: true,
            timeoutMs: 70, exitCode: -1 };
        },
        runGate: async () => { throw new Error('timed-out executor must not reach the gate'); },
        runVerifier: async () => { throw new Error('timed-out executor must not verify'); },
      },
    });
    assert.ok(facts.stallEvents.some((event) => event.stage === 'executor'),
      'positive control: this timeout must also have crossed the stall threshold');
    assert.equal(facts.nextAction, 'paused');
    assert.notEqual(exitCodeFor(facts.outcome), 0);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('without a reporter even invalid watchdog settings are never resolved', async () => {
  const scr = scratch();
  const tgt = target();
  try {
    const facts = await run({
      task: 'No observer means no watchdog.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'no-watchdog', env: { URO_STALL_POLICY: 'invalid' },
      adapters: {
        runExecutor: async (opts) => {
          assert.equal(opts.signal, undefined);
          return { changedFiles: [], error: 'controlled no-change pause', usage: { inputTokens: 1, outputTokens: 1 } };
        },
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => { throw new Error('no-op must not verify'); },
      },
    });
    assert.equal(facts.nextAction, 'paused');
    assert.equal(facts.approved, false);
    assert.equal(Object.hasOwn(facts, 'stallEvents'), false);
    assert.equal(Object.hasOwn(facts, 'retryCounts'), false);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});
