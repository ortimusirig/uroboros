import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contextDigest,
  createSharedContext,
  extendSharedContext,
  persistSharedContext,
  renderSharedContext,
  validateSharedContext,
} from '../src/shared-context.js';
import { archiveRunArtifacts, HARNESS_ARTIFACTS } from '../src/artifacts.js';

function requirement(overrides = {}) {
  return {
    id: 'request',
    kind: 'requirement',
    content: 'Preserve offline use',
    provenance: { source: 'user', id: 'brief-1' },
    sourceIdentity: 'brief-1',
    status: 'required',
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return createSharedContext({
    projectId: 'p1',
    runId: 'r1',
    unitId: 'u1',
    phase: 'planning',
    sourceRevision: 'base',
    entries: [requirement()],
    ...overrides,
  });
}

test('audit growth preserves grounding while cross-project use fails', () => {
  const value = snapshot();
  assert.match(renderSharedContext({ snapshot: value }), /Preserve offline use/);
  assert.equal(validateSharedContext({
    snapshot: { ...value, delivery: { attempted: 1 } },
    projectId: 'p1',
  }).digest, value.digest);
  assert.throws(() => validateSharedContext({ snapshot: value, projectId: 'other' }), /project/i);
});

test('material snapshot changes invalidate the old digest instead of inheriting its authority', () => {
  const value = snapshot();
  const tampered = {
    ...value,
    entries: [{ ...value.entries[0], content: 'Permit network access' }],
  };
  assert.throws(() => validateSharedContext({ snapshot: tampered, projectId: 'p1' }), /digest/i);
  assert.notEqual(contextDigest(tampered), value.digest);

  const extended = extendSharedContext({
    snapshot: value,
    phase: 'planning',
    sourceRevision: 'next',
    entries: [requirement({
      id: 'decision',
      kind: 'decision',
      content: 'Keep provider calls disabled',
      sourceIdentity: 'decision-1',
      provenance: { source: 'human', id: 'decision-1' },
      status: 'approved',
    })],
  });
  assert.equal(extended.parentDigest, value.digest);
  assert.notEqual(extended.digest, value.digest);
  assert.equal(value.entries.length, 1, 'extension must not mutate the caller snapshot');
});

test('duplicate entry ids and missing source identities are rejected', () => {
  assert.throws(() => snapshot({ entries: [requirement(), requirement()] }), /duplicate.*request/i);
  assert.throws(() => snapshot({
    entries: [requirement({ sourceIdentity: '' })],
  }), /source identity/i);
  assert.throws(() => snapshot({
    entries: [requirement({ provenance: undefined })],
  }), /provenance/i);
});

test('required credential redaction is visible as incomplete context without mutating input', () => {
  const entry = requirement({ content: 'Use Authorization: Bearer secret-session-token' });
  const value = snapshot({ entries: [entry] });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /secret-session-token/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.deepEqual(value.completeness, {
    complete: false,
    reasons: ['required context contained redacted sensitive material'],
  });
  assert.equal(entry.content, 'Use Authorization: Bearer secret-session-token');
});

test('snapshot persistence refuses an overwrite even when the bytes are identical', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uro-context-persist-'));
  try {
    const value = snapshot();
    const path = persistSharedContext({ directory, snapshot: value });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), value);
    assert.throws(() => persistSharedContext({ directory, snapshot: value }), /exists|immutable/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('snapshot persistence refuses a validly redigested traversal id', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uro-context-safe-id-'));
  try {
    const value = snapshot();
    const forged = { ...value, id: '../../escape' };
    forged.digest = contextDigest(forged);
    assert.throws(() => persistSharedContext({ directory, snapshot: forged }), /snapshot id/i);
    assert.equal(existsSync(join(directory, 'escape.json')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('__uro_context is excluded from project changes and retained recursively with run artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-context-retention-'));
  const run = join(root, 'run');
  const artifacts = join(root, 'artifacts');
  try {
    mkdirSync(join(run, '__uro_context', 'snapshots'), { recursive: true });
    writeFileSync(join(run, '__uro_context', 'snapshots', 'grounding.json'), '{"ok":true}\n');
    writeFileSync(join(run, 'TASK.md'), 'task\n');
    const facts = { runId: 'context-retention', outcome: 'review-ready' };
    const result = archiveRunArtifacts({
      dir: run,
      runId: facts.runId,
      facts,
      scratchRoot: root,
      artifactRoot: artifacts,
      startedAt: new Date(0),
      endedAt: new Date(1),
    });
    assert.ok(HARNESS_ARTIFACTS.includes('__uro_context/'));
    assert.equal(result.status, 'ok');
    assert.equal(existsSync(join(
      artifacts, facts.runId, '__uro_context', 'snapshots', 'grounding.json',
    )), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
