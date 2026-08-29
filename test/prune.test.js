import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneScratch } from '../src/prune.js';

const TEST_ROOT = fileURLToPath(new URL('../.ccc-test-prune/', import.meta.url));

function temporaryScratch(prefix = 'root-') {
  mkdirSync(TEST_ROOT, { recursive: true });
  return mkdtempSync(join(TEST_ROOT, prefix));
}

function makeRun(scratchRoot, runId, ageDays, now = Date.now()) {
  const directory = join(scratchRoot, runId);
  mkdirSync(join(directory, 'w'), { recursive: true });
  writeFileSync(join(directory, 'w', 'TASK.md'), runId);
  writeFileSync(join(directory, 'w', 'uro-runfacts.json'), JSON.stringify({ runId }));
  const timestamp = new Date(now - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(directory, timestamp, timestamp);
  return directory;
}

test('prune --keep 2 removes three of five runs and keeps the two newest', async () => {
  const scratchRoot = temporaryScratch();
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  try {
    for (let age = 5; age >= 1; age--) makeRun(scratchRoot, `run-${age}`, age, now);
    const result = await pruneScratch({ scratchRoot, keep: 2, now });
    assert.equal(result.removed, 3);
    assert.equal(result.kept, 2);
    assert.deepEqual(result.removedDirectories.map((path) => path.split(/[\\/]/).at(-1)),
      ['run-5', 'run-4', 'run-3']);
    assert.equal(existsSync(join(scratchRoot, 'run-2')), true);
    assert.equal(existsSync(join(scratchRoot, 'run-1')), true);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('prune dry-run lists candidates and removes nothing', async () => {
  const scratchRoot = temporaryScratch();
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  try {
    for (let age = 3; age >= 1; age--) makeRun(scratchRoot, `dry-${age}`, age, now);
    const result = await pruneScratch({ scratchRoot, keep: 1, dryRun: true, now });
    assert.equal(result.removed, 0);
    assert.equal(result.kept, 3);
    assert.deepEqual(result.wouldRemove.map((path) => path.split(/[\\/]/).at(-1)),
      ['dry-3', 'dry-2']);
    for (let age = 3; age >= 1; age--) {
      assert.equal(existsSync(join(scratchRoot, `dry-${age}`)), true);
    }
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('combined keep and older-than rules remove a run only when both permit it', async () => {
  const scratchRoot = temporaryScratch();
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  try {
    makeRun(scratchRoot, 'oldest', 30, now);
    makeRun(scratchRoot, 'old-but-kept-by-rank', 20, now);
    makeRun(scratchRoot, 'recent', 1, now);
    const result = await pruneScratch({ scratchRoot, keep: 2, olderThan: 10, now });
    assert.equal(result.removed, 1);
    assert.equal(existsSync(join(scratchRoot, 'oldest')), false);
    assert.equal(existsSync(join(scratchRoot, 'old-but-kept-by-rank')), true);
    assert.equal(existsSync(join(scratchRoot, 'recent')), true);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('prune never removes an artifact root or its durable copy', async () => {
  const scratchRoot = temporaryScratch();
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  const runId = 'durable-survives';
  const artifactRoot = join(scratchRoot, 'artifacts');
  try {
    makeRun(scratchRoot, runId, 30, now);
    mkdirSync(join(artifactRoot, runId), { recursive: true });
    writeFileSync(join(artifactRoot, runId, 'uro-runfacts.json'), 'durable facts');
    const result = await pruneScratch({ scratchRoot, artifactRoot, keep: 0, now });
    assert.equal(result.removed, 1, 'positive control: the disposable worktree was removed');
    assert.equal(existsSync(join(scratchRoot, runId)), false);
    assert.equal(readFileSync(join(artifactRoot, runId, 'uro-runfacts.json'), 'utf8'),
      'durable facts');
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('prune resolves an artifact-root junction before deciding a run is disposable', async (t) => {
  const scratchRoot = temporaryScratch();
  const runId = 'junction-protected';
  const runDirectory = makeRun(scratchRoot, runId, 30);
  const durableTarget = join(runDirectory, 'w', 'durable-records');
  const artifactRoot = join(scratchRoot, 'artifact-link');
  try {
    mkdirSync(join(durableTarget, runId), { recursive: true });
    writeFileSync(join(durableTarget, runId, 'uro-runfacts.json'), 'junction durable facts');
    try {
      symlinkSync(durableTarget, artifactRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`directory links are unavailable: ${error.code ?? error.message}`);
      return;
    }

    const result = await pruneScratch({ scratchRoot, artifactRoot, keep: 0 });
    assert.equal(result.removed, 0);
    assert.equal(existsSync(runDirectory), true);
    assert.equal(readFileSync(join(artifactRoot, runId, 'uro-runfacts.json'), 'utf8'),
      'junction durable facts');
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('prune refuses an unsafe scratch root before reading it', async () => {
  await assert.rejects(pruneScratch({
    scratchRoot: 'C:/Users/operator/AppData/Local/uro',
    keep: 0,
  }), /scratch root under AppData is forbidden/i);
});

test('prune resolves a relative scratch root before applying the safety assertion', async () => {
  const unsafeParent = temporaryScratch('AppData-');
  const unsafeRoot = join(unsafeParent, 'AppData', 'Local', 'uro');
  const previousCwd = process.cwd();
  try {
    mkdirSync(unsafeRoot, { recursive: true });
    process.chdir(unsafeRoot);
    await assert.rejects(pruneScratch({ scratchRoot: '.', keep: 0, dryRun: true }),
      /scratch root under AppData is forbidden/i);
  } finally {
    process.chdir(previousCwd);
    rmSync(unsafeParent, { recursive: true, force: true });
  }
});

test('prune refuses a filesystem root', async () => {
  const filesystemRoot = parse(TEST_ROOT).root;
  await assert.rejects(pruneScratch({
    scratchRoot: filesystemRoot,
    keep: 0,
    dryRun: true,
  }), /filesystem root is forbidden/i);
});

test('prune retains a run whose live-process marker says it is currently in use', async () => {
  const scratchRoot = temporaryScratch();
  try {
    const runDirectory = makeRun(scratchRoot, 'active-run', 30);
    writeFileSync(join(runDirectory, '.uro-running'), JSON.stringify({
      runId: 'active-run', pid: process.pid,
    }));
    const result = await pruneScratch({ scratchRoot, keep: 0 });
    assert.equal(result.removed, 0);
    assert.equal(result.kept, 1);
    assert.equal(existsSync(runDirectory), true);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('prune delegates registered worktree cleanup before removing its run directory', async () => {
  const scratchRoot = temporaryScratch();
  try {
    const runDirectory = makeRun(scratchRoot, 'registered-worktree', 30);
    const worktree = join(runDirectory, 'w');
    writeFileSync(join(worktree, '.git'),
      'gitdir: C:/repository/.git/worktrees/registered-worktree\n');
    const cleaned = [];
    const result = await pruneScratch({
      scratchRoot,
      keep: 0,
      cleanupWorktree: async (directory) => {
        cleaned.push(directory);
        return true;
      },
    });
    assert.deepEqual(cleaned, [worktree]);
    assert.equal(result.removed, 1);
    assert.equal(existsSync(runDirectory), false);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('prune never removes a directory recorded as a target repository', async () => {
  const scratchRoot = temporaryScratch();
  try {
    const runDirectory = makeRun(scratchRoot, 'target-repository', 30);
    const worktree = join(runDirectory, 'w');
    writeFileSync(join(worktree, 'uro-runfacts.json'), JSON.stringify({
      runId: 'target-repository',
      target: worktree,
    }));
    const result = await pruneScratch({ scratchRoot, keep: 0 });
    assert.equal(result.removed, 0);
    assert.equal(result.kept, 1);
    assert.equal(existsSync(runDirectory), true);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('prune uses the persisted canonical target when invoked from another directory', async () => {
  const scratchRoot = temporaryScratch();
  const otherCwd = temporaryScratch('other-cwd-');
  const previousCwd = process.cwd();
  try {
    const runDirectory = makeRun(scratchRoot, 'canonical-target', 30);
    const worktree = join(runDirectory, 'w');
    writeFileSync(join(worktree, 'uro-runfacts.json'), JSON.stringify({
      runId: 'canonical-target',
      target: '.',
      targetPath: worktree,
    }));
    process.chdir(otherCwd);
    const result = await pruneScratch({ scratchRoot, keep: 0 });
    assert.equal(result.removed, 0);
    assert.equal(result.kept, 1);
    assert.equal(existsSync(runDirectory), true);
  } finally {
    process.chdir(previousCwd);
    rmSync(scratchRoot, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  }
});

test.after(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
});
