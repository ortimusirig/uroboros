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

test('bounded credential grammar redacts required context without mutating input', () => {
  const cases = [
    ['authorization = "Bearer synthetic-bare-value"', 'synthetic-bare-value'],
    ["headers.authorization='Bearer synthetic-dot-value'", 'synthetic-dot-value'],
    ["headers [ \"authorization\" ] = 'Bearer synthetic-bracket-double-value'", 'synthetic-bracket-double-value'],
    ['headers[\'authorization\']="Bearer synthetic-bracket-single-value"', 'synthetic-bracket-single-value'],
    ['{"authorization" : "Bearer synthetic-json-value"}', 'synthetic-json-value'],
  ];

  for (const [content, credential] of cases) {
    const entry = requirement({ content });
    const value = snapshot({ entries: [entry] });
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes(credential), false, content);
    assert.match(serialized, /\[REDACTED\]/);
    assert.equal(value.completeness.complete, false);
    assert.equal(entry.content, content);
  }
});

test('supported token prefix shapes are redacted from required context', () => {
  const cases = [
    ['Use sk-syntheticprefix123', 'sk-syntheticprefix123'],
    ['Use ghp_syntheticprefix123', 'ghp_syntheticprefix123'],
    ['Use github_pat_syntheticprefix123', 'github_pat_syntheticprefix123'],
  ];

  for (const [content, credential] of cases) {
    const entry = requirement({ content });
    const value = snapshot({ entries: [entry] });
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes(credential), false, content);
    assert.match(serialized, /\[REDACTED\]/);
    assert.equal(value.completeness.complete, false);
    assert.equal(entry.content, content);
  }
});

test('a Bearer credential value outside assignment syntax is redacted as incomplete context', () => {
  const content = 'headers.set("Authorization", "Bearer syntheticmethodvalue123")';
  const entry = requirement({ content });
  const value = snapshot({ entries: [entry] });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /syntheticmethodvalue123/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(value.completeness.complete, false);
  assert.equal(entry.content, content);
});

test('benign credential-like context remains complete', () => {
  const contents = [
    'authorizationPolicy = "Bearer is one documented scheme"',
    'authorization fields require review',
    'The short example is sk-short',
    'The identifier is github_pattern',
  ];

  for (const content of contents) {
    const entry = requirement({ content });
    const value = snapshot({ entries: [entry] });
    assert.equal(value.completeness.complete, true, content);
    assert.equal(value.entries[0].content, content);
    assert.doesNotMatch(JSON.stringify(value), /\[REDACTED\]/);
    assert.equal(entry.content, content);
  }
});

test('every required material collection propagates incomplete context', () => {
  const incompleteEvidence = snapshot({
    evidence: [{
      id: 'brief-evidence',
      kind: 'requirement',
      sourceIdentity: 'brief-2',
      required: true,
      contextIncomplete: true,
    }],
  });
  assert.equal(incompleteEvidence.completeness.complete, false);
  assert.match(incompleteEvidence.completeness.reasons.join('\n'), /evidence.*incomplete/i);

  const redactedEvidence = snapshot({
    evidence: [{
      id: 'secret-evidence',
      kind: 'requirement',
      sourceIdentity: 'brief-3',
      required: true,
      text: 'Use password=hunter2',
    }],
  });
  assert.equal(redactedEvidence.completeness.complete, false);
  assert.doesNotMatch(JSON.stringify(redactedEvidence), /hunter2/);

  const redactedRecall = snapshot({
    recalled: [requirement({
      id: 'recalled-required',
      sourceIdentity: 'prior-1',
      provenance: { source: 'prior-run', id: 'prior-1' },
      content: 'Use Authorization: Bearer old-secret',
    })],
  });
  assert.equal(redactedRecall.completeness.complete, false);
  assert.doesNotMatch(JSON.stringify(redactedRecall), /old-secret/);
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
