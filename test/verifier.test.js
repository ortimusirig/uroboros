import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoForbiddenFlags,
  assertUsablePrompt,
  buildCursorArgs,
  buildCursorReviewArgs,
  DEFAULT_PROMPT,
  DEFAULT_VERIFIER_MODEL,
  extractPlanArtifact,
  parseVerdict,
  parseVerdictDetail,
  runVerifier,
  FINDINGS_LIMIT,
  INTENT_PROMPT,
  PLAN_LIMIT,
  REVIEW_PROMPT,
  runReviewPass,
  VERIFIER_PLUGIN_DIR,
} from '../src/verifier.js';
import { EMPTY_USAGE } from '../src/usage.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-agent.mjs', import.meta.url));
const brokenFakeAgent = fileURLToPath(new URL('../fixtures/fake-agent-broken.mjs', import.meta.url));
const realSamplePath = fileURLToPath(new URL('../fixtures/cursor-stream-schema-sample.ndjson', import.meta.url));
const planSamplePath = fileURLToPath(new URL('../fixtures/cursor-plan-mode-sample.ndjson', import.meta.url));
const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const expectedPluginDir = fileURLToPath(new URL('../cursor-plugin', import.meta.url));

function writeSuperpowersPlugin(directory, manifest = '.cursor-plugin') {
  mkdirSync(join(directory, manifest), { recursive: true });
  mkdirSync(join(directory, 'skills', 'using-superpowers'), { recursive: true });
  writeFileSync(join(directory, manifest, 'plugin.json'), JSON.stringify({
    name: 'superpowers', version: '6.0.2',
  }));
  writeFileSync(join(directory, 'skills', 'using-superpowers', 'SKILL.md'), '# skill\n');
}

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

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => {};
  return child;
}

function rewriteEvents(streamText, rewrite) {
  return streamText.trim().split(/\r?\n/)
    .map((line) => JSON.stringify(rewrite(JSON.parse(line))))
    .join('\n');
}

function planArtifactStream(plan) {
  return JSON.stringify({
    type: 'tool_call', subtype: 'completed',
    tool_call: { createPlanToolCall: { args: { name: '', overview: '', plan } } },
  });
}

test('parseVerdictDetail keeps the review text, not just the verdict', () => {
  const stream = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'Line 4 drops the error.\n\nISSUES',
  }) + '\n';
  const { verdict, text, source, planText } = parseVerdictDetail(stream);
  assert.equal(verdict, 'ISSUES');
  assert.match(text, /Line 4 drops the error/);
  assert.equal(source, 'result');
  assert.equal(planText, '');
});

test('parseVerdict still returns a bare verdict string', () => {
  assert.equal(typeof parseVerdict('{"type":"result","result":"NO_BLOCKERS"}'), 'string');
});

test('runVerifier reports findings on the path where the verifier ran', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath, extraArgv: [fakeAgent] });
  assert.equal(r.verdict, 'ISSUES');
  assert.equal(r.launchFailed, false);
  assert.equal(r.verdictSource, 'result');
  // The reasoning must survive: a verdict alone is not actionable.
  assert.match(r.findings, /a bug on line 4/);
  assert.match(r.plan, /Fake review plan/);
  assert.match(r.plan, /Retained review details/);
  assert.equal(r.verdictConsistency.status, 'consistent');
  assert.equal(r.verdictEvidence.judgedText, r.verdictEvidence.candidates.result.text);
  assert.equal(r.plan, r.verdictEvidence.candidates.plan.text);
  assert.deepEqual(r.usage, {
    inputTokens: 13,
    cachedInputTokens: 3,
    outputTokens: 4,
    reasoningOutputTokens: 0,
    cacheWriteTokens: 2,
  });
});

test('runVerifier findings are capped', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath, extraArgv: [fakeAgent] });
  assert.ok(r.findings.length <= FINDINGS_LIMIT);
});

test('runVerifier plan artifacts are capped separately from findings', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    extraArgv: [fakeAgent, 'long-plan'] });
  assert.ok(r.plan.length <= PLAN_LIMIT);
  assert.match(r.findings, /a bug on line 4/);
});

test('intent-pass plan artifacts use the same cap', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    prompt: INTENT_PROMPT, extraArgv: [fakeAgent, 'long-plan'] });
  assert.ok(r.plan.length <= PLAN_LIMIT);
  assert.match(r.findings, /a bug on line 4/);
});

test('a failed launch reports stderr and carries no findings', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath, extraArgv: [brokenFakeAgent] });
  assert.equal(r.launchFailed, true);
  assert.equal(r.findings, undefined);
  assert.equal(r.verdictSource, 'none');
  assert.deepEqual(r.usage, EMPTY_USAGE);
});

test('assertUsablePrompt accepts a usable prompt', () => {
  assert.doesNotThrow(() => assertUsablePrompt('review the diff'));
});

test('both prompts are usable skill pointers with self-sufficient verdict contracts', () => {
  for (const prompt of [DEFAULT_PROMPT, INTENT_PROMPT]) {
    assert.doesNotThrow(() => assertUsablePrompt(prompt));
    assert.match(prompt, /^\/uro-verify\b/, 'the prompt must explicitly select the shipped skill');
    assert.match(prompt, /final line exactly NO_BLOCKERS or exactly ISSUES/,
      'the prompt must retain the verdict contract if skill loading fails');
    assert.doesNotMatch(prompt, /["\r\n]/);
  }
  assert.match(DEFAULT_PROMPT, /Read CHANGES[.]diff/);
  assert.match(DEFAULT_PROMPT, /correctness and blocking bugs/);
  assert.match(INTENT_PROMPT, /Read TASK[.]md and CHANGES[.]diff/);
  assert.match(INTENT_PROMPT, /fully implements every TASK[.]md requirement/);
  assert.match(INTENT_PROMPT, /assertions detect broken behavior/);
});

// Asserting VERIFIER_PLUGIN_DIR equals repoRoot/cursor-plugin proves nothing while the
// suite runs from the repository root, because a broken join(process.cwd(), 'cursor-plugin')
// yields exactly the same string. Resolve it from a DIFFERENT working directory, where the
// two implementations disagree, so the assertion can actually fail.
test('the plugin path is resolved from the module, not the working directory', async () => {
  const verifierUrl = new URL('../src/verifier.js', import.meta.url).href;
  const elsewhere = mkdtempSync(join(tmpdir(), 'cwd-'));
  try {
    const r = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      `import { VERIFIER_PLUGIN_DIR } from ${JSON.stringify(verifierUrl)};`
      + ' process.stdout.write(VERIFIER_PLUGIN_DIR);',
    ], { cwd: elsewhere, encoding: 'utf8' });

    assert.equal(r.status, 0, `resolving the plugin dir failed: ${r.stderr}`);
    assert.equal(r.stdout, expectedPluginDir,
      'the plugin path must resolve from verifier.js, not from process.cwd()');
    assert.notEqual(r.stdout, join(elsewhere, 'cursor-plugin'),
      'a cwd-derived implementation must fail this test');
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('correctness and intent launches load the plugin and remain read-only', async () => {

  for (const [pass, prompt] of [['correctness', DEFAULT_PROMPT], ['intent', INTENT_PROMPT]]) {
    const events = [];
    await runVerifier({
      cwd: fixturesDir,
      bin: process.execPath,
      extraArgv: [fakeAgent, 'clean'],
      prompt,
      pass,
      runId: `plugin-launch-${pass}`,
      reporter: (event) => events.push(event),
    });
    const args = events.find((event) => event.stage === 'verify' && event.type === 'start')?.args;
    assert.ok(args, `${pass} launch must report its combined argv`);
    assert.equal(args[args.indexOf('--plugin-dir') + 1], expectedPluginDir);
    assert.equal(args[args.indexOf('--mode') + 1], 'plan');
    assert.ok(args.includes('--trust'));
    assertNoForbiddenFlags(args);
  }
});

test('assertUsablePrompt rejects double quotes', () => {
  assert.throws(() => assertUsablePrompt('say "hi"'), /double quote/);
});

test('assertUsablePrompt rejects newlines', () => {
  assert.throws(() => assertUsablePrompt('line one\nline two'), /single line/);
});

test('assertUsablePrompt rejects an empty prompt', () => {
  assert.throws(() => assertUsablePrompt('   '), /empty/);
});

test('buildCursorArgs uses read-only plan mode, trust, and the pinned model', () => {
  assert.match(DEFAULT_VERIFIER_MODEL, /^cursor-grok-4[.]5-high$/);
  const a = buildCursorArgs({}).join(' ');
  assert.match(a, /--mode plan/);
  assert.match(a, /--output-format stream-json/);
  assert.match(a, /--trust/, 'must clear the workspace-trust gate or every review is UNVERIFIED');
  assert.match(a, new RegExp(DEFAULT_VERIFIER_MODEL.replaceAll('.', '\\.')));
});

test('buildCursorArgs accepts an explicit model override', () => {
  const a = buildCursorArgs({ model: 'verifier-override' });
  assert.equal(a[a.indexOf('--model') + 1], 'verifier-override');
});

test('forbidden write flags never appear', () => {
  assert.doesNotMatch(buildCursorArgs({}).join(' '), /--force|--yolo|(^| )-f( |$)|--approve-mcps/);
});

test('buildCursorArgs rejects a quote-bearing prompt', () => {
  assert.throws(() => buildCursorArgs({ prompt: 'has "quotes"' }), /double quote/);
});

test('assertNoForbiddenFlags throws on a write flag', () => {
  assert.throws(() => assertNoForbiddenFlags(['-p', '--force']), /force/);
  for (const flag of ['--force=true', '--yolo=true', '--approve-mcps=true', '-f=true']) {
    assert.throws(() => assertNoForbiddenFlags(['-p', flag]), /forbidden verifier flag/,
      `${flag} must not bypass the approval guard`);
  }
});

test('runVerifier rejects forbidden flags for correctness and intent launches', async () => {
  for (const prompt of [DEFAULT_PROMPT, INTENT_PROMPT]) {
    await assert.rejects(
      () => runVerifier({ cwd: process.cwd(), prompt, extraArgv: ['--approve-mcps'] }),
      /forbidden verifier flag/,
    );
  }
});

test('runVerifier returns NO_BLOCKERS when the stream says so', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    extraArgv: [fakeAgent, 'clean'] });
  assert.equal(r.verdict, 'NO_BLOCKERS');
  assert.equal(r.launchFailed, false);
});

test('runVerifier identifies a non-zero empty stream as a launch failure', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    extraArgv: [brokenFakeAgent] });
  assert.equal(r.verdict, 'UNVERIFIED');
  assert.equal(r.launchFailed, true);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /fake agent failed/);
});

test('review launch is write-capable while both verdict launches remain read-only', () => {
  const reviewArgs = buildCursorReviewArgs({ superpowersDir: null });
  assert.equal(reviewArgs.includes('--mode'), false,
    'the review writer must omit Cursor read-only plan mode');
  // Write capability comes from omitting --mode, NOT from --sandbox. This
  // previously asserted the sandbox flag unconditionally, which is why a launch
  // line the real Cursor rejects on Windows shipped green. Platform behaviour is
  // asserted separately; what matters here is that the pass can write.
  const sandboxed = buildCursorReviewArgs({ platform: 'linux', superpowersDir: null });
  assert.deepEqual(sandboxed.slice(sandboxed.indexOf('--sandbox'), sandboxed.indexOf('--sandbox') + 2),
    ['--sandbox', 'enabled']);
  assert.match(REVIEW_PROMPT, /^\/uro-review\b/);

  for (const prompt of [DEFAULT_PROMPT, INTENT_PROMPT]) {
    const verdictArgs = buildCursorArgs({ prompt, superpowersDir: null });
    assert.equal(verdictArgs[verdictArgs.indexOf('--mode') + 1], 'plan',
      'correctness and intent must retain read-only plan mode');
  }
});

test('review launch arguments remain guarded against forbidden approval flags', () => {
  const reviewArgs = buildCursorReviewArgs({ superpowersDir: null });
  assert.doesNotThrow(() => assertNoForbiddenFlags(reviewArgs));
  assert.throws(() => assertNoForbiddenFlags([...reviewArgs, '--force']), /force/);
});

test('runReviewPass launches the separate sandboxed writer without verdict mode', async () => {
  const child = fakeChild();
  const events = [];
  const pending = runReviewPass({
    cwd: process.cwd(),
    bin: process.execPath,
    superpowersDir: null,
    runId: 'review-writer',
    reporter: (event) => events.push(event),
    platform: 'linux',
    spawnProcess: (_bin, _args, _options) => child,
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('close', 0, null);
  const result = await pending;

  const args = events.find((event) => event.type === 'start')?.args;
  assert.equal(args.includes('--mode'), false);
  // Pin the platform: on Windows the real Cursor rejects --sandbox, so asserting
  // it unconditionally is what let a broken launch line ship green.
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2),
    ['--sandbox', 'enabled']);
  assert.equal(result.launchFailed, false);
});

test('runReviewPass rejects a forbidden flag before spawning the writer', async () => {
  let spawned = false;
  await assert.rejects(() => runReviewPass({
    cwd: process.cwd(),
    superpowersDir: null,
    extraArgv: ['--force'],
    spawnProcess: () => { spawned = true; return fakeChild(); },
  }), /forbidden verifier flag/);
  assert.equal(spawned, false);
});

test('runReviewPass rejects every --mode spelling before spawning the writer', async () => {
  for (const extraArgv of [['--mode', 'plan'], ['--mode=plan']]) {
    let spawned = false;
    await assert.rejects(() => runReviewPass({
      cwd: process.cwd(),
      superpowersDir: null,
      extraArgv,
      spawnProcess: () => { spawned = true; return fakeChild(); },
    }), /review pass must omit --mode/);
    assert.equal(spawned, false);
  }
});

test('raw stdout resets the verifier liveness gap through the runVerifier observer', async () => {
  const clock = controlledClock();
  const child = fakeChild();
  const livenessChecks = [];
  let kills = 0;
  const pending = runVerifier({
    cwd: tmpdir(), bin: process.execPath, extraArgv: ['unused'], env: {},
    runId: 'chatty-verifier', pass: 'correctness',
    livenessThresholdMs: 50, progressThresholdMs: 100,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    spawnProcess: () => child,
    killProcessTree: () => { kills++; },
    judgeLiveness: async (evidence) => {
      livenessChecks.push(evidence);
      return { status: 'working', reasoning: 'Raw stdout proves the verifier is live.' };
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

  // Removing verifier.js's onStdout lastByteAt reset makes this 90, measured from start.
  assert.equal(livenessChecks.length, 1, 'the controlled liveness deadline must consult its judge');
  assert.equal(livenessChecks[0].gapMs, 50,
    'the judge must measure from stdout observed by runVerifier, not process start');
  assert.equal(kills, 0, 'the fresh stdout gap must not terminate the verifier');

  child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(kills, 0);
});

test('runVerifier launches Cursor under the environment used for verification', async () => {
  const env = { URO_SUPERPOWERS_DIR: 'C:/verified-by-preflight' };
  const child = fakeChild();
  let spawnOptions;
  const pending = runVerifier({
    cwd: process.cwd(),
    bin: process.execPath,
    env,
    superpowersDir: null,
    spawnProcess: (_bin, _args, options) => { spawnOptions = options; return child; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('close', 0, null);
  await pending;

  assert.equal(spawnOptions.env.URO_SUPERPOWERS_DIR, env.URO_SUPERPOWERS_DIR);
  assert.equal(spawnOptions.env.PATH, process.env.PATH,
    'a Superpowers override must not remove the PATH needed to launch Cursor');
});

test('buildCursorArgs carries both plugin directories and remains guarded', () => {
  const superpowersDir = mkdtempSync(join(tmpdir(), 'uro-cursor-superpowers-'));
  writeSuperpowersPlugin(superpowersDir);
  try {
    const args = buildCursorArgs({
      env: { URO_SUPERPOWERS_DIR: superpowersDir }, home: tmpdir(),
    });
    const pluginDirectories = args.flatMap((arg, index) => (
      arg === '--plugin-dir' ? [args[index + 1]] : []
    ));
    assert.deepEqual(pluginDirectories, [expectedPluginDir, superpowersDir]);
    assert.equal(args[args.indexOf('--mode') + 1], 'plan');
    assert.ok(args.includes('--trust'));
    assert.doesNotThrow(() => assertNoForbiddenFlags(args));
  } finally {
    rmSync(superpowersDir, { recursive: true, force: true });
  }
});

test('buildCursorArgs rejects a Codex-only superpowers directory before launching Cursor', () => {
  const superpowersDir = mkdtempSync(join(tmpdir(), 'uro-codex-only-superpowers-'));
  writeSuperpowersPlugin(superpowersDir, '.codex-plugin');
  try {
    assert.throws(
      () => buildCursorArgs({ superpowersDir }),
      /Cursor.*[.]cursor-plugin/i,
    );
  } finally {
    rmSync(superpowersDir, { recursive: true, force: true });
  }
});

test('buildCursorArgs without superpowers is byte-identical to the previous invocation', () => {
  assert.deepEqual(buildCursorArgs({ superpowersDir: null }), [
    '-p', DEFAULT_PROMPT,
    '--output-format', 'stream-json',
    '--mode', 'plan',
    '--trust',
    '--plugin-dir', expectedPluginDir,
    '--model', DEFAULT_VERIFIER_MODEL,
  ]);
});

test('runVerifier returns ISSUES otherwise', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    extraArgv: [fakeAgent, 'dirty'] });
  assert.equal(r.verdict, 'ISSUES');
});

test('parseVerdict handles the real captured cursor-agent stream without crashing', () => {
  const streamText = readFileSync(realSamplePath, 'utf8');
  const verdict = parseVerdict(streamText);
  assert.ok(verdict === 'NO_BLOCKERS' || verdict === 'ISSUES');
  // The sample is a FILEOK probe with no NO_BLOCKERS token, proving the parser
  // reads the real nested assistant/result shape rather than crashing or false-matching.
  assert.equal(verdict, 'ISSUES');
});

test('extractPlanArtifact returns the last real plan tool-call artifact and ignores interaction copies', () => {
  const streamText = rewriteEvents(readFileSync(planSamplePath, 'utf8'), (event) => {
    const planArgs = event.tool_call?.createPlanToolCall?.args;
    if (event.type === 'tool_call' && event.subtype === 'started' && planArgs) {
      planArgs.name = 'Stale started copy';
    }
    const interactionArgs = event.query?.createPlanRequestQuery?.args;
    if (interactionArgs) interactionArgs.name = 'Interaction copy must be ignored';
    return event;
  });
  const artifact = extractPlanArtifact(streamText);
  assert.equal(artifact.name, 'Diff review verdict');
  assert.match(artifact.overview, /implementation is wrong/);
  assert.match(artifact.plan, /return a - b/);
  assert.match(artifact.plan, /ISSUES$/);
  assert.equal(extractPlanArtifact(readFileSync(realSamplePath, 'utf8')), null);
});

test('parseVerdictDetail labels a conclusive real assistant fallback as assistant-sourced', () => {
  const streamText = readFileSync(planSamplePath, 'utf8').trim().split(/\r?\n/)
    .map(JSON.parse)
    .filter((event) => event.type !== 'result')
    .map(JSON.stringify)
    .join('\n');
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'assistant');
  assert.match(detail.text, /wrong implementation/);
});

test('parseVerdictDetail labels a conclusive real result as result-sourced', () => {
  const detail = parseVerdictDetail(readFileSync(planSamplePath, 'utf8'));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'result');
  assert.match(detail.text, /wrong implementation/);
  assert.match(detail.planText, /Sole assertion/);
});

test('parseVerdictDetail falls back to the real plan artifact when result is only preamble', () => {
  const streamText = rewriteEvents(readFileSync(planSamplePath, 'utf8'), (event) => {
    if (event.type === 'result') event.result = 'Review saved to the plan artifact.';
    if (event.type === 'assistant') {
      for (const part of event.message?.content ?? []) {
        if (part.type === 'text') part.text = 'Review saved to the plan artifact.';
      }
    }
    return event;
  });
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
  assert.equal(detail.text, 'Review saved to the plan artifact.');
  assert.match(detail.planText, /Sole assertion/);
  assert.match(detail.planText, /ISSUES$/);
});

test('parseVerdictDetail labels an inconclusive real stream as fail-safe none', () => {
  const detail = parseVerdictDetail(readFileSync(realSamplePath, 'utf8'));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
});

test('parseVerdict returns NO_BLOCKERS from a real-shaped result string', () => {
  const streamText = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'checking...' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All clear.\n\nNO_BLOCKERS' }),
  ].join('\n');
  assert.equal(parseVerdict(streamText), 'NO_BLOCKERS');
});

test('an empty stream is UNVERIFIED with unchanged none provenance', () => {
  const detail = parseVerdictDetail('');

  assert.equal(detail.verdict, 'UNVERIFIED');
  assert.equal(detail.source, 'none');
  assert.equal(detail.text, '');
  assert.equal(detail.planText, '');
});

test('a markerless stream with findings remains fail-safe ISSUES', () => {
  const detail = parseVerdictDetail(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'A blocking race remains in the retry path.',
  }));

  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
  assert.match(detail.text, /blocking race/);
});

test('real verdict markers remain conclusive', () => {
  for (const verdict of ['NO_BLOCKERS', 'ISSUES']) {
    const detail = parseVerdictDetail(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: `Review complete.\n\n${verdict}`,
    }));

    assert.equal(detail.verdict, verdict);
    assert.equal(detail.source, 'result');
  }
});

test('a non-blocking-notes heading does not turn a clean assistant verdict into ISSUES', () => {
  const assistantText = 'No blocking problems found.\n\nNO_BLOCKERS';
  const resultText = 'The review is clean.\n\n## Non-blocking notes (not ISSUES)';
  const streamText = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: resultText }),
  ].join('\n');

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'NO_BLOCKERS');
  assert.equal(detail.source, 'assistant');
  assert.equal(detail.text, assistantText);
});

test('a mid-paragraph NO_BLOCKERS refusal cannot hide a final blocking finding', () => {
  const streamText = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: "I can't mark this NO_BLOCKERS — there is a null dereference on line 40.\n\nThe null dereference is blocking and must be fixed.",
  });

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
  assert.match(detail.text, /null dereference is blocking/);
});

test('final-line formatting noise is ignored for NO_BLOCKERS', () => {
  const finalLines = [
    '**NO_BLOCKERS**',
    '`NO_BLOCKERS`',
    'NO_BLOCKERS.',
    'NO_BLOCKERS   \t',
    '## NO_BLOCKERS',
    '- **NO_BLOCKERS**',
    'Verdict: NO_BLOCKERS;',
    '_NO_BLOCKERS_',
  ];

  for (const finalLine of finalLines) {
    const detail = parseVerdictDetail(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: `The review is clean.\n\n${finalLine}\n  `,
    }));
    assert.equal(detail.verdict, 'NO_BLOCKERS', finalLine);
    assert.equal(detail.source, 'result', finalLine);
  }
});

test('a result token on a non-final line does not decide the verdict', () => {
  const detail = parseVerdictDetail(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'NO_BLOCKERS\n\nA blocking race remains in the retry path.',
  }));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
});

test('a plan line beginning with a formatted ISSUES token is conclusive', () => {
  const streamText = [
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Review saved to the plan.' }),
    JSON.stringify({
      type: 'tool_call', subtype: 'completed',
      tool_call: { createPlanToolCall: { args: {
        name: 'Review', overview: '',
        plan: '# Findings\n\n**ISSUES** — one blocking test bug; rest of the diff looks correct.',
      } } },
    }),
  ].join('\n');

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
});

test('the exact ISSUES/none prose line is not a plan verdict declaration', () => {
  const line = '- ISSUES/`none` vs real ISSUES: existing page test asserts distinct fail-safe vs reviewer';
  const detail = parseVerdictDetail(planArtifactStream(line));

  assert.equal(detail.verdict, 'ISSUES', 'an absent verdict must remain fail-safe');
  assert.equal(detail.source, 'none');
  assert.equal(detail.planText, line);
});

test('all observed genuine plan verdict lines remain conclusive', () => {
  const cases = [
    ['NO_BLOCKERS', 'NO_BLOCKERS'],
    ['**NO_BLOCKERS** — no correctness defects that block the requested change', 'NO_BLOCKERS'],
    ['**ISSUES** — one blocking test bug; rest of the diff looks correct', 'ISSUES'],
    ['**ISSUES** — journal campaign attribution is claimed closed but cannot work', 'ISSUES'],
  ];

  for (const [line, verdict] of cases) {
    const detail = parseVerdictDetail(planArtifactStream(line));
    assert.equal(detail.verdict, verdict, line);
    assert.equal(detail.source, 'plan', line);
    assert.equal(detail.planText, line, line);
  }
});

test('a plan artifact containing only prose mentions has no verdict source', () => {
  const detail = parseVerdictDetail(planArtifactStream([
    'The protocol distinguishes NO_BLOCKERS from ISSUES.',
    'ISSUES/none describes the fail-safe path.',
    'NO_BLOCKERS-leaning prose is not a declaration.',
  ].join('\n')));

  assert.equal(detail.verdict, 'ISSUES', 'an absent verdict must remain fail-safe');
  assert.equal(detail.source, 'none');
});

test('genuine conflicting plan verdict lines still resolve to ISSUES', () => {
  const detail = parseVerdictDetail(planArtifactStream([
    'NO_BLOCKERS — initial assessment',
    'ISSUES: one blocking defect remains',
  ].join('\n')));

  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
});

test('plan verdict tokens followed by sentence punctuation remain conclusive', () => {
  const lines = [
    'NO_BLOCKERS,no blocking defects found',
    'NO_BLOCKERS:no blocking defects found',
    'NO_BLOCKERS.',
    'NO_BLOCKERS—no blocking defects found',
  ];

  for (const line of lines) {
    const detail = parseVerdictDetail(planArtifactStream(line));
    assert.equal(detail.verdict, 'NO_BLOCKERS', line);
    assert.equal(detail.source, 'plan', line);
  }
});

test('both qualifying plan tokens resolve to ISSUES', () => {
  const streamText = JSON.stringify({
    type: 'tool_call', subtype: 'completed',
    tool_call: { createPlanToolCall: { args: {
      name: 'Ambiguous review', overview: '',
      plan: '**NO_BLOCKERS** — initial assessment.\n\nVerdict: ISSUES — blocking defect confirmed.',
    } } },
  });

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
});

test('an inconclusive synthetic stream remains fail-safe with no verdict source', () => {
  const detail = parseVerdictDetail(JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Review could not be completed.' }] },
  }));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
});

test('parseVerdict is fail-safe: an errored result yields ISSUES even if text contains NO_BLOCKERS', () => {
  const streamText = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'NO_BLOCKERS' }] } }),
    JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'NO_BLOCKERS' }),
  ].join('\n');
  assert.equal(parseVerdict(streamText), 'ISSUES');
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.source, 'none');
  assert.equal(detail.text, '', 'errored result must keep suppressing assistant text');
});

test('a conclusive result ISSUES is not overridden by a NO_BLOCKERS plan artifact', () => {
  const streamText = rewriteEvents(readFileSync(planSamplePath, 'utf8'), (event) => {
    const args = event.type === 'tool_call'
      ? event.tool_call?.createPlanToolCall?.args
      : null;
    if (args && typeof args.plan === 'string') args.plan = args.plan.replaceAll('ISSUES', 'NO_BLOCKERS');
    return event;
  });
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'result');
  assert.match(detail.planText, /NO_BLOCKERS$/);
});


test('a seat that dies mid-stream is UNVERIFIED, never ISSUES', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    extraArgv: [fakeAgent, 'quota-death'] });

  // Observed in production: Cursor emitted one assistant chunk, then exited 1
  // on usage exhaustion. That prose satisfied hasSubstantiveEvidence, so the
  // run recorded ISSUES — a review conclusion no reviewer reached — and a
  // billing outage was indistinguishable from a code problem.
  assert.equal(r.verdict, 'UNVERIFIED');
  assert.notEqual(r.verdict, 'ISSUES');
  assert.equal(r.verdictSource, 'none');
  assert.equal(r.launchFailed, true);
  assert.equal(r.verdictEvidence.termination.kind, 'exit');
  // The cause must survive: stderr is the only place the outage is legible.
  assert.match(r.stderr, /out of usage/);
});

test('narrowness control: a rendered verdict survives a non-zero exit', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    extraArgv: [fakeAgent, 'verdict-then-fail'] });

  // Termination must not swallow a verdict the seat actually reached, or the
  // fix above would turn every review into UNVERIFIED.
  assert.equal(r.verdict, 'ISSUES');
  assert.equal(r.verdictSource, 'result');
  assert.equal(r.launchFailed, false);
});

test('the reviewer sandbox flag is used only where Cursor supports it', () => {
  // Measured against the real binary on Windows:
  //   agent -p ... --sandbox enabled  -> Error: Sandbox mode is enabled but not
  //                                      available on this system.
  //   agent -p ... (no flag)          -> OK
  // Passing it unconditionally failed every reviewer-write pass on the primary
  // target, so the reviewer never wrote a single test.
  const on = (platform) => buildCursorReviewArgs({ platform, superpowersDir: null });

  assert.equal(on('win32').includes('--sandbox'), false,
    'Windows has no Cursor sandbox; requiring it disables the reviewer entirely');
  for (const platform of ['darwin', 'linux']) {
    const args = on(platform);
    assert.ok(args.includes('--sandbox'), `${platform} keeps the second layer`);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'enabled');
  }

  // Narrowness control: only that flag differs. Everything else that makes the
  // review pass work must survive on every platform.
  for (const platform of ['win32', 'darwin', 'linux']) {
    const args = on(platform);
    assert.ok(args.includes('--trust'), 'workspace trust is still cleared');
    assert.ok(args.includes('--plugin-dir'), 'the review skill is still supplied');
    assert.deepEqual(args.slice(0, 6),
      ['-p', REVIEW_PROMPT, '--output-format', 'stream-json', '--trust']
        .concat(platform === 'win32' ? ['--plugin-dir'] : ['--sandbox']));
    assert.equal(args.includes('--mode'), false, 'the review pass must stay writable');
  }
});
