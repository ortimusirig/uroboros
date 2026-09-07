import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReviewPass, runVerifier } from '../src/verifier.js';
import { runArbiter, parseFindingJudgement } from '../src/arbiter.js';

function captureFixture(events, code = 0, stderr = '') {
  const observed = {};
  observed.spawnProcess = (bin, args, options) => {
    Object.assign(observed, { bin, args, options });
    const child = new EventEmitter(); child.pid = 12345;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end(input) { observed.input = input; } }; child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(events.map((e) => JSON.stringify(e)).join('\n')));
      child.stderr.emit('data', Buffer.from(stderr)); child.emit('close', code);
    });
    return child;
  };
  return observed;
}
const success = (result) => ({ type: 'result', subtype: 'success', is_error: false, result,
  duration_ms: 3, duration_api_ms: 2, num_turns: 1, session_id: 'test', total_cost_usd: 0,
  usage: { input_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
});
const reviewBundle = JSON.stringify({ version: 1, report: 'Reviewed required behavior. No findings.',
  tests: [{ path: 'tests/f1.test.js', content: 'console.log("independent test");\n' }] });

test('production Claude review uses stdin, read-only transport and harness materialization', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'uro-claude-review-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const fixture = captureFixture([success(reviewBundle)]);
  const events = [];
  const prompt = 'Review full request\n' + 'x'.repeat(12000);
  const result = await runReviewPass({ cwd, prompt, model: 'claude-test', spawnProcess: fixture.spawnProcess,
    round: 2, diffDigest: 'current', timeoutMs: 1000, runId: 'transport', reporter: (event) => events.push(event) });
  const launch = events.find((event) => event.type === 'start');
  assert.equal(launch.bin, 'claude');
  assert.equal(fixture.input, prompt);
  assert.equal(fixture.args.includes(prompt), false);
  assert.equal(launch.args[launch.args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(launch.args.includes('--plugin-dir'), false);
  assert.equal(result.provider, 'claude');
  assert.equal(result.role, 'execution-reviewer');
  assert.equal(result.artifact.round, 2);
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(readFileSync(join(cwd, '__uro_review/tests/f1.test.js'), 'utf8'), 'console.log("independent test");\n');
});

for (const [name, events, code] of [
  ['missing final result', [{ type: 'assistant', message: { content: [{ type: 'text', text: reviewBundle }] } }], 0],
  ['empty final result', [success(reviewBundle), success('')], 0],
  ['error final result', [{ ...success(reviewBundle), is_error: true }], 0],
  ['malformed bundle', [success('{bad')], 0],
  ['quota exit after answer', [success(reviewBundle)], 1],
]) test(`${name} cannot publish a current review`, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'uro-claude-failed-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const fixture = captureFixture(events, code, 'quota diagnostics'.repeat(200));
  const result = await runReviewPass({ cwd, spawnProcess: fixture.spawnProcess, timeoutMs: 1000 });
  assert.equal(result.artifact ?? null, null);
  assert.equal(result.launchFailed || result.artifactFailed, true);
  assert.equal(result.stderr, 'quota diagnostics'.repeat(200));
  assert.equal(existsSync(join(cwd, '__uro_review/REVIEW.md')), false);
});

test('failed Claude transport keeps exact answer and diagnostics but cannot judge', async () => {
  const answer = '  {"verdict":"invalid","reason":"partial"}\n\n';
  const fixture = captureFixture([success(answer)], 1, 'long diagnostic '.repeat(300));
  const result = await runArbiter({ cwd: process.cwd(), request: { type: 'finding' }, spawnProcess: fixture.spawnProcess });
  assert.equal(result.answer, answer);
  assert.equal(result.stderr, 'long diagnostic '.repeat(300));
  assert.equal(parseFindingJudgement(result).verdict, 'UNVERIFIED');
});

test('runVerifier uses Claude and rejects a verdict emitted before process failure', async () => {
  const fixture = captureFixture([success('NO_BLOCKERS')], 1);
  const events = [];
  const result = await runVerifier({ cwd: process.cwd(), spawnProcess: fixture.spawnProcess,
    runId: 'verifier', reporter: (event) => events.push(event) });
  assert.equal(events.find((event) => event.type === 'start').bin, 'claude');
  assert.equal(result.verdict, 'UNVERIFIED');
  assert.equal(result.launchFailed, true);
  assert.ok(events.filter((event) => event.type === 'finish').every((event) => event.verdict === 'UNVERIFIED'));
});

test('Claude verifier retains long answers, reported zero usage and raw-byte liveness', async () => {
  const answer = '  ' + 'reasoning\n'.repeat(2000) + '\nNO_BLOCKERS\n';
  const fixture = captureFixture([{ ...success(answer), usage: { input_tokens: 0, output_tokens: 0 } }]);
  let bytes = 0;
  const result = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    spawnProcess: fixture.spawnProcess, onLiveness: () => bytes++ });
  assert.equal(result.answer, answer);
  assert.equal(result.verdict, 'NO_BLOCKERS');
  assert.equal(result.usage.inputTokens, 0);
  assert.equal(bytes, 1);
});

test('Claude verifier retries one failed launch and retains its diagnostic event', async () => {
  let attempts = 0;
  const events = [];
  const result = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    runId: 'retry', reporter: (event) => events.push(event),
    spawnProcess: (...args) => (++attempts === 1
      ? captureFixture([], 1, 'launch refused') : captureFixture([success('NO_BLOCKERS')])).spawnProcess(...args) });
  assert.equal(attempts, 2);
  assert.equal(result.verdict, 'NO_BLOCKERS');
  assert.match(events.find((event) => event.type === 'retry').reason, /launch refused/);
});

test('verifier retry retains the entire failed Claude attempt and its usage', async () => {
  let attempts = 0;
  const first = captureFixture([success('  partial failed answer\n')], 1, 'diagnostics '.repeat(500));
  const second = captureFixture([success('NO_BLOCKERS')]);
  const result = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    spawnProcess: (...args) => (++attempts === 1 ? first : second).spawnProcess(...args) });
  assert.equal(result.attempts?.length, 2);
  assert.equal(result.attempts[0].answer, '  partial failed answer\n');
  assert.equal(result.attempts[0].stderr, 'diagnostics '.repeat(500));
  assert.equal(result.usage.inputTokens, 24);
});

for (const [name, adapter] of [['review', runReviewPass], ['verifier', runVerifier]]) {
  test(`Claude ${name} timeout kills the process tree and never retries or approves`, async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'uro-claude-timeout-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    let launches = 0, killed = 0;
    const result = await adapter({ cwd, bin: process.execPath, timeoutMs: 5,
      spawnProcess: () => {
        launches++;
        const child = new EventEmitter(); child.pid = 12345;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = { end() {} }; child.kill = () => {};
        return child;
      },
      killProcessTree: (child) => { killed++; child.emit('close', 1); },
    });
    assert.equal(launches, 1);
    assert.equal(killed, 1);
    assert.equal(result.timedOut, true);
    assert.equal(result.launchFailed, true);
    assert.equal(result.artifact ?? null, null);
    assert.equal(existsSync(join(cwd, '__uro_review/REVIEW.md')), false);
  });

  test(`Claude ${name} rejects approval flags before launching`, async () => {
    let launches = 0;
    await assert.rejects(() => adapter({ cwd: process.cwd(), extraArgv: ['--dangerously-skip-permissions'],
      spawnProcess: () => { launches++; throw new Error('must not launch'); } }));
    assert.equal(launches, 0);
  });
}

test('Claude review reports a thrown launch failure without fabricating usage', async () => {
  const result = await runReviewPass({ cwd: process.cwd(), bin: process.execPath,
    spawnProcess: () => { throw new Error('launch unavailable'); } });
  assert.equal(result.launchFailed, true);
  assert.equal(result.usage, null);
  assert.match(result.stderr ?? result.error, /launch unavailable/);
});
