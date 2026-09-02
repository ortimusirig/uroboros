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
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnCapture } from '../src/spawn.js';
import {
  assertSafeScratchRoot,
  defaultBranchName,
  hashTree,
  isolate,
} from '../src/isolation.js';

// Scratch base must satisfy assertSafeScratchRoot: NOT under AppData or OneDrive.
// os.tmpdir() is under AppData on Windows and process.cwd() is under OneDrive for a
// checkout that lives in a synced folder — both are rejected by the guard. Mirror the
// production default from bin/loop.js, which is safe by the same construction.
const SAFE_SCRATCH_BASE = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));
function makeScratch() {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SAFE_SCRATCH_BASE, '.ccc-test-'));
}

async function gitOk(cwd, ...args) {
  const result = await spawnCapture('git', ['-C', cwd, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'isolation-repo-'));
  await gitOk(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'version.txt'), 'base\n');
  await gitOk(repo, 'add', '-A');
  await gitOk(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base');
  return repo;
}

test('assertSafeScratchRoot rejects AppData and OneDrive', () => {
  assert.throws(() => assertSafeScratchRoot('C:/Users/x/AppData/Local/ccc'), /AppData/i);
  assert.throws(() => assertSafeScratchRoot('C:/Users/x/OneDrive/ccc'), /OneDrive/i);
  assert.doesNotThrow(() => assertSafeScratchRoot('C:/ccc/w'));
  assert.doesNotThrow(() => assertSafeScratchRoot('C:/x/onedriverback/ccc'));
  assert.throws(() => assertSafeScratchRoot('C:/Users/x/OneDrive - Acme Corp/ccc'), /OneDrive/i);
});

test('hashTree changes when a file changes, ignores .git', () => {
  const d = mkdtempSync(join(tmpdir(), 'ht-'));
  writeFileSync(join(d, 'a.txt'), 'one');
  const h1 = hashTree(d);
  mkdirSync(join(d, '.git'));
  writeFileSync(join(d, '.git', 'junk'), 'x');
  assert.equal(hashTree(d), h1, '.git must not affect the hash');
  writeFileSync(join(d, 'a.txt'), 'two');
  assert.notEqual(hashTree(d), h1);
});

test('isolate on a NON-repo folder inits git and leaves the source untouched', async () => {
  const src = mkdtempSync(join(tmpdir(), 'src-'));
  writeFileSync(join(src, 'file.txt'), 'hello');
  const before = hashTree(src);
  const scratch = makeScratch();
  const iso = await isolate({ target: src, runId: 'testrun', scratchRoot: scratch });
  assert.equal(iso.isRepo, false);
  assert.ok(existsSync(join(iso.dir, '.git')), 'isolated dir is a git repo');
  assert.ok(existsSync(join(iso.dir, 'file.txt')), 'content copied');
  assert.equal(iso.baseRef, 'HEAD');
  assert.equal(iso.branch, 'uro/testrun');
  assert.equal(hashTree(src), before, 'source tree unchanged');
  const log = await spawnCapture('git', ['-C', iso.dir, 'log', '--oneline']);
  assert.match(log.stdout, /baseline/i);
  await iso.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

test('isolate on a git repo creates a worktree and leaves the source untouched', async () => {
  const src = mkdtempSync(join(tmpdir(), 'repo-'));
  writeFileSync(join(src, 'f.txt'), 'x');
  await spawnCapture('git', ['-C', src, 'init', '-b', 'main']);
  await spawnCapture('git', ['-C', src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  await spawnCapture('git', ['-C', src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
  const before = hashTree(src);
  const scratch = makeScratch();
  const iso = await isolate({ target: src, runId: 'repotest', scratchRoot: scratch });
  assert.equal(iso.isRepo, true);
  assert.ok(existsSync(join(iso.dir, 'f.txt')), 'worktree has the file');
  assert.equal(iso.baseRef, 'HEAD');
  assert.equal(iso.branch, 'uro/repotest');
  assert.equal(hashTree(src), before, 'source tree unchanged');
  await iso.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

test('isolate() never mutates the source repository\'s own git state', async () => {
  // For a non-campaign run, a linked worktree's `--git-path info/exclude` resolves to the
  // SHARED common .git dir of its source repository (verified empirically: an ignore rule
  // written through either path is visible from both). Appending harness-artifact names
  // there would permanently mutate a real repository the harness does not own: cleanup
  // never runs against the source, and hashTree can never catch it because hashTree skips
  // .git entirely. The fix must never write to a resolved exclude path that does not
  // already live under this run's own scratch root, so this repo's own info/exclude —
  // including one that did not exist before isolate() ran — must come out byte-identical
  // (or still absent) afterward.
  const src = await makeRepo();
  const excludePath = join(src, '.git', 'info', 'exclude');
  const before = existsSync(excludePath) ? readFileSync(excludePath) : null;
  const scratch = makeScratch();
  let iso;
  try {
    iso = await isolate({ target: src, runId: 'no-mutate-source', scratchRoot: scratch });
    const after = existsSync(excludePath) ? readFileSync(excludePath) : null;
    if (before === null) {
      assert.equal(after, null, "isolate() must not create the source repo's own info/exclude");
    } else {
      assert.ok(after !== null && after.equals(before),
        "isolate() must not modify the source repo's own info/exclude");
    }
    // Accepted trade-off, pinned here: a repository the harness does not own does not get
    // the git-status hiding UX either. See the harness-owned test below for the tree that
    // does.
    writeFileSync(join(iso.dir, 'TASK.md'), 'do the thing\n');
    const status = await gitOk(iso.dir, 'status', '--porcelain');
    assert.match(status, /TASK\.md/);
  } finally {
    await iso?.cleanup();
    rmSync(src, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('harness files are git-invisible inside a harness-owned isolated worktree', async () => {
  // Isolating a NON-repo source takes the standalone-copy path: `dir` gets a brand-new
  // `git init` of its own, never shared with anything else, so hiding harness artifacts
  // there mutates only a tree the harness fully owns. The run writes TASK.md and appends
  // events.jsonl straight into iso.dir mid-run, a reviewer round can add CHANGES.diff and
  // files under __uro_review/, and the executor seat reads `git status` to see its own
  // progress with no way to tell those apart from stray output it forgot to add.
  const src = mkdtempSync(join(tmpdir(), 'git-invisible-src-'));
  writeFileSync(join(src, 'file.txt'), 'hello\n');
  const scratch = makeScratch();
  let iso;
  try {
    iso = await isolate({ target: src, runId: 'git-invisible', scratchRoot: scratch });
    writeFileSync(join(iso.dir, 'TASK.md'), 'do the thing\n');
    writeFileSync(join(iso.dir, 'events.jsonl'), '{"seed":true}\n');
    writeFileSync(join(iso.dir, 'CHANGES.diff'), 'diff --git a/x b/x\n');
    mkdirSync(join(iso.dir, '__uro_review'), { recursive: true });
    writeFileSync(join(iso.dir, '__uro_review', 'REVIEW.md'), 'findings\n');
    writeFileSync(join(iso.dir, 'real-work.txt'), 'genuine change\n');
    const status = await gitOk(iso.dir, 'status', '--porcelain');
    assert.doesNotMatch(status, /TASK\.md/);
    assert.doesNotMatch(status, /events\.jsonl/);
    assert.doesNotMatch(status, /CHANGES\.diff/);
    assert.doesNotMatch(status, /__uro_review/);
    assert.match(status, /real-work\.txt/, 'a non-harness untracked file must still be reported');
  } finally {
    await iso?.cleanup();
    rmSync(src, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a generated branch uses the uro/ prefix', () => {
  const branch = defaultBranchName('2026-08-20T00-00-00-000Z-abcdef12');
  assert.equal(branch, 'uro/2026-08-20T00-00-00-000Z-abcdef12');
  assert.doesNotMatch(branch, /^ccc\//, 'the superseded prefix must not be generated');
});

test('an explicit base ref produces that tree rather than the different HEAD tree', async () => {
  const src = await makeRepo();
  const scratch = makeScratch();
  let iso;
  try {
    const baseCommit = await gitOk(src, 'rev-parse', 'HEAD');
    await gitOk(src, 'tag', 'chosen-base');
    writeFileSync(join(src, 'version.txt'), 'head\n');
    writeFileSync(join(src, 'head-only.txt'), 'only on HEAD\n');
    await gitOk(src, 'add', '-A');
    await gitOk(src, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'head');

    iso = await isolate({
      target: src,
      runId: 'explicit-base',
      scratchRoot: scratch,
      baseRef: 'chosen-base',
      branch: 'planner/explicit-base',
    });

    assert.equal(readFileSync(join(iso.dir, 'version.txt'), 'utf8').trim(), 'base');
    assert.equal(existsSync(join(iso.dir, 'head-only.txt')), false,
      'positive control: HEAD-only content must not leak into the selected base tree');
    assert.equal(await gitOk(iso.dir, 'rev-parse', 'HEAD'), baseCommit);
    assert.equal(iso.baseRef, 'chosen-base');
    assert.equal(iso.branch, 'planner/explicit-base');
  } finally {
    await iso?.cleanup();
    rmSync(src, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a missing base ref fails by name and never falls back to HEAD', async () => {
  const src = await makeRepo();
  const scratch = makeScratch();
  try {
    await assert.rejects(isolate({
      target: src,
      runId: 'missing-base',
      scratchRoot: scratch,
      baseRef: 'does-not-exist',
      branch: 'planner/missing-base',
    }), /base ref "does-not-exist"/i);
    assert.equal(existsSync(join(scratch, 'missing-base', 'w')), false);
    const branch = await spawnCapture('git', [
      '-C', src, 'show-ref', '--verify', '--quiet', 'refs/heads/planner/missing-base',
    ]);
    assert.equal(branch.code, 1, 'a failed isolation must not create its branch at HEAD');
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('an already-existing branch fails rather than being reused or moved', async () => {
  const src = await makeRepo();
  const scratch = makeScratch();
  try {
    const original = await gitOk(src, 'rev-parse', 'HEAD');
    await gitOk(src, 'branch', 'planner/existing', original);
    await assert.rejects(isolate({
      target: src,
      runId: 'existing-branch',
      scratchRoot: scratch,
      branch: 'planner/existing',
    }), /branch "planner\/existing" already exists/i);
    assert.equal(await gitOk(src, 'rev-parse', 'planner/existing'), original,
      'the existing branch must not be force-moved');
    assert.equal(existsSync(join(scratch, 'existing-branch', 'w')), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('several concurrent isolations against one repository all succeed', async () => {
  const src = await makeRepo();
  const scratch = makeScratch();
  const runIds = Array.from({ length: 6 }, (_, index) => `concurrent-${index + 1}`);
  let isolations = [];
  try {
    isolations = await Promise.all(runIds.map((runId) => isolate({
      target: src,
      runId,
      scratchRoot: scratch,
      branch: `planner/${runId}`,
    })));
    assert.equal(isolations.length, runIds.length);
    assert.ok(isolations.every((iso) => existsSync(join(iso.dir, 'version.txt'))));
    assert.equal(new Set(isolations.map((iso) => iso.baseCommit)).size, 1,
      'all concurrent default isolations must resolve the same HEAD commit');
  } finally {
    await Promise.all(isolations.map((iso) => iso.cleanup()));
    rmSync(src, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
