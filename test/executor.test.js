import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodexArgs,
  DEFAULT_EXECUTOR_EFFORT,
  DEFAULT_EXECUTOR_MODEL,
  EXECUTOR_PREAMBLE,
  runExecutor,
  parseCodexStream,
} from '../src/executor.js';
import { decodeRecordedText } from '../src/execution-record.js';
import {
  addUsage,
  checkUsageConsistency,
  EMPTY_USAGE,
  normalizeCodexUsage,
  normalizeCursorUsage,
} from '../src/usage.js';

const fakeCodex = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
const schemaSamplePath = fileURLToPath(new URL('../fixtures/codex-stream-schema-sample.ndjson', import.meta.url));
const usageSamplePath = fileURLToPath(new URL('../fixtures/codex-exec-usage-sample.ndjson', import.meta.url));
const cursorPlanSamplePath = fileURLToPath(new URL('../fixtures/cursor-plan-mode-sample.ndjson', import.meta.url));

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => {};
  return child;
}

async function runFakeExecutorStream(lines) {
  const events = [];
  const script = `for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + "\\n")`;
  await runExecutor({
    plan: 'observe the supplied stream',
    cwd: tmpdir(),
    bin: process.execPath,
    extraArgv: ['-e', script],
    reporter: (event) => events.push(event),
    runId: 'recorded-stream',
    attempt: 1,
    timeoutMs: 5000,
  });
  return events;
}

test('buildCodexArgs pins model, effort, disables MCP, and defaults to workspace-write', async () => {
  // The pin belongs here, spelled out: a test that avoided the literal would stop being
  // able to detect a changed default, which is the only thing this line is for.
  assert.equal(DEFAULT_EXECUTOR_MODEL, 'gpt-5.6-sol');
  assert.equal(DEFAULT_EXECUTOR_EFFORT, 'xhigh');
  const hadSandboxOverride = Object.hasOwn(process.env, 'URO_CODEX_SANDBOX');
  const sandboxOverride = process.env.URO_CODEX_SANDBOX;
  delete process.env.URO_CODEX_SANDBOX;
  try {
    const isolatedModule = await import(`../src/executor.js?default-sandbox=${Date.now()}`);
    const a = isolatedModule.buildCodexArgs({ cwd: 'C:/w' }).join(' ');
    assert.match(a, /exec/);
    assert.match(a, /--json/);
    assert.match(a, new RegExp(`-m ${DEFAULT_EXECUTOR_MODEL.replaceAll('.', '\\.')}`));
    assert.match(a, new RegExp(`model_reasoning_effort=${DEFAULT_EXECUTOR_EFFORT}`));
    assert.match(a, /mcp_servers=\{\}/);
    assert.match(a, /-s workspace-write/, 'the confining mode stays the default');
    assert.doesNotMatch(a, /--ignore-user-config/, 'must never discard project trust');
  } finally {
    if (hadSandboxOverride) process.env.URO_CODEX_SANDBOX = sandboxOverride;
  }
});

test('buildCodexArgs allows an explicit sandbox override, for hosts where the Codex sandbox is broken', () => {
  const a = buildCodexArgs({ cwd: 'C:/w', sandbox: 'danger-full-access' }).join(' ');
  assert.match(a, /-s danger-full-access/);
  // The override must not quietly change anything else about the invocation.
  assert.match(a, new RegExp(`-m ${DEFAULT_EXECUTOR_MODEL.replaceAll('.', '\\.')}`));
  assert.match(a, /mcp_servers=\{\}/);
});

test('buildCodexArgs accepts explicit model and effort overrides', () => {
  const a = buildCodexArgs({ cwd: 'C:/w', model: 'executor-override', effort: 'medium' });
  assert.equal(a[a.indexOf('-m') + 1], 'executor-override');
  assert.ok(a.includes('model_reasoning_effort=medium'));
});

test('buildCodexArgs never passes --plugin-dir, which Codex rejects', () => {
  // Codex discovers plugins from its own config; it has no --plugin-dir flag and
  // exits 2 with "unexpected argument '--plugin-dir'". That flag belongs to the
  // Cursor CLI. Passing it here made every executor invocation fail, so the args
  // must stay free of it even when a superpowers directory resolves.
  const superpowersDir = mkdtempSync(join(tmpdir(), 'uro-codex-superpowers-'));
  try {
    const args = buildCodexArgs({
      cwd: 'C:/w', env: { URO_SUPERPOWERS_DIR: superpowersDir }, home: tmpdir(),
    });
    assert.ok(!args.includes('--plugin-dir'), 'Codex rejects --plugin-dir');
    assert.ok(!args.includes(superpowersDir), 'the resolved path is not an argument');
    assert.deepEqual(args, buildCodexArgs({ cwd: 'C:/w', superpowersDir: null }),
      'a resolved directory must not change the argument list');
  } finally {
    rmSync(superpowersDir, { recursive: true, force: true });
  }
});

test('buildCodexArgs without superpowers is byte-identical to the previous invocation', () => {
  assert.deepEqual(buildCodexArgs({
    cwd: 'C:/w', sandbox: 'workspace-write', superpowersDir: null,
  }), [
    'exec', '--json',
    '-m', DEFAULT_EXECUTOR_MODEL,
    '-c', `model_reasoning_effort=${DEFAULT_EXECUTOR_EFFORT}`,
    '-c', 'mcp_servers={}',
    '-s', 'workspace-write',
    '-C', 'C:/w',
    '-',
  ]);
});

test('executor preamble names the approved-work and decision protocol', () => {
  assert.match(EXECUTOR_PREAMBLE, /plan below is approved/i);
  assert.match(EXECUTOR_PREAMBLE, /implement it/i);
  assert.match(EXECUTOR_PREAMBLE, /no diff and no `?DECISION[.]md`?.*failed pass/is);
  assert.match(EXECUTOR_PREAMBLE, /## Q1[\s\S]*Kind: technical \| product \| authority/);
  assert.match(EXECUTOR_PREAMBLE, /Question:/);
  assert.match(EXECUTOR_PREAMBLE, /Options:/);
  assert.match(EXECUTOR_PREAMBLE, /Recommendation:/);
});

test('runExecutor launches Codex under the environment whose registry was verified', async () => {
  const env = { CODEX_HOME: 'C:/registered-codex-home' };
  const child = fakeChild();
  let spawnOptions;
  const pending = runExecutor({
    plan: 'observe the launch environment',
    cwd: tmpdir(),
    bin: process.execPath,
    env,
    spawnProcess: (_bin, _args, options) => { spawnOptions = options; return child; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('close', 0, null);
  await pending;

  assert.equal(spawnOptions.env.CODEX_HOME, env.CODEX_HOME);
  assert.equal(spawnOptions.env.PATH, process.env.PATH,
    'a registry override must not remove the PATH needed to launch Codex');
});

test('an owned-worktree caller opts in to the sandbox temp dir with ownedTmpDir', async () => {
  // Codex's workspace-write sandbox confines writes to the worktree. A tool that defaults
  // to writing under the OS temp dir (pytest's tmp under %TEMP%, observed in the field) then
  // fails every write with an ACL error, because %TEMP% lives outside the sandboxed root.
  // The executor must give such tools a temp dir the sandbox actually allows — but only when
  // the caller owns `cwd` as a disposable, isolated worktree (run.js). Plan/decompose call
  // runExecutor directly against the operator's real, un-isolated target directory, so this
  // behavior must never fire unless the caller explicitly opts in.
  const dir = mkdtempSync(join(tmpdir(), 'ccc-executor-sandbox-tmp-'));
  try {
    const child = fakeChild();
    let spawnOptions;
    const pending = runExecutor({
      plan: 'observe the sandbox temp dir',
      cwd: dir,
      bin: process.execPath,
      ownedTmpDir: true,
      spawnProcess: (_bin, _args, options) => { spawnOptions = options; return child; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    await pending;

    const executorTmp = join(dir, '.uro-tmp');
    assert.equal(spawnOptions.env.TMP, executorTmp);
    assert.equal(spawnOptions.env.TEMP, executorTmp);
    assert.equal(spawnOptions.env.TMPDIR, executorTmp);
    assert.equal(existsSync(executorTmp), true, 'the sandbox temp dir must actually exist on disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without ownedTmpDir, runExecutor never mutates a caller-supplied directory', async () => {
  // The regression pin for the wave's law: the harness must never mutate a repository (or
  // any directory) it does not own. plan.js and decompose.js pass the operator's real target
  // as `cwd` directly — no isolation, no worktree copy — and their own prompts say "do not
  // modify any file." ownedTmpDir defaults to false, so this must be a true no-op: no
  // directory created, no TMP/TEMP/TMPDIR override, whatever the caller's env already was.
  const dir = mkdtempSync(join(tmpdir(), 'ccc-executor-unowned-'));
  try {
    const child = fakeChild();
    let spawnOptions;
    const pending = runExecutor({
      plan: 'observe an unowned directory',
      cwd: dir,
      bin: process.execPath,
      spawnProcess: (_bin, _args, options) => { spawnOptions = options; return child; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    await pending;

    assert.equal(spawnOptions.env.TMP, process.env.TMP,
      'TMP must pass through unchanged when the caller does not own cwd');
    assert.equal(spawnOptions.env.TEMP, process.env.TEMP,
      'TEMP must pass through unchanged when the caller does not own cwd');
    assert.equal(spawnOptions.env.TMPDIR, process.env.TMPDIR,
      'TMPDIR must pass through unchanged when the caller does not own cwd');
    assert.equal(existsSync(join(dir, '.uro-tmp')), false,
      'the harness must not create anything inside a directory it does not own');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runExecutor parses file_change and agent_message from the stream', async () => {
  const r = await runExecutor({ plan: 'do the thing', cwd: tmpdir(),
    bin: process.execPath, extraArgv: [fakeCodex] });
  assert.deepEqual(r.changedFiles, ['a.py', 'b.py']);
  assert.equal(r.lastMessage, 'implemented the thing');
});

test('runExecutor reports a completed item before the vendor process exits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ccc-executor-incremental-'));
  const exitMarker = join(directory, 'vendor-exited.txt');
  const events = [];
  const script = [
    'const { writeFileSync } = require("node:fs")',
    `const marker = ${JSON.stringify(exitMarker)}`,
    'const changed = {type:"item.completed",item:{type:"file_change",changes:[{path:"early.js"}]}}',
    'process.stdout.write(JSON.stringify(changed) + "\\n")',
    'setTimeout(() => { writeFileSync(marker, "exited") }, 300)',
  ].join(';');
  try {
    const result = await runExecutor({
      plan: 'observe incrementally', cwd: directory,
      bin: process.execPath, extraArgv: ['-e', script],
      reporter: (event) => events.push({
        event,
        vendorHadExited: existsSync(exitMarker),
      }),
      runId: 'incremental-order', attempt: 1, timeoutMs: 5000,
    });
    assert.deepEqual(result.changedFiles, ['early.js']);
    const fileChange = events.find(({ event }) => event.type === 'file_change');
    assert.ok(fileChange, 'positive setup: the fixture must produce a file-change event');
    assert.equal(fileChange.vendorHadExited, false,
      'the item must reach the reporter while the process is still alive');
    assert.equal(existsSync(exitMarker), true,
      'positive control: the process must write its exit marker before runExecutor returns');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a command_execution item records its command line and exit code', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: {
      id: '1', type: 'command_execution',
      command: 'node --test', aggregated_output: 'ok\n', exit_code: 0, status: 'completed',
    } },
  ]);
  const recorded = events.find((event) => event.itemType === 'command_execution');
  assert.equal(recorded.command, 'node --test');
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.output, 'ok\n');
  assert.equal(recorded.outputEncoding, 'plain');
});

test('a non-zero exit code is recorded', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: {
      id: '2', type: 'command_execution',
      command: 'node --test', aggregated_output: 'fail\n', exit_code: 1, status: 'completed',
    } },
  ]);
  assert.equal(events.find((event) => event.itemType === 'command_execution').exitCode, 1);
});

test('an error item records its message', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: { id: '3', type: 'error', message: 'rate limited' } },
  ]);
  assert.equal(events.find((event) => event.itemType === 'error').errorMessage, 'rate limited');
});

test('an agent_message item records its text', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: { id: '4', type: 'agent_message', text: 'done' } },
  ]);
  const recorded = events.find((event) => event.itemType === 'agent_message');
  assert.equal(recorded.text, 'done');
  assert.equal(recorded.textEncoding, 'plain');
});

test('large command output is stored compressed', async () => {
  const big = 'y'.repeat(5000);
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: {
      id: '5', type: 'command_execution',
      command: 'noisy', aggregated_output: big, exit_code: 0, status: 'completed',
    } },
  ]);
  const recorded = events.find((event) => event.itemType === 'command_execution');
  assert.equal(recorded.outputEncoding, 'br+b64');
  assert.equal(decodeRecordedText({
    text: recorded.output,
    encoding: recorded.outputEncoding,
    truncated: recorded.outputTruncated,
  }).text, big);
});

test('file_change events still report their path unchanged', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: {
      id: '6', type: 'file_change', status: 'completed',
      changes: [{ path: 'src/a.js', kind: 'modify' }],
    } },
  ]);
  assert.ok(events.some((event) => event.file === 'src/a.js'));
});

test('a mutation pin sequence is reconstructible in order', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: { id: '7', type: 'file_change', status: 'completed',
      changes: [{ path: 'src/target.js', kind: 'modify' }] } },
    { type: 'item.completed', item: { id: '8', type: 'command_execution',
      command: 'node --test', aggregated_output: 'fail', exit_code: 1, status: 'completed' } },
    { type: 'item.completed', item: { id: '9', type: 'file_change', status: 'completed',
      changes: [{ path: 'src/target.js', kind: 'modify' }] } },
    { type: 'item.completed', item: { id: '10', type: 'command_execution',
      command: 'node --test', aggregated_output: 'pass', exit_code: 0, status: 'completed' } },
  ]);
  const shape = events
    .filter((event) => event.file !== undefined || event.exitCode !== undefined)
    .map((event) => (event.file !== undefined ? `file:${event.file}` : `exit:${event.exitCode}`));
  assert.deepEqual(shape, ['file:src/target.js', 'exit:1', 'file:src/target.js', 'exit:0']);
});

test('an executor finish event carries no tokens field when the real stream reported none', async () => {
  const events = await runFakeExecutorStream([
    { type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'done' } },
  ]);
  const finish = events.find((event) => event.stage === 'executor' && event.type === 'finish');
  assert.ok(finish, 'a finish event must still be reported');
  assert.equal(Object.hasOwn(finish, 'tokens'), false,
    'no usage line ever arrived on the real stream, so the event must not claim a zero');
});

test('an executor finish event carries a genuine zero tokens field when the real stream reported one', async () => {
  const events = await runFakeExecutorStream([
    { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } },
    { type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'done' } },
  ]);
  const finish = events.find((event) => event.stage === 'executor' && event.type === 'finish');
  assert.deepEqual(finish.tokens, EMPTY_USAGE);
});

test('parseCodexStream handles the real wrapped item.completed schema, ignores errors and item.started', () => {
  const sample = readFileSync(schemaSamplePath, 'utf8');
  const r = parseCodexStream(sample);
  assert.deepEqual(r.changedFiles, ['ok.txt']);
  assert.equal(r.lastMessage, 'Created ok.txt.');
  assert.deepEqual(r.agentMessages, ['Created ok.txt.']);
  // This real stream's only turn.completed line carries no usage field at all
  // ({"type":"turn.completed"}) — nothing was ever accounted, so this must be
  // null, never a fake EMPTY_USAGE zero.
  assert.equal(r.usage, null);
});

test('parseCodexStream reports a genuinely zero usage as accounted, not absent', () => {
  const zeroUsage = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  assert.deepEqual(parseCodexStream(zeroUsage).usage, EMPTY_USAGE);
});

test('normalizeCodexUsage maps the real Codex usage object', () => {
  const stream = readFileSync(usageSamplePath, 'utf8');
  const raw = stream.trim().split(/\r?\n/).map(JSON.parse).at(-1).usage;
  const normalized = normalizeCodexUsage(raw);
  assert.deepEqual(normalized, {
    inputTokens: 31116,
    cachedInputTokens: 26112,
    outputTokens: 96,
    reasoningOutputTokens: 45,
    cacheWriteTokens: 0,
  });
  assert.equal(checkUsageConsistency(normalized).status, 'consistent');
});

test('normalizeCursorUsage maps the real Cursor usage object', () => {
  const stream = readFileSync(cursorPlanSamplePath, 'utf8');
  const raw = stream.trim().split(/\r?\n/).map(JSON.parse).find((event) => event.type === 'result').usage;
  const normalized = normalizeCursorUsage(raw);
  assert.deepEqual(normalized, {
    inputTokens: 58639,
    cachedInputTokens: 38528,
    outputTokens: 1184,
    reasoningOutputTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.ok(normalized.cachedInputTokens <= normalized.inputTokens,
    'the canonical cached portion must not exceed inclusive total input');
  assert.equal(checkUsageConsistency(normalized).status, 'consistent');
});

test('usage normalizers return null for a missing usage object, never a fake zero, but still sanitize invalid fields on a real one', () => {
  for (const raw of [undefined, null, 'garbage', 42, [], () => {}]) {
    assert.equal(normalizeCodexUsage(raw), null,
      'nothing shaped like a usage object arrived, so nothing was accounted');
    assert.equal(normalizeCursorUsage(raw), null);
  }
  // A genuine usage object with unusable field values is still a REPORTED
  // usage object — the seat did report; the fields just do not parse. That
  // stays a truthful (sanitized) zero, never null.
  assert.deepEqual(normalizeCodexUsage({ input_tokens: -1, output_tokens: '96' }), EMPTY_USAGE);
  assert.deepEqual(normalizeCursorUsage({ inputTokens: Number.NaN, cacheReadTokens: -2 }), EMPTY_USAGE);
  // A genuinely all-zero usage object is real accounting, not absence of it.
  assert.deepEqual(normalizeCodexUsage({ input_tokens: 0, output_tokens: 0 }), EMPTY_USAGE);
  assert.deepEqual(normalizeCursorUsage({ inputTokens: 0, outputTokens: 0 }), EMPTY_USAGE);
});

test('addUsage sums canonical fields without mutating either argument', () => {
  const a = { inputTokens: 10, cachedInputTokens: 7, outputTokens: 3,
    reasoningOutputTokens: 2, cacheWriteTokens: 1 };
  const b = { inputTokens: 4, cachedInputTokens: 5, outputTokens: 6,
    reasoningOutputTokens: 8, cacheWriteTokens: 9 };
  const beforeA = { ...a };
  const beforeB = { ...b };
  assert.deepEqual(addUsage(a, b), {
    inputTokens: 14,
    cachedInputTokens: 12,
    outputTokens: 9,
    reasoningOutputTokens: 10,
    cacheWriteTokens: 10,
  });
  assert.deepEqual(a, beforeA);
  assert.deepEqual(b, beforeB);
});

test('parseCodexStream retains real usage and ignores command_execution items', () => {
  const earlierUsage = JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 1, cached_input_tokens: 2, cache_write_input_tokens: 3,
      output_tokens: 4, reasoning_output_tokens: 5,
    },
  });
  const r = parseCodexStream(`${earlierUsage}\n${readFileSync(usageSamplePath, 'utf8')}`);
  assert.deepEqual(r.changedFiles, []);
  assert.equal(r.lastMessage, 'PROBEOK');
  assert.deepEqual(r.usage, {
    inputTokens: 31116,
    cachedInputTokens: 26112,
    outputTokens: 96,
    reasoningOutputTokens: 45,
    cacheWriteTokens: 0,
  });
});

test('a failed executor keeps its stderr, the only account of why it died', async () => {
  const r = await runExecutor({ plan: 'x', cwd: tmpdir(),
    bin: process.execPath, extraArgv: [fakeCodex, 'die-quietly'] });

  // Observed in production: exit 1, no diff, no usage, and nothing anywhere in
  // the run facts saying what happened. stdout carried no explanation because
  // the stream simply stopped.
  assert.equal(r.exitCode, 1);
  // The cause is the LAST thing written, behind 400 lines of tool-router noise.
  // Keeping the head of stderr fills the whole limit with that noise and
  // truncates the cause away, which is exactly what the first fix did.
  assert.match(r.stderr, /upstream connection reset/);
  assert.doesNotMatch(r.stderr, /noisy tool listing line 0/);
});

test('a successful executor carries no stderr noise', async () => {
  const r = await runExecutor({ plan: 'x', cwd: tmpdir(),
    bin: process.execPath, extraArgv: [fakeCodex] });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, undefined);
});
