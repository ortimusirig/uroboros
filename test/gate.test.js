import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATE_TAIL_LIMIT, runGate } from '../src/gate.js';
import { testCountFloorCommand, TEST_COUNT_FLOOR_BIN } from '../src/merge.js';
import { createEvidenceWriter } from '../src/evidence.js';

const ok = { bin: process.execPath, args: ['-e', 'process.exit(0)'] };
const bad = { bin: process.execPath, args: ['-e', 'process.exit(1)'] };

for (const asynchronous of [false, true]) test(`required ${asynchronous ? 'async' : 'sync'} evidence failure prevents the next real command`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-required-'));
  const counter = join(cwd, 'counter');
  try {
    const next = { bin: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("counter", "1")'] };
    const fail = () => { throw new Error('capture unavailable'); };
    await assert.rejects(runGate({ commands: [ok, next], cwd, requiredEvidence: true,
      codeIdentity: () => 'actual-project-before-command', onEvidence: asynchronous ? async () => fail() : fail }), /capture unavailable/);
    assert.equal(existsSync(counter), false);
    await runGate({ commands: [ok, next], cwd, onEvidence: asynchronous ? async () => fail() : fail });
    assert.equal(readFileSync(counter, 'utf8'), '1', 'legacy best-effort capture still runs all commands');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('required command evidence captures actual argv, complete output and identity before each launch', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-observed-'));
  try {
    writeFileSync(join(cwd, 'source'), 'before');
    const commands = [{ bin: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("source", "after");process.stdout.write("x".repeat(6000));process.stderr.write("err")'] }, ok];
    const records = [];
    await runGate({ commands, cwd, requiredEvidence: true,
      codeIdentity: () => readFileSync(join(cwd, 'source'), 'utf8'), onEvidence: async record => records.push(record) });
    assert.deepEqual(records.map(record => record.codeIdentity), ['before', 'after']);
    assert.deepEqual(records[0].argv, [process.execPath, ...commands[0].args]);
    assert.equal(records[0].cwd, cwd);
    assert.equal(records[0].exitCode, 0);
    assert.equal(records[0].status, 'completed');
    assert.equal(records[0].stdout, 'x'.repeat(6000));
    assert.equal(records[0].stderr, 'err');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('required file sink failure stops later commands while preserving explicit legacy write errors', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-file-sink-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, '__uro_evidence'), 'This file prevents the evidence directory from being created.');
  const next = { bin: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("counter", "1")'] };
  await assert.rejects(runGate({ commands: [ok, next], cwd, requiredEvidence: true,
    codeIdentity: () => 'actual-code', onEvidence: createEvidenceWriter({ dir: cwd, required: true }).write }));
  assert.equal(existsSync(join(cwd, 'counter')), false);
  const legacy = createEvidenceWriter({ dir: cwd });
  await runGate({ commands: [ok, next], cwd, onEvidence: legacy.write });
  assert.equal(readFileSync(join(cwd, 'counter'), 'utf8'), '1');
  assert.equal(legacy.records().length, 2);
  assert.ok(legacy.records().every(record => record.writeError));
});

test('all-zero commands pass', async () => {
  const r = await runGate({ commands: [ok, ok], cwd: process.cwd() });
  assert.equal(r.passed, true);
  assert.equal(r.results.length, 2);
});

test('every command runs whatever the previous one exited', async () => {
  // Stopping at the first non-zero was verdict thinking: it hid the state of
  // every later command from the seats. Each result is independent evidence.
  const r = await runGate({ commands: [ok, bad, ok], cwd: process.cwd() });
  assert.equal(r.results.length, 3, 'no short-circuit — the record is complete');
  assert.deepEqual(r.results.map((result) => result.code), [0, 1, 0]);
});

test('only the failing command retains labelled tails from both stdout and stderr', async () => {
  const passing = {
    bin: process.execPath,
    args: ['-e', 'process.stdout.write("PASSING OUTPUT")'],
  };
  const failing = {
    bin: process.execPath,
    args: ['-e', 'process.stdout.write("STDOUT FAILURE DETAIL"); process.stderr.write("STDERR FAILURE DETAIL"); process.exit(7)'],
  };
  const r = await runGate({ commands: [passing, failing], cwd: process.cwd() });
  assert.equal(r.passed, false);
  assert.deepEqual(r.results[0], { ...passing, code: 0 });
  assert.equal(Object.hasOwn(r.results[0], 'outputTail'), false);
  assert.equal(r.results[1].code, 7);
  assert.match(r.results[1].outputTail, /stdout/i);
  assert.match(r.results[1].outputTail, /STDOUT FAILURE DETAIL/);
  assert.match(r.results[1].outputTail, /stderr/i);
  assert.match(r.results[1].outputTail, /STDERR FAILURE DETAIL/);
  assert.ok(r.results[1].outputTail.length <= GATE_TAIL_LIMIT);
});

test('failing output retention keeps stream endings rather than their heads', async () => {
  const failing = {
    bin: process.execPath,
    args: ['-e', [
      'process.stdout.write("STDOUT HEAD" + "o".repeat(5000) + "STDOUT TAIL")',
      'process.stderr.write("STDERR HEAD" + "e".repeat(5000) + "STDERR TAIL")',
      'process.exit(1)',
    ].join(';')],
  };
  const r = await runGate({ commands: [failing], cwd: process.cwd() });
  const tail = r.results[0].outputTail;
  assert.match(tail, /STDOUT TAIL/);
  assert.match(tail, /STDERR TAIL/);
  assert.doesNotMatch(tail, /STDOUT HEAD/);
  assert.doesNotMatch(tail, /STDERR HEAD/);
  assert.ok(tail.length <= GATE_TAIL_LIMIT);
});

test('an empty command list passes vacuously', async () => {
  const r = await runGate({ commands: [], cwd: process.cwd() });
  assert.equal(r.passed, true);
});

test('a derived test-count floor is enforced by its own exit code', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-count-'));
  const reportsSeven = {
    bin: process.execPath,
    args: ['-e', "process.stdout.write('ℹ tests 7\\n')"],
  };
  try {
    const r = await runGate({
      commands: [reportsSeven, testCountFloorCommand(8)],
      cwd,
    });
    assert.equal(r.testCount, 7);
    assert.equal(r.passed, false);
    assert.equal(r.results[1].harness, TEST_COUNT_FLOOR_BIN);
    assert.equal(r.results[1].code, 1);
    assert.match(r.results[1].outputTail, /actual=7 required=8/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a timed-out gate command fails with an explicit timeout marker', async () => {
  const slow = {
    bin: process.execPath,
    args: ['-e', 'process.stdout.write("gate started"); setTimeout(() => {}, 5000)'],
  };
  const r = await runGate({ commands: [slow], cwd: process.cwd(), timeoutMs: 300 });
  assert.equal(r.passed, false);
  assert.equal(r.results[0].timedOut, true);
  assert.equal(r.results[0].timeoutMs, 300);
  assert.notEqual(r.results[0].code, 0);
  assert.match(r.results[0].outputTail, /gate started/);
});
