import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDialogueJournal } from '../src/dialogue-journal.js';
import { archiveRunArtifacts, HARNESS_ARTIFACTS } from '../src/artifacts.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'uro-dialogue-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, runId: 'r1', projectId: 'p1' };
}
const intent = { operationId: 'op1', seat: 'codex', input: 'all context', contextDigest: 'c1',
  artifactDigest: 'a1', evidenceIds: [], unreadMessageIds: [], effect: 'provider' };

test('journal retains exact completed outcome and accounts failed and unknown launches', (t) => {
  const options = fixture(t), journal = openDialogueJournal(options);
  assert.ok(journal, 'durable journal is available');
  journal.prepare(intent);
  journal.complete({ operationId: 'op1', result: { content: 'answer' }, usage: null, delivery: { input: 'all context' } });
  journal.prepare({ ...intent, operationId: 'op2', effect: 'repair' });
  journal.complete({ operationId: 'op2', result: { error: 'transport failed' }, usage: { inputTokens: 3, outputTokens: 2 }, delivery: null });
  assert.equal(journal.account().providerLaunches, 2);
  assert.equal(journal.account().repairLaunches, 1);
  assert.equal(journal.account().failedLaunches, 1);
  assert.equal(journal.account().usageUnknown, true);
  assert.deepEqual(journal.account().knownUsage, { inputTokens: 3, outputTokens: 2 });
  journal.close();
  const resumed = openDialogueJournal(options);
  assert.equal(resumed.operation('op1').status, 'completed');
  assert.equal(resumed.operation('op1').result.content, 'answer');
  assert.equal(resumed.prepare(intent).status, 'completed');
  assert.equal(resumed.account().providerLaunches, 2);
  resumed.close();
});

test('a recovered prepared effect is uncertain and cannot be prepared again', (t) => {
  const options = fixture(t), first = openDialogueJournal(options);
  first.prepare(intent);
  first.close();
  const resumed = openDialogueJournal(options);
  assert.equal(resumed.operation('op1').status, 'uncertain');
  assert.throws(() => resumed.prepare(intent), /uncertain/);
  assert.throws(() => resumed.complete({ operationId: 'missing', result: {} }), /unknown/);
  resumed.close();
});

test('journal rejects ownership conflict and close never removes another owner lock', (t) => {
  const options = fixture(t), journal = openDialogueJournal(options);
  assert.throws(() => openDialogueJournal(options), /owner|lock/);
  const lock = join(options.directory, '__uro_dialogue', 'controller.lock');
  writeFileSync(lock, 'another owner');
  assert.throws(() => journal.append({ type: 'state', state: {} }), /owner|lock/);
  journal.close();
  assert.equal(readFileSync(lock, 'utf8'), 'another owner');
});

for (const corruption of ['delivery', 'truncate', 'reorder', 'blank']) {
  test(`journal fails closed on ${corruption} corruption`, (t) => {
    const options = fixture(t), journal = openDialogueJournal(options);
    journal.prepare(intent);
    journal.complete({ operationId: 'op1', result: {}, usage: null, delivery: { observed: 'original' } });
    journal.close();
    const file = join(options.directory, '__uro_dialogue', 'journal.jsonl');
    const bytes = readFileSync(file, 'utf8');
    const lines = bytes.trimEnd().split('\n');
    const damaged = corruption === 'delivery' ? bytes.replace('original', 'tampered')
      : corruption === 'truncate' ? bytes.slice(0, -1)
        : corruption === 'reorder' ? `${lines.reverse().join('\n')}\n` : `${bytes}\n`;
    writeFileSync(file, damaged);
    assert.throws(() => openDialogueJournal(options), /journal|sequence|hash|line|truncat/);
  });
}

test('journal checks on-disk damage again before appending a new effect', (t) => {
  const options = fixture(t), journal = openDialogueJournal(options);
  journal.append({ type: 'state', state: { artifactDigest: 'a1' } });
  const file = join(options.directory, '__uro_dialogue', 'journal.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replace('a1', 'a2'));
  assert.throws(() => journal.prepare(intent), /hash|journal/);
  journal.close();
});

test('removing an active journal cannot silently restart its sequence', (t) => {
  const options = fixture(t), journal = openDialogueJournal(options);
  journal.append({ type: 'state', state: { artifactDigest: 'a1' } });
  rmSync(join(options.directory, '__uro_dialogue', 'journal.jsonl'));
  assert.throws(() => journal.prepare(intent), /journal|missing|removed/);
  journal.close();
});

function recordCompletedLaunch(journal) {
  journal.append({ type: 'state', state: { artifactDigest: 'a1' } });
  journal.prepare(intent);
  journal.complete({ operationId: 'op1', result: { content: 'already ran' }, usage: { inputTokens: 10, outputTokens: 5 }, delivery: { status: 'submitted' } });
  assert.equal(journal.account().providerLaunches, 1);
  assert.deepEqual(journal.account().knownUsage, { inputTokens: 10, outputTokens: 5 });
}

test('whole-record journal suffix deletion cannot erase active operations or accounting', (t) => {
  const options = fixture(t), journal = openDialogueJournal(options);
  recordCompletedLaunch(journal);
  const file = join(options.directory, '__uro_dialogue', 'journal.jsonl');
  writeFileSync(file, `${readFileSync(file, 'utf8').split('\n')[0]}\n`);
  assert.throws(() => journal.account(), /tail|rollback/);
  assert.throws(() => journal.operation('op1'), /tail|rollback/);
  assert.throws(() => journal.prepare({ ...intent, operationId: 'op2' }), /tail|rollback/);
  journal.close();
});

test('recovery rejects a shortened complete journal against the durable accepted tail', (t) => {
  const options = fixture(t), journal = openDialogueJournal(options);
  recordCompletedLaunch(journal);
  journal.close();
  const file = join(options.directory, '__uro_dialogue', 'journal.jsonl');
  writeFileSync(file, `${readFileSync(file, 'utf8').split('\n')[0]}\n`);
  assert.throws(() => openDialogueJournal(options), /tail|rollback/);
});

test('the active accepted tail rejects coordinated rollback of both durable streams', (t) => {
  const options = fixture(t), journal = openDialogueJournal(options);
  recordCompletedLaunch(journal);
  for (const name of ['journal.jsonl', 'journal-tail.jsonl']) {
    const file = join(options.directory, '__uro_dialogue', name);
    if (existsSync(file)) writeFileSync(file, `${readFileSync(file, 'utf8').split('\n')[0]}\n`);
  }
  assert.throws(() => journal.append({ type: 'state', state: {} }), /tail|rollback/);
  journal.close();
});

test('recovery requires the durable tail when a journal already exists', (t) => {
  const options = fixture(t), journal = openDialogueJournal(options);
  recordCompletedLaunch(journal);
  journal.close();
  const tail = join(options.directory, '__uro_dialogue', 'journal-tail.jsonl');
  if (existsSync(tail)) rmSync(tail);
  assert.throws(() => openDialogueJournal(options), /tail|missing/);
});

test('a durable tail ahead of an interrupted journal append cannot authorize recovery', (t) => {
  const options = fixture(t), journal = openDialogueJournal(options);
  journal.append({ type: 'state', state: { artifactDigest: 'a1' } });
  journal.close();
  const tail = join(options.directory, '__uro_dialogue', 'journal-tail.jsonl');
  const original = readFileSync(tail, 'utf8');
  writeFileSync(tail, `${original}${JSON.stringify({ schemaVersion: 1, runId: 'r1', projectId: 'p1', sequence: 2, hash: 'f'.repeat(64) })}\n`);
  assert.throws(() => openDialogueJournal(options), /tail|interrupted/);
});

test('journal refuses a redirected sidecar directory before writing outside its run', (t) => {
  const options = fixture(t), outside = join(options.directory, 'outside'), run = join(options.directory, 'run');
  mkdirSync(outside); mkdirSync(run);
  symlinkSync(outside, join(run, '__uro_dialogue'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => openDialogueJournal({ ...options, directory: run }), /symbolic|scope|redirect/);
  assert.equal(existsSync(join(outside, 'controller.lock')), false);
});

test('dialogue sidecars are excluded harness artifacts and retained byte for byte', (t) => {
  const { directory } = fixture(t), worktree = join(directory, 'worktree');
  mkdirSync(worktree);
  const journal = openDialogueJournal({ directory: worktree, runId: 'r1', projectId: 'p1' });
  journal.append({ type: 'state', state: { artifactDigest: 'a1' } });
  journal.close();
  assert.ok(HARNESS_ARTIFACTS.includes('__uro_dialogue/'));
  const archived = archiveRunArtifacts({ dir: worktree, runId: 'r1', facts: { runId: 'r1', tokens: {} },
    scratchRoot: directory, artifactRoot: join(directory, 'records'), startedAt: new Date(0), endedAt: new Date(1) });
  assert.equal(archived.status, 'ok');
  assert.deepEqual(readFileSync(join(directory, 'records', 'r1', '__uro_dialogue', 'journal.jsonl')),
    readFileSync(join(worktree, '__uro_dialogue', 'journal.jsonl')));
  assert.deepEqual(readFileSync(join(directory, 'records', 'r1', '__uro_dialogue', 'journal-tail.jsonl')),
    readFileSync(join(worktree, '__uro_dialogue', 'journal-tail.jsonl')));
});
