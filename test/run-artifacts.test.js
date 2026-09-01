import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as executeRun } from '../src/run.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { generateRunJournal } from '../src/run-journal.js';
import { exitCodeFor } from '../src/exit.js';
import { physicalRunIdFor } from '../src/run-id.js';
import { isolate } from '../src/isolation.js';

const run = (options) => executeRun(withVerifiedSuperpowers(options));

const TEST_ROOT = fileURLToPath(new URL('../.ccc-test-run-artifacts/', import.meta.url));
const PROJECT_RUNS = fileURLToPath(new URL('../docs/runs/', import.meta.url));

function temporaryDirectory(prefix) {
  mkdirSync(TEST_ROOT, { recursive: true });
  return mkdtempSync(join(TEST_ROOT, prefix));
}

function eventReporter(eventsPath) {
  const pending = [];
  return (event) => {
    const line = `${JSON.stringify(event)}\n`;
    if (!existsSync(dirname(eventsPath))) {
      pending.push(line);
      return;
    }
    if (pending.length > 0) appendFileSync(eventsPath, pending.splice(0).join(''));
    appendFileSync(eventsPath, line);
  };
}

function adapters(scratchRoot, runId, diff = 'diff --git a/a.txt b/a.txt\n') {
  return {
    isolate: async ({ physicalRunId } = {}) => {
      const dir = join(scratchRoot, physicalRunId ?? runId, 'w');
      mkdirSync(dir, { recursive: true });
      return {
        dir,
        isRepo: false,
        branch: `uro/${runId}`,
        baseRef: 'HEAD',
        baseCommit: '0123456789012345678901234567890123456789',
        cleanup: async () => {},
      };
    },
    diffText: async () => diff,
    runExecutor: async () => ({
      changedFiles: diff === '' ? [] : ['a.txt'],
      lastMessage: diff === '' ? 'nothing to do' : 'changed a.txt',
      exitCode: 0,
    }),
    runGate: async () => ({ passed: true, results: [] }),
  };
}

test('run archives its complete record to the default root and preserves its journal runId', async () => {
  const scratchRoot = temporaryDirectory('default-');
  const runId = '2026-08-29T05-00-00-000Z-default-archive';
  const eventsPath = join(scratchRoot, runId, 'w', 'events.jsonl');
  const notePath = join(PROJECT_RUNS, `${runId}.md`);
  try {
    const runAdapters = adapters(scratchRoot, runId);
    runAdapters.runExecutor = async () => {
      assert.equal(existsSync(join(scratchRoot, runId, '.uro-running')), true,
        'the active-run marker must protect the worktree while execution is in progress');
      return { changedFiles: ['a.txt'], lastMessage: 'changed a.txt', exitCode: 0 };
    };
    const facts = await run({
      task: 'change a.txt',
      target: 'adapter-target',
      gate: [],
      gateRetries: 0,
      scratchRoot,
      runId,
      env: {},
      reporter: eventReporter(eventsPath),
      adapters: runAdapters,
    });

    const durableDirectory = join(scratchRoot, 'artifacts', runId);
    assert.equal(facts.runId, runId, 'artifact retention must not replace the logical runId');
    assert.equal(facts.target, 'adapter-target', 'the caller-facing target remains unchanged');
    assert.equal(facts.targetPath, resolve('adapter-target'),
      'facts persist the invocation-time canonical target for safe later pruning');
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(facts.artifacts.status, 'ok');
    assert.equal(existsSync(join(scratchRoot, runId, '.uro-running')), false,
      'the completed run and durable-copy positive controls make marker release observable');
    for (const filename of [
      'TASK.md', 'events.jsonl', 'uro-report.md', 'uro-runfacts.json', 'CHANGES.diff',
    ]) {
      assert.equal(existsSync(join(durableDirectory, filename)), true,
        `${filename} must exist at the default durable root`);
    }
    assert.deepEqual(readFileSync(join(durableDirectory, 'events.jsonl')), readFileSync(eventsPath));
    const indexLines = readFileSync(join(scratchRoot, 'artifacts', 'index.jsonl'), 'utf8')
      .trim().split('\n');
    assert.equal(indexLines.length, 1);
    const index = JSON.parse(indexLines[0]);
    assert.equal(index.runId, runId);
    assert.equal(index.outcome, facts.outcome);
    assert.equal(index.evidenceNonZero, (facts.evidence ?? []).filter((entry) => entry.code !== 0).length);
    assert.equal(index.findingsLastRound,
      (facts.debate?.roundHistory?.at(-1)?.findings ?? []).length);
    assert.ok(Number.isFinite(index.durationMs) && index.durationMs >= 0);

    const journal = generateRunJournal(join(facts.dir, 'uro-runfacts.json'));
    assert.equal(journal.runId, runId);
    assert.equal(existsSync(journal.notePath), true,
      'a normal date-prefixed runId must still generate a journal note');
  } finally {
    rmSync(notePath, { force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('run no-diff archiving has positive controls and skips only CHANGES.diff', async () => {
  const scratchRoot = temporaryDirectory('no-diff-');
  const artifactRoot = temporaryDirectory('no-diff-records-');
  const runId = '2026-08-29T06-00-00-000Z-no-diff';
  const eventsPath = join(scratchRoot, runId, 'w', 'events.jsonl');
  try {
    const facts = await run({
      task: 'make no changes',
      target: 'adapter-target',
      gate: [],
      gateRetries: 0,
      scratchRoot,
      artifactRoot,
      runId,
      env: {},
      reporter: eventReporter(eventsPath),
      adapters: adapters(scratchRoot, runId, ''),
    });

    const durableDirectory = join(artifactRoot, runId);
    assert.equal(facts.outcome, 'no-op');
    assert.equal(facts.artifacts.status, 'ok');
    assert.equal(existsSync(durableDirectory), true);
    for (const filename of ['TASK.md', 'events.jsonl', 'uro-report.md', 'uro-runfacts.json']) {
      assert.equal(existsSync(join(durableDirectory, filename)), true,
        `${filename} proves no-diff archiving occurred`);
    }
    assert.equal(existsSync(join(durableDirectory, 'CHANGES.diff')), false);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('run records an artifact-root failure without changing its outcome', async () => {
  const scratchRoot = temporaryDirectory('blocked-');
  const runId = '2026-08-29T07-00-00-000Z-blocked';
  const blockedRoot = join(scratchRoot, 'blocked-root');
  try {
    writeFileSync(blockedRoot, 'not a directory');
    const facts = await run({
      task: 'change a.txt',
      target: 'adapter-target',
      gate: [],
      gateRetries: 0,
      scratchRoot,
      artifactRoot: blockedRoot,
      runId,
      env: {},
      adapters: adapters(scratchRoot, runId),
    });
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(Object.hasOwn(facts, 'correctnessVerdict'), false,
      'the verdict surface stays gone even on artifact failure');
    assert.equal(facts.artifacts.status, 'failed');
    assert.equal(exitCodeFor(facts.outcome), 0,
      'best-effort artifact failure must not change the process exit mapping');
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('a path-like campaign runId uses one safe physical directory without changing facts.runId',
  async () => {
    const scratchRoot = temporaryDirectory('physical-id-');
    const artifactRoot = temporaryDirectory('physical-id-records-');
    const runId = 'feature/a';
    const physicalRunId = physicalRunIdFor(runId);
    const eventsPath = join(scratchRoot, physicalRunId, 'w', 'events.jsonl');
    try {
      const runAdapters = adapters(scratchRoot, runId);
      runAdapters.runExecutor = async () => {
        assert.equal(existsSync(join(scratchRoot, physicalRunId, '.uro-running')), true,
          'the physical run directory receives the active marker');
        return { changedFiles: ['a.txt'], lastMessage: 'changed a.txt', exitCode: 0 };
      };
      const facts = await run({
        task: 'change a.txt',
        target: 'adapter-target',
        gate: [],
        gateRetries: 0,
        scratchRoot,
        artifactRoot,
        runId,
        env: {},
        reporter: eventReporter(eventsPath),
        adapters: runAdapters,
      });

      assert.equal(facts.runId, runId);
      assert.equal(facts.physicalRunId, physicalRunId);
      assert.notEqual(physicalRunId, runId);
      assert.equal(physicalRunId.includes('/'), false);
      assert.equal(physicalRunId.includes('\\'), false);
      assert.equal(existsSync(join(artifactRoot, physicalRunId, 'uro-runfacts.json')), true);
      assert.equal(JSON.parse(readFileSync(join(artifactRoot, 'index.jsonl'), 'utf8')).runId,
        runId, 'the index keeps the logical campaign ID');
      assert.equal(existsSync(join(scratchRoot, 'feature')), false,
        'the logical separator must not create nested scratch directories');
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

test('physical run IDs cannot alias logical IDs or Windows case variants', () => {
  const pathLikePhysical = physicalRunIdFor('feature/a');
  assert.notEqual(physicalRunIdFor(pathLikePhysical).toLowerCase(),
    pathLikePhysical.toLowerCase(), 'a forged hash-shaped logical ID uses another namespace');
  assert.notEqual(physicalRunIdFor('Foo').toLowerCase(), physicalRunIdFor('foo').toLowerCase(),
    'case-distinct logical IDs stay distinct on a case-insensitive filesystem');
  assert.notEqual(physicalRunIdFor('foo.').toLowerCase(), physicalRunIdFor('foo').toLowerCase(),
    'trailing-dot aliases stay distinct on Windows');
});

test('isolation refuses a supplied physical ID that disagrees with the logical runId', async () => {
  await assert.rejects(isolate({
    target: 'unused-target',
    runId: 'safe-logical-id',
    physicalRunId: '../escape',
    scratchRoot: TEST_ROOT,
  }), /physicalRunId must match/i);
  assert.equal(existsSync(join(TEST_ROOT, '..', 'escape')), false);
});

test.after(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
});
