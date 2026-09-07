import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProjectMemory, resolveProjectIdentity } from '../src/project-memory.js';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repository() {
  const base = mkdtempSync(join(tmpdir(), 'uro-project-'));
  const target = join(base, 'target');
  mkdirSync(target);
  git(target, 'init', '-q');
  git(target, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(target, 'README.txt'), 'baseline\n');
  git(target, 'add', '.');
  git(target, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'baseline');
  return { base, target, artifactRoot: join(base, 'artifacts') };
}

function memoryEntry(overrides = {}) {
  return {
    id: 'decision-1',
    kind: 'decision',
    content: 'Keep offline operation',
    provenance: { source: 'user', id: 'brief-1' },
    sourceIdentity: 'brief-1',
    status: 'approved',
    tags: ['Offline', 'Safety'],
    ...overrides,
  };
}

test('linked worktrees share verified project identity while a separate clone does not', () => {
  const { base, target } = repository();
  const linked = join(base, 'linked');
  const clone = join(base, 'clone');
  try {
    git(target, 'worktree', 'add', '-q', '-b', 'linked-linked', linked);
    execFileSync('git', ['clone', '-q', target, clone]);
    const primary = resolveProjectIdentity({ target });
    const worktree = resolveProjectIdentity({ target: linked });
    const separate = resolveProjectIdentity({ target: clone });
    assert.equal(worktree.projectId, primary.projectId);
    assert.equal(worktree.repository, primary.repository);
    assert.notEqual(separate.projectId, primary.projectId);
    assert.notEqual(separate.repository, primary.repository);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('linked worktrees can append to one notebook without an invalid root rebind', () => {
  const { base, target, artifactRoot } = repository();
  const linked = join(base, 'linked-memory');
  try {
    git(target, 'worktree', 'add', '-q', '-b', 'linked-memory', linked);
    const primary = openProjectMemory({
      artifactRoot,
      project: resolveProjectIdentity({ target }),
    });
    primary.append({ entry: memoryEntry() });
    const coworker = openProjectMemory({
      artifactRoot,
      project: resolveProjectIdentity({ target: linked }),
    });
    coworker.append({ entry: memoryEntry({
      content: 'Keep attributed linked-worktree findings',
      provenance: { source: 'codex', id: 'message-3' },
      sourceIdentity: 'message-3',
      status: 'proposed',
    }) });
    assert.deepEqual(primary.list().map(({ version }) => version), [1, 2]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('non-Git identity uses the canonical target and never a supplied remote URL', () => {
  const base = mkdtempSync(join(tmpdir(), 'uro-memory-nongit-'));
  try {
    const first = resolveProjectIdentity({ target: base, remoteUrl: 'https://example.test/a.git' });
    const second = resolveProjectIdentity({ target: base, remoteUrl: 'https://example.test/b.git' });
    assert.equal(first.projectId, second.projectId);
    assert.equal(first.repository, null);
    assert.equal(first.root, second.root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the notebook refuses a caller-forged project identity before creating records', () => {
  const { base, target, artifactRoot } = repository();
  try {
    const actual = resolveProjectIdentity({ target });
    const forged = { ...actual, projectId: '0'.repeat(64) };
    assert.throws(() => openProjectMemory({ artifactRoot, project: forged }), /verified|identity/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the notebook rejects caller ownership fields without poisoning later records', () => {
  const { base, target, artifactRoot } = repository();
  try {
    const memory = openProjectMemory({ artifactRoot, project: resolveProjectIdentity({ target }) });
    for (const [field, value] of [['schemaVersion', 999], ['projectId', 'other-project']]) {
      assert.throws(() => memory.append({
        entry: memoryEntry({ [field]: value }),
      }), new RegExp(`reserved|${field}`, 'i'));
    }
    memory.append({ entry: memoryEntry() });
    assert.deepEqual(memory.list().map(({ id, version }) => ({ id, version })), [
      { id: 'decision-1', version: 1 },
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('project listing and text/tag search are deterministic and preserve caller objects', () => {
  const { base, target, artifactRoot } = repository();
  try {
    const memory = openProjectMemory({ artifactRoot, project: resolveProjectIdentity({ target }) });
    const second = memoryEntry({ id: 'z-last', content: 'Use SQLite cache', tags: ['Cache'] });
    const first = memoryEntry({ id: 'a-first', content: 'Keep offline cache', tags: ['Offline', 'Cache'] });
    memory.append({ entry: second });
    memory.append({ entry: first });
    assert.deepEqual(memory.list().map(({ id }) => id), ['a-first', 'z-last']);
    assert.deepEqual(memory.search({ text: 'cache', tags: ['offline'] }).map(({ id }) => id), ['a-first']);
    assert.deepEqual(first, memoryEntry({ id: 'a-first', content: 'Keep offline cache', tags: ['Offline', 'Cache'] }));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('conflicting entry versions retain separate attribution instead of overwriting history', () => {
  const { base, target, artifactRoot } = repository();
  try {
    const memory = openProjectMemory({ artifactRoot, project: resolveProjectIdentity({ target }) });
    memory.append({ entry: memoryEntry() });
    memory.append({ entry: memoryEntry({
      content: 'Permit online fallback',
      provenance: { source: 'reviewer', id: 'review-7' },
      sourceIdentity: 'review-7',
      status: 'disputed',
    }) });
    const versions = memory.list();
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map(({ version }) => version), [1, 2]);
    assert.deepEqual(versions.map(({ sourceIdentity }) => sourceIdentity), ['brief-1', 'review-7']);
    assert.deepEqual(versions.map(({ status }) => status), ['approved', 'disputed']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a live project lock is refused and never removed by another owner', () => {
  const { base, target, artifactRoot } = repository();
  try {
    const memory = openProjectMemory({ artifactRoot, project: resolveProjectIdentity({ target }) });
    mkdirSync(memory.directory, { recursive: true });
    const lockPath = join(memory.directory, 'memory.lock');
    writeFileSync(lockPath, JSON.stringify({ ownerToken: 'other-owner', pid: process.pid }));
    assert.throws(() => memory.append({ entry: memoryEntry() }), /lock|owner|writer/i);
    assert.equal(existsSync(lockPath), true, 'a competing live owner keeps its lock');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('project lock is released after each write and sequential writers cannot lose versions', () => {
  const { base, target, artifactRoot } = repository();
  try {
    const project = resolveProjectIdentity({ target });
    const firstWriter = openProjectMemory({ artifactRoot, project });
    const secondWriter = openProjectMemory({ artifactRoot, project });
    firstWriter.append({ entry: memoryEntry() });
    assert.equal(existsSync(join(firstWriter.directory, 'memory.lock')), false);
    secondWriter.append({ entry: memoryEntry({
      content: 'Use a local immutable cache',
      provenance: { source: 'claude', id: 'message-2' },
      sourceIdentity: 'message-2',
      status: 'proposed',
    }) });
    assert.deepEqual(firstWriter.list().map(({ version }) => version), [1, 2]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('corrupt records fail visibly and an optional search outage visibly falls back to records', () => {
  const { base, target, artifactRoot } = repository();
  try {
    const project = resolveProjectIdentity({ target });
    const memory = openProjectMemory({
      artifactRoot,
      project,
      searchIndex() { throw new Error('index unavailable'); },
    });
    memory.append({ entry: memoryEntry() });
    const fallback = memory.search({ text: 'offline', tags: [] });
    assert.deepEqual(fallback.map(({ id }) => id), ['decision-1']);
    assert.equal(fallback.searchStatus, 'fallback');
    assert.match(fallback.searchError, /index unavailable/);

    const versionsDirectory = join(memory.directory, 'entries');
    const [record] = readdirSync(versionsDirectory);
    writeFileSync(join(versionsDirectory, record), '{not-json');
    assert.throws(() => memory.list(), /corrupt/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
