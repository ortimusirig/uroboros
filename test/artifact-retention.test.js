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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  archiveRunArtifacts,
  resolveArtifactRoot,
} from '../src/artifacts.js';

const TEST_ROOT = fileURLToPath(new URL('../.ccc-test-artifacts/', import.meta.url));

function temporaryDirectory(prefix) {
  mkdirSync(TEST_ROOT, { recursive: true });
  return mkdtempSync(join(TEST_ROOT, prefix));
}

function writeProducedArtifacts(directory, { diff = true } = {}) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'TASK.md'), 'implement the approved plan\n');
  writeFileSync(join(directory, 'events.jsonl'), [
    '{"ts":"2026-08-29T01:02:03.004Z","stage":"isolate","type":"start"}',
    '{"ts":"2026-08-29T01:02:05.010Z","stage":"report","type":"finish"}',
    '',
  ].join('\r\n'));
  writeFileSync(join(directory, 'uro-report.md'), '# Run report\n');
  writeFileSync(join(directory, 'uro-runfacts.json'), '{"before":"archive status"}\n');
  if (diff) writeFileSync(join(directory, 'CHANGES.diff'), 'diff --git a/a b/a\n');
}

function facts(runId = '2026-08-29T01-02-03-004Z-artifact-test') {
  return {
    runId,
    iterations: [],
    outcome: 'review-ready',
    evidenceNonZero: 0,
    correctnessVerdict: 'NO_BLOCKERS',
    intentVerdict: 'ISSUES',
    tokens: { total: { inputTokens: 17, outputTokens: 9 } },
  };
}

test('artifact root prefers the CLI override, then environment, then the scratch default', () => {
  assert.equal(resolveArtifactRoot({
    scratchRoot: 'relative-scratch',
    artifactRoot: 'cli-records',
    env: { URO_ARTIFACT_ROOT: 'env-records' },
  }), resolve('cli-records'));
  assert.equal(resolveArtifactRoot({
    scratchRoot: 'relative-scratch',
    env: { URO_ARTIFACT_ROOT: 'env-records' },
  }), resolve('env-records'));
  assert.equal(resolveArtifactRoot({ scratchRoot: 'relative-scratch', env: {} }),
    resolve('relative-scratch', 'artifacts'));
});

test('a completed record copies every produced artifact and appends the exact index entry', () => {
  const root = temporaryDirectory('complete-');
  const worktree = join(root, 'run', 'w');
  const artifactRoot = join(root, 'records');
  const runFacts = facts();
  const startedAt = new Date('2000-01-01T00:00:00.000Z');
  const endedAt = new Date('2000-01-01T00:00:00.001Z');
  try {
    writeProducedArtifacts(worktree);
    const originalEvents = readFileSync(join(worktree, 'events.jsonl'));

    const archived = archiveRunArtifacts({
      dir: worktree,
      runId: runFacts.runId,
      facts: runFacts,
      scratchRoot: root,
      artifactRoot,
      startedAt,
      endedAt,
    });

    const durableDirectory = join(artifactRoot, runFacts.runId);
    for (const filename of [
      'TASK.md', 'events.jsonl', 'uro-report.md', 'uro-runfacts.json', 'CHANGES.diff',
    ]) {
      assert.equal(existsSync(join(durableDirectory, filename)), true,
        `${filename} must be copied into the durable directory`);
    }
    assert.deepEqual(readFileSync(join(durableDirectory, 'events.jsonl')), originalEvents,
      'events.jsonl must be copied byte-for-byte');
    assert.equal(archived.status, 'ok');
    assert.equal(runFacts.artifacts.status, 'ok');
    assert.deepEqual(JSON.parse(readFileSync(join(artifactRoot, 'index.jsonl'), 'utf8')), {
      runId: runFacts.runId,
      startedAt: '2026-08-29T01:02:03.004Z',
      endedAt: '2026-08-29T01:02:05.010Z',
      durationMs: 2006,
      outcome: 'review-ready',
      evidenceNonZero: 0,
      correctnessVerdict: 'NO_BLOCKERS',
      intentVerdict: 'ISSUES',
      inputTokens: 17,
      outputTokens: 9,
    });
    assert.notEqual(startedAt.toISOString(), '2026-08-29T01:02:03.004Z',
      'positive control: index timing came from events.jsonl, not the fallback wall clock');
    assert.equal(readFileSync(join(artifactRoot, 'index.jsonl'), 'utf8').trim().split('\n').length, 1,
      'one completed record must append exactly one index line');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a no-diff record positively archives its other files and omits only CHANGES.diff', () => {
  const root = temporaryDirectory('no-diff-');
  const worktree = join(root, 'run', 'w');
  const artifactRoot = join(root, 'records');
  const runFacts = facts('2026-08-29T02-00-00-000Z-no-diff');
  try {
    writeProducedArtifacts(worktree, { diff: false });
    const archived = archiveRunArtifacts({
      dir: worktree,
      runId: runFacts.runId,
      facts: runFacts,
      scratchRoot: root,
      artifactRoot,
      startedAt: new Date(0),
      endedAt: new Date(1),
    });

    const durableDirectory = join(artifactRoot, runFacts.runId);
    assert.equal(existsSync(durableDirectory), true, 'the durable run directory must exist');
    for (const filename of ['TASK.md', 'events.jsonl', 'uro-report.md', 'uro-runfacts.json']) {
      assert.equal(existsSync(join(durableDirectory, filename)), true,
        `${filename} is the positive control for no-diff archiving`);
    }
    assert.equal(archived.status, 'ok', 'the archive itself must have succeeded');
    assert.equal(runFacts.artifacts.status, 'ok', 'successful archive status must reach facts');
    assert.equal(existsSync(join(durableDirectory, 'CHANGES.diff')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unusable artifact root records failure without changing the run result', () => {
  const root = temporaryDirectory('blocked-root-');
  const worktree = join(root, 'run', 'w');
  const artifactRoot = join(root, 'not-a-directory');
  const runFacts = facts('2026-08-29T03-00-00-000Z-blocked');
  const invariant = {
    outcome: runFacts.outcome,
    correctnessVerdict: runFacts.correctnessVerdict,
    intentVerdict: runFacts.intentVerdict,
  };
  try {
    writeProducedArtifacts(worktree);
    writeFileSync(artifactRoot, 'blocks mkdir');
    const archived = archiveRunArtifacts({
      dir: worktree,
      runId: runFacts.runId,
      facts: runFacts,
      scratchRoot: root,
      artifactRoot,
      startedAt: new Date(0),
      endedAt: new Date(1),
    });

    assert.equal(archived.status, 'failed');
    assert.equal(runFacts.artifacts.status, 'failed');
    assert.deepEqual({
      outcome: runFacts.outcome,
        correctnessVerdict: runFacts.correctnessVerdict,
      intentVerdict: runFacts.intentVerdict,
    }, invariant);
    const persisted = JSON.parse(readFileSync(join(worktree, 'uro-runfacts.json'), 'utf8'));
    assert.equal(persisted.artifacts.status, 'failed',
      'the worktree facts must retain the best-effort archive failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed index append is recorded without changing the run outcome', () => {
  const root = temporaryDirectory('index-failure-');
  const worktree = join(root, 'run', 'w');
  const artifactRoot = join(root, 'records');
  const runFacts = facts('2026-08-29T04-00-00-000Z-index-failure');
  try {
    writeProducedArtifacts(worktree);
    mkdirSync(join(artifactRoot, 'index.jsonl'), { recursive: true });
    const archived = archiveRunArtifacts({
      dir: worktree,
      runId: runFacts.runId,
      facts: runFacts,
      scratchRoot: root,
      artifactRoot,
      startedAt: new Date(0),
      endedAt: new Date(1),
    });

    assert.equal(runFacts.outcome, 'review-ready');
    assert.equal(archived.status, 'failed');
    assert.equal(archived.index.status, 'failed');
    assert.equal(runFacts.artifacts.index.status, 'failed');
    assert.equal(existsSync(join(artifactRoot, runFacts.runId, 'TASK.md')), true,
      'index failure must not prevent artifact copying');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an artifact root inside the worktree produces no retention writes there', () => {
  const root = temporaryDirectory('overlap-');
  const worktree = join(root, 'run', 'w');
  const artifactRoot = join(worktree, 'durable-records');
  const runFacts = facts('2026-08-29T04-30-00-000Z-overlap');
  try {
    writeProducedArtifacts(worktree);
    const archived = archiveRunArtifacts({
      dir: worktree,
      runId: runFacts.runId,
      facts: runFacts,
      scratchRoot: root,
      artifactRoot,
      startedAt: new Date(0),
      endedAt: new Date(1),
    });

    assert.equal(archived.status, 'failed');
    assert.equal(existsSync(artifactRoot), false,
      'the rejected durable root itself must not be created in the worktree');
    assert.equal(existsSync(join(artifactRoot, 'index.jsonl')), false,
      'index append must honor the same overlap rejection as artifact copying');
    assert.equal(existsSync(join(worktree, 'TASK.md')), true,
      'positive control: the source harness record remains in the worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.after(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
});
