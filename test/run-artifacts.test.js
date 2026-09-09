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
import { homedir } from 'node:os';
import { run as executeRun } from '../src/run.js';
import { execFileSync } from 'node:child_process';
import { createInspectionReceipt } from '../src/context-evidence.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';
import { generateRunJournal } from '../src/run-journal.js';
import { exitCodeFor } from '../src/exit.js';
import { physicalRunIdFor } from '../src/run-id.js';
import { isolate } from '../src/isolation.js';

const run = (options) => executeRun(withVerifiedSuperpowers(options));

const TEST_ROOT = join(process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32' ? 'C:/ccc-test' : join(homedir(), '.ccc-test')), 'run-artifacts');
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
  const envelope = (r, action, extra = {}) => ({ schemaVersion: 1, action, artifactDigest: r.state.artifactDigest,
    contextDigest: r.state.snapshot.digest, replyTo: null, content: 'Archive fixture work', claims: [], issues: [], evidence: [], verifications: [], next: null, ...extra });
  return {
    isolate: async ({ physicalRunId } = {}) => {
      const dir = join(scratchRoot, physicalRunId ?? runId, 'w');
      mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', dir]);
      execFileSync('git', ['-C', dir, 'config', 'core.autocrlf', 'false']);
      writeFileSync(join(dir, 'seed.txt'), 'base\n');
      execFileSync('git', ['-C', dir, 'add', 'seed.txt']);
      execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base']);
      return {
        dir,
        isRepo: false,
        branch: `uro/${runId}`,
        baseRef: 'HEAD',
        baseCommit: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        cleanup: async () => {},
      };
    },
    runExecutor: async r => {
      if (diff !== '') writeFileSync(join(r.cwd, 'a.txt'), 'actual fixture change\n');
      return { changedFiles: diff === '' ? [] : ['a.txt'], exitCode: 0,
        dialogue: envelope(r, diff === '' ? 'ask' : 'propose', diff === '' ? { issues: [{ id: 'Q1', title: 'Product decision',
          kind: 'product', needsHuman: true, blocking: true, status: 'awaiting-answer' }] } : {}) };
    },
    runReview: async r => {
      const evidence = r.state.evidence.find(e => e.id === 'requirement-briefing');
      const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'claude', evidence: [evidence], inspected: true, result: 'read' });
      return { observations: { evidence: [], receipts: [receipt] }, dialogue: envelope(r, 'approve', {
        claims: [{ id: 'briefing-requirement', kind: 'fact', text: 'Saved briefing read', evidenceIds: [evidence.id] }],
        verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'Read briefing' }],
      }) };
    },
  };
}

test('run archives its complete record to the default root and preserves its journal runId', async () => {
  const scratchRoot = temporaryDirectory('default-');
  const runId = '2026-08-29T05-00-00-000Z-default-archive';
  const eventsPath = join(scratchRoot, runId, 'w', 'events.jsonl');
  const notePath = join(PROJECT_RUNS, `${runId}.md`);
  try {
    const runAdapters = adapters(scratchRoot, runId);
    const execute = runAdapters.runExecutor;
    runAdapters.runExecutor = async r => {
      assert.equal(existsSync(join(scratchRoot, runId, '.uro-running')), true,
        'the active-run marker must protect the worktree while execution is in progress');
      return execute(r);
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
      '__uro_dialogue/journal.jsonl', '__uro_dialogue/journal-tail.jsonl',
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

test('native paused no-diff run archives its actual empty diff and pending decision', async () => {
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
    assert.equal(facts.outcome, 'needs-decision');
    assert.equal(facts.approved, false);
    assert.equal(facts.artifacts.status, 'ok');
    assert.equal(existsSync(durableDirectory), true);
    for (const filename of ['TASK.md', 'events.jsonl', 'uro-report.md', 'uro-runfacts.json']) {
      assert.equal(existsSync(join(durableDirectory, filename)), true,
        `${filename} proves no-diff archiving occurred`);
    }
    assert.equal(readFileSync(join(durableDirectory, 'CHANGES.diff'), 'utf8'), '');
    assert.equal(facts.checkpointState.version, 2);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test('run pauses when required native archive retention fails while preserving intact source', async () => {
  const scratchRoot = temporaryDirectory('blocked-');
  const runId = '2026-08-29T07-00-00-000Z-blocked';
  const blockedRoot = join(scratchRoot, 'blocked-root');
  try {
    const runAdapters = adapters(scratchRoot, runId);
    const review = runAdapters.runReview;
    runAdapters.runReview = async r => {
      // The entire archive destination fails, including required context/journal retention.
      writeFileSync(join(blockedRoot, runId), 'not a directory');
      return review(r);
    };
    const facts = await run({
      task: 'change a.txt',
      target: 'adapter-target',
      gate: [],
      gateRetries: 0,
      scratchRoot,
      artifactRoot: blockedRoot,
      runId,
      env: {},
      adapters: runAdapters,
    });
    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(Object.hasOwn(facts, 'correctnessVerdict'), false,
      'the verdict surface stays gone even on artifact failure');
    assert.equal(facts.artifacts.status, 'failed');
    assert.equal(facts.approved, false);
    assert.equal(facts.approval, null);
    assert.equal(facts.nextAction, 'paused');
    assert.match(facts.reason, /required artifact retention failed/);
    const finalReport = readFileSync(join(facts.dir, 'uro-report.md'), 'utf8');
    assert.match(finalReport, /Approved: no|Approved: false/);
    assert.match(finalReport, /required artifact retention failed/i);
    assert.equal(existsSync(join(facts.dir, '__uro_dialogue', 'journal-tail.jsonl')), true);
    assert.equal(readFileSync(join(blockedRoot, runId), 'utf8'), 'not a directory');
    assert.equal(existsSync(join(blockedRoot, runId, '__uro_context')), false);
    assert.notEqual(exitCodeFor(facts.outcome), 0,
      'failed required retention must prevent onward success');
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
      const execute = runAdapters.runExecutor;
      runAdapters.runExecutor = async r => {
        assert.equal(existsSync(join(scratchRoot, physicalRunId, '.uro-running')), true,
          'the physical run directory receives the active marker');
        return execute(r);
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
