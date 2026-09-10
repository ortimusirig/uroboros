import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  archiveRunArtifacts,
  resolveArtifactRoot,
} from '../src/artifacts.js';
import { writeReport } from '../src/report.js';

const TEST_ROOT = fileURLToPath(new URL('../.ccc-test-artifacts/', import.meta.url));

test('required native archive failure revokes onward approval and retains complete source context', () => {
  const root = temporaryDirectory('required-context-');
  try {
    const worktree = join(root, 'work'), artifactRoot = join(root, 'blocked');
    writeProducedArtifacts(worktree);
    mkdirSync(join(worktree, '__uro_context'), { recursive: true });
    mkdirSync(join(worktree, '__uro_dialogue'), { recursive: true });
    writeFileSync(join(worktree, '__uro_context', 'current.json'), 'complete current grounding');
    writeFileSync(join(worktree, '__uro_dialogue', 'journal.jsonl'), 'complete operation history');
    writeFileSync(artifactRoot, 'not a directory');
    const runFacts = { ...facts('required-context'), phase: 'execution', interactionMode: 'autonomous', authority: 'claude',
      approved: true, converged: null, approval: { decidedBy: 'claude', basis: 'reviewer', artifactDigest: 'old', reason: 'clean' },
      dialogue: { snapshot: { digest: 'retention-context', entries: [], recalled: [] }, messages: [], issues: [], dispositions: [] },
      checkpointState: { version: 2 } };
    writeReport({ dir: worktree, facts: runFacts });
    const result = archiveRunArtifacts({ dir: worktree, runId: runFacts.runId, facts: runFacts,
      scratchRoot: root, artifactRoot, requiredRetention: true, startedAt: new Date(), endedAt: new Date() });
    assert.equal(result.status, 'failed');
    assert.equal(runFacts.approved, false);
    assert.equal(runFacts.approval, null);
    assert.equal(runFacts.nextAction, 'paused');
    assert.match(runFacts.reason, /required.*retention|archive/);
    assert.match(readFileSync(join(worktree, 'uro-report.md'), 'utf8'), /Approved: no|Approved: false/);
    assert.match(readFileSync(join(worktree, 'uro-report.md'), 'utf8'), /required artifact retention failed/i);
    assert.equal(readFileSync(join(worktree, '__uro_context', 'current.json'), 'utf8'), 'complete current grounding');
    assert.equal(readFileSync(join(worktree, '__uro_dialogue', 'journal.jsonl'), 'utf8'), 'complete operation history');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a required copy failure refreshes source and already-created durable Markdown from final facts', () => {
  const root = temporaryDirectory('final-projection-');
  const worktree = join(root, 'work'), artifactRoot = join(root, 'records'), outside = join(root, 'outside');
  try {
    writeProducedArtifacts(worktree);
    mkdirSync(outside);
    mkdirSync(join(worktree, '__uro_review'));
    writeFileSync(join(outside, 'private.txt'), 'outside');
    symlinkSync(outside, join(worktree, '__uro_review', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const runFacts = { ...facts('2026-08-29T01-02-03-004Z-final-projection'), phase: 'execution',
      interactionMode: 'autonomous', authority: 'claude', approved: true, converged: null,
      approval: { decidedBy: 'claude', basis: 'reviewer', artifactDigest: 'before-retention', reason: 'clean' },
      dialogue: { snapshot: { digest: 'final-context', entries: [], recalled: [] }, messages: [], issues: [], dispositions: [] },
      checkpointState: { version: 2 } };
    writeReport({ dir: worktree, facts: runFacts });
    const archived = archiveRunArtifacts({ dir: worktree, runId: runFacts.runId, facts: runFacts,
      scratchRoot: root, artifactRoot, requiredRetention: true, startedAt: new Date(), endedAt: new Date() });
    assert.equal(archived.status, 'failed');
    assert.equal(runFacts.approved, false);
    for (const reportPath of [join(worktree, 'uro-report.md'), join(artifactRoot, runFacts.runId, 'uro-report.md')]) {
      const report = readFileSync(reportPath, 'utf8');
      assert.match(report, /Approved: no|Approved: false/, reportPath);
      assert.match(report, /required artifact retention failed/i, reportPath);
      assert.doesNotMatch(report, /Approved: yes|Approved: true/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const failedProjection of ['source', 'durable']) test(`an unsafe ${failedProjection} report refresh fails visibly without exposing stale approval`, () => {
  const root = temporaryDirectory(`unsafe-${failedProjection}-report-`);
  const worktree = join(root, 'work'), artifactRoot = join(root, 'records');
  try {
    writeProducedArtifacts(worktree);
    const runFacts = { ...facts(`2026-08-29T01-02-03-004Z-${failedProjection}-report`), phase: 'execution',
      interactionMode: 'autonomous', authority: 'claude', approved: true, converged: null,
      approval: { decidedBy: 'claude', basis: 'reviewer', artifactDigest: 'before-retention', reason: 'clean' },
      dialogue: { snapshot: { digest: 'unsafe-report-context', entries: [], recalled: [] }, messages: [], issues: {} },
      checkpointState: { version: 2 } };
    writeReport({ dir: worktree, facts: runFacts });
    const stale = join(root, `${failedProjection}-stale.md`);
    writeFileSync(stale, 'Approved: yes\n');
    const unsafe = failedProjection === 'source' ? join(worktree, 'uro-report.md')
      : join(artifactRoot, runFacts.runId, 'uro-report.md');
    if (failedProjection === 'source') unlinkSync(unsafe);
    else mkdirSync(join(artifactRoot, runFacts.runId), { recursive: true });
    symlinkSync(stale, unsafe, 'file');

    const archived = archiveRunArtifacts({ dir: worktree, runId: runFacts.runId, facts: runFacts,
      scratchRoot: root, artifactRoot, requiredRetention: true, startedAt: new Date(), endedAt: new Date() });
    assert.equal(archived.status, 'failed');
    assert.equal(runFacts.approved, false);
    assert.equal(existsSync(unsafe), false, 'unsafe presentation must be removed instead of retaining stale approval');
    assert.equal(readFileSync(stale, 'utf8'), 'Approved: yes\n', 'refresh must not follow or modify an external link');
    if (failedProjection === 'durable') assert.doesNotMatch(readFileSync(join(worktree, 'uro-report.md'), 'utf8'), /Approved: yes|Approved: true/);
    assert.equal(archived[failedProjection === 'source' ? 'factsWrite' : 'refresh'].status, 'failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a legacy direct archive without a source report preserves JSON behavior and does not invent Markdown', () => {
  const root = temporaryDirectory('legacy-json-only-');
  const worktree = join(root, 'work'), artifactRoot = join(root, 'records');
  try {
    writeProducedArtifacts(worktree);
    unlinkSync(join(worktree, 'uro-report.md'));
    const runFacts = facts('2026-08-29T01-02-03-004Z-legacy-json-only');
    const archived = archiveRunArtifacts({ dir: worktree, runId: runFacts.runId, facts: runFacts,
      scratchRoot: root, artifactRoot, startedAt: new Date(), endedAt: new Date() });
    assert.equal(archived.status, 'ok');
    assert.equal(existsSync(join(worktree, 'uro-report.md')), false);
    assert.equal(existsSync(join(artifactRoot, runFacts.runId, 'uro-report.md')), false);
    assert.equal(JSON.parse(readFileSync(join(worktree, 'uro-runfacts.json'), 'utf8')).artifacts.status, 'ok');
    assert.equal(JSON.parse(readFileSync(join(artifactRoot, runFacts.runId, 'uro-runfacts.json'), 'utf8')).artifacts.status, 'ok');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exact retained phase files archive only registered bytes and required source loss revokes approval', t => {
  for (const failure of [null, 'stale', 'missing', 'escape', 'unrelated', 'source-link', 'destination-link']) {
    const root = mkdtempSync(join(tmpdir(), 'uro-retained-archive-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const worktree = join(root, 'work'), artifactRoot = join(root, 'archive');
    writeProducedArtifacts(worktree);
    const phase = '.uro-tmp/retained-phases/phase-1';
    const path = `${phase}/__uro_dialogue/journal.jsonl`;
    mkdirSync(join(worktree, phase, '__uro_dialogue'), { recursive: true });
    writeFileSync(join(worktree, path), 'journal bytes');
    writeFileSync(join(worktree, phase, 'unregistered.txt'), 'private unrelated temp');
    let retainedFiles = [{ path, sha256: createHash('sha256').update('journal bytes').digest('hex') }];
    if (failure === 'stale') writeFileSync(join(worktree, path), 'changed');
    if (failure === 'missing') rmSync(join(worktree, path));
    if (failure === 'escape') retainedFiles[0].path = '../outside.txt';
    if (failure === 'unrelated') retainedFiles[0].path = '.uro-tmp/unrelated.txt';
    if (failure === 'source-link') {
      const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'journal.jsonl'), 'journal bytes');
      rmSync(join(worktree, phase, '__uro_dialogue'), { recursive: true });
      symlinkSync(outside, join(worktree, phase, '__uro_dialogue'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const runFacts = { ...facts('retained-test'), approved: true, approval: { seat: 'claude' } };
    if (failure === 'destination-link') {
      const outside = join(root, 'outside'); mkdirSync(outside);
      mkdirSync(join(artifactRoot, runFacts.runId), { recursive: true });
      symlinkSync(outside, join(artifactRoot, runFacts.runId, '.uro-tmp'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const archived = archiveRunArtifacts({ dir: worktree, runId: runFacts.runId, facts: runFacts,
      scratchRoot: root, artifactRoot, retainedFiles, startedAt: new Date(), endedAt: new Date() });
    assert.equal(archived.status, failure ? 'failed' : 'ok', failure);
    assert.equal(runFacts.approved, !failure || failure === 'destination-link', failure);
    if (!failure) assert.equal(readFileSync(join(artifactRoot, runFacts.runId, path), 'utf8'), 'journal bytes');
    if (failure && failure !== 'destination-link') assert.equal(archived.requiredSource.status, 'failed');
    assert.equal(existsSync(join(artifactRoot, runFacts.runId, phase, 'unregistered.txt')), false);
    if (failure === 'destination-link') assert.equal(existsSync(join(root, 'outside/retained-phases')), false);
  }
});

test('evidence directory retention refuses symlink traversal and never copies unrelated directory trees', () => {
  const root = temporaryDirectory('evidence-boundary-');
  try {
    const worktree = join(root, 'run', 'w'), outside = join(root, 'outside'), artifactRoot = join(root, 'records');
    writeProducedArtifacts(worktree);
    mkdirSync(outside);
    writeFileSync(join(outside, 'private.txt'), 'must stay outside');
    mkdirSync(join(worktree, '__uro_review'));
    mkdirSync(join(worktree, '.uro-tmp'));
    writeFileSync(join(worktree, '.uro-tmp', 'unrelated.txt'), 'not retained');
    symlinkSync(outside, join(worktree, '__uro_review', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const runFacts = facts();
    const archived = archiveRunArtifacts({ dir: worktree, runId: runFacts.runId, facts: runFacts,
      scratchRoot: root, artifactRoot, startedAt: new Date(), endedAt: new Date() });
    assert.equal(archived.status, 'failed');
    assert.match(archived.copyFailures[0].error, /symbolic-link/);
    assert.equal(existsSync(join(artifactRoot, runFacts.runId, '__uro_review', 'escape', 'private.txt')), false);
    assert.equal(existsSync(join(artifactRoot, runFacts.runId, '.uro-tmp')), false);
    assert.equal(readFileSync(join(outside, 'private.txt'), 'utf8'), 'must stay outside');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    debate: {
      roundsRun: 1,
      stopReason: 'converged',
      roundHistory: [{
        round: 1, findingIds: ['F1'], blockingFindingIds: [],
        suggestionFindingIds: ['F1'],
        findings: [{ id: 'F1', severity: 'suggestion', category: 'intent',
          description: 'retained for the index count' }],
      }],
    },
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
      findingsLastRound: 1,
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
    findings: runFacts.debate.roundHistory.at(-1).findings.length,
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
      findings: runFacts.debate.roundHistory.at(-1).findings.length,
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
