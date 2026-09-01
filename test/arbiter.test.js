import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildArbiterPrompt,
  buildClaudeArgs,
  parseArbiterStream,
  parseCapabilityJudgement,
  parseDecisionJudgement,
  parseFindingJudgement,
  parseLandingJudgement,
  parsePivotJudgement,
  runArbiter,
} from '../src/arbiter.js';

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => {};
  return child;
}

test('Claude arbiter arguments are headless and read-only', () => {
  const args = buildClaudeArgs({ prompt: 'judge this', model: 'claude-test' });
  assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'stream-json']);
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'plan']);
  assert.deepEqual(args.slice(args.indexOf('--model')), ['--model', 'claude-test']);
});

test('arbiter stream parsing distinguishes a readable result from no answer', () => {
  const readable = parseArbiterStream(`${JSON.stringify({
    type: 'result',
    result: '{"verdict":"valid"}',
    usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 1 },
  })}\n`);
  assert.equal(readable.verdict, 'ANSWERED');
  assert.equal(readable.answer, '{"verdict":"valid"}');
  assert.equal(readable.usage.inputTokens, 5);
  assert.equal(parseArbiterStream('{not-json}\n').verdict, 'UNVERIFIED');
  assert.equal(parseArbiterStream(`${JSON.stringify({ type: 'result', is_error: true })}\n`).verdict,
    'UNVERIFIED');
  assert.equal(parseArbiterStream([
    JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: '{"verdict":"valid"}' }] },
    }),
    JSON.stringify({ type: 'result', is_error: false, result: '' }),
  ].join('\n')).verdict, 'UNVERIFIED', 'an empty final result must beat stale assistant prose');
});

test('typed arbiter judgements reject unreadable or incomplete answers', () => {
  assert.deepEqual(parseFindingJudgement({ answer: '{"verdict":"valid"}' }),
    { verdict: 'valid' });
  assert.deepEqual(parseFindingJudgement({ answer: '{"verdict":"invalid"}' }),
    { verdict: 'UNVERIFIED' });
  assert.equal(parseDecisionJudgement({ answer: '{"answer":"choose B"}' }).answer, 'choose B');
  assert.equal(parsePivotJudgement({ answer: '{"decision":"fresh"}' }).decision, 'fresh');
  assert.deepEqual(parseCapabilityJudgement({
    capable: false, what: 'flag', why: 'unsupported', alternative: '',
  }).complete, false);
});

test('an incomplete structured capability refusal remains a veto for constructive retry', () => {
  assert.deepEqual(parseCapabilityJudgement({
    capable: false,
    what: 'unsupported flag',
  }), {
    verdict: 'answered',
    capable: false,
    what: 'unsupported flag',
    why: '',
    alternative: '',
    complete: false,
  });
});

test('runArbiter is injectable and records a readable judgement without launching Claude', async () => {
  const child = fakeChild();
  const events = [];
  let launch;
  const pending = runArbiter({
    cwd: process.cwd(),
    bin: process.execPath,
    request: { type: 'finding', finding: { id: 'F1' }, plan: 'plan', diff: 'diff' },
    timeoutMs: 1000,
    reporter: (event) => events.push(event),
    runId: 'arbiter-injected',
    spawnProcess: (bin, args, options) => {
      launch = { bin, args, options };
      return child;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'result',
    result: '{"verdict":"valid"}',
    usage: { input_tokens: 2, output_tokens: 1 },
  })}\n`));
  child.emit('close', 0, null);

  const result = await pending;
  assert.equal(launch.bin, process.execPath);
  assert.ok(launch.args.includes('--permission-mode'));
  assert.equal(result.verdict, 'ANSWERED');
  assert.equal(parseFindingJudgement(result).verdict, 'valid');
  assert.deepEqual(events.map((event) => `${event.stage}/${event.type}`), [
    'arbiter/start', 'arbiter/finish',
  ]);
});

test('the arbiter prompt never rides in argv, whatever its size', async () => {
  // On Windows `claude` is usually the npm .cmd shim, so the launch goes through
  // cmd.exe and its 8191-character command line. Measured: a 10,022-character
  // prompt makes the shim exit 1 with "The command line is too long" in under a
  // second, the arbiter reads UNVERIFIED, and every blocking finding stands with
  // no appeal. The same prompt on stdin returns 0 through the same shim.
  const huge = `${'word '.repeat(2000)}judge this`;
  assert.ok(huge.length > 8191, 'the fixture must exceed the cmd.exe limit');

  const args = buildClaudeArgs({ prompt: huge, model: 'claude-test' });
  assert.equal(args.includes(huge), false, 'the prompt must not be an argument');
  assert.ok(args.join(' ').length < 8191, 'the whole command line must clear the limit');

  // ...and it must actually reach the process on stdin.
  const child = fakeChild();
  let delivered = null;
  child.stdin = { end(value) { delivered = value ?? null; } };
  const pending = runArbiter({
    cwd: process.cwd(),
    request: { type: 'finding', finding: { id: 'F1', description: 'x' } },
    prompt: huge,
    spawnProcess: () => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', result: '{"verdict":"valid"}' })}
`));
        child.emit('close', 0);
      });
      return child;
    },
  });
  await pending;
  assert.equal(delivered, huge, 'the prompt must be written to stdin');
});

test('the landing judgement carries approval, reasoning, and findings verbatim', () => {
  assert.deepEqual(parseLandingJudgement({
    approved: false,
    reasoning: 'the diff narrows shared scope',
    findings: [{ id: 'L1', severity: 'P0', text: 'scope narrowed' }],
  }), {
    verdict: 'answered',
    approved: false,
    reasoning: 'the diff narrows shared scope',
    findings: [{ id: 'L1', severity: 'P0', text: 'scope narrowed' }],
  });
  assert.deepEqual(parseLandingJudgement({ answer: '{"approved":true,"reasoning":"sound"}' }), {
    verdict: 'answered', approved: true, reasoning: 'sound', findings: [],
  });
  // Silence is not consent: no readable boolean means UNVERIFIED, never yes.
  assert.equal(parseLandingJudgement({ answer: 'looks fine to me' }).verdict, 'UNVERIFIED');
  assert.equal(parseLandingJudgement(undefined).verdict, 'UNVERIFIED');
  // Severity travels verbatim; nothing validates or filters it.
  const carried = parseLandingJudgement({
    approved: true, reasoning: 'r',
    findings: [{ id: 'L9', severity: 'whatever-claude-said', text: 'note' }],
  });
  assert.equal(carried.findings[0].severity, 'whatever-claude-said');
});

test('the landing prompt puts the task, diff, closed findings, and evidence in front of Claude', () => {
  const prompt = buildArbiterPrompt({
    type: 'landing',
    task: 'Implement the guarded path.',
    diff: 'diff --git a/x b/x',
    findings: [{ id: 'F1', severity: 'suggestion', description: 'closed nit' }],
    evidence: [{ bin: 'node', code: 1, excerpt: 'boom' }],
  });
  assert.match(prompt, /review it YOURSELF, first-hand/);
  assert.match(prompt, /"approved":true\|false/);
  assert.match(prompt, /TASK Implement the guarded path\./);
  assert.match(prompt, /DIFF diff --git a\/x b\/x/);
  assert.match(prompt, /CLOSED_FINDINGS \[/);
  assert.match(prompt, /closed nit/);
  assert.match(prompt, /EVIDENCE \[/);
  assert.match(prompt, /boom/);
});
