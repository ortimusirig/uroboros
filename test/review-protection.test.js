import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import {
  captureReviewSnapshot,
  restoreReviewSnapshot,
  runProtectedOperation,
} from '../src/review-protection.js';
import {
  captureWorktreeSnapshot,
  restoreWorktreeSnapshot,
} from '../src/worktree-snapshot.js';

function filesIn(root) {
  const files = new Map();
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        files.set(relative(root, path).split(sep).join('/'), readFileSync(path));
      }
    }
  };
  visit(root);
  return files;
}

function inScope(path, scope, prefix) {
  const inside = path === prefix || path.startsWith(`${prefix}/`);
  return scope === 'inside' ? inside : !inside;
}

async function captureSnapshot({ cwd }) {
  return { cwd, files: filesIn(cwd) };
}

async function restoreSnapshot({ snapshot, scope, prefix }) {
  const current = filesIn(snapshot.cwd);
  const paths = [...new Set([...snapshot.files.keys(), ...current.keys()])]
    .filter((path) => inScope(path, scope, prefix))
    .filter((path) => {
      const before = snapshot.files.get(path);
      const after = current.get(path);
      return before === undefined || after === undefined || !before.equals(after);
    })
    .sort();
  for (const path of paths) {
    const target = join(snapshot.cwd, path);
    const before = snapshot.files.get(path);
    if (before === undefined) rmSync(target, { recursive: true, force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, before);
    }
  }
  return { restoredPaths: paths };
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'uro-review-protection-'));
  writeFileSync(join(cwd, 'implementation.js'), 'original\n');
  return cwd;
}

test('review writes outside __uro_review are restored and reported by path', async () => {
  const cwd = fixture();
  const events = [];
  try {
    const protectedRun = await runProtectedOperation({
      cwd,
      scope: 'outside',
      prefix: '__uro_review',
      stage: 'verify',
      role: 'reviewer',
      runId: 'review-scope',
      reporter: (event) => events.push(event),
      captureSnapshot,
      restoreSnapshot,
      operation: async () => {
        writeFileSync(join(cwd, 'implementation.js'), 'reviewer edit\n');
        writeFileSync(join(cwd, 'extra.js'), 'not allowed\n');
        mkdirSync(join(cwd, '__uro_review', 'tests'), { recursive: true });
        writeFileSync(join(cwd, '__uro_review', 'REVIEW.md'), 'review\n');
        writeFileSync(join(cwd, '__uro_review', 'tests', 'proof.test.js'), 'proof\n');
        return { timedOut: false };
      },
    });

    assert.equal(readFileSync(join(cwd, 'implementation.js'), 'utf8'), 'original\n');
    assert.equal(existsSync(join(cwd, 'extra.js')), false);
    assert.equal(readFileSync(join(cwd, '__uro_review', 'REVIEW.md'), 'utf8'), 'review\n');
    assert.equal(readFileSync(join(cwd, '__uro_review', 'tests', 'proof.test.js'), 'utf8'),
      'proof\n');
    assert.deepEqual(protectedRun.restoredPaths, ['extra.js', 'implementation.js']);
    assert.deepEqual(events.map((event) => event.paths), [
      ['extra.js', 'implementation.js'],
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('review writes confined to __uro_review keep every file without a violation event', async () => {
  const cwd = fixture();
  const events = [];
  try {
    const protectedRun = await runProtectedOperation({
      cwd, scope: 'outside', prefix: '__uro_review', stage: 'verify', role: 'reviewer',
      runId: 'review-confined', reporter: (event) => events.push(event),
      captureSnapshot, restoreSnapshot,
      operation: async () => {
        mkdirSync(join(cwd, '__uro_review', 'tests', 'nested'), { recursive: true });
        writeFileSync(join(cwd, '__uro_review', 'REVIEW.md'), 'review\n');
        writeFileSync(join(cwd, '__uro_review', 'tests', 'proof.py'), 'proof\n');
        writeFileSync(join(cwd, '__uro_review', 'tests', 'nested', 'proof.js'), 'proof\n');
        return { timedOut: false };
      },
    });

    assert.deepEqual(protectedRun.restoredPaths, []);
    assert.equal(events.length, 0);
    for (const file of [
      '__uro_review/REVIEW.md',
      '__uro_review/tests/proof.py',
      '__uro_review/tests/nested/proof.js',
    ]) assert.equal(statSync(join(cwd, file)).isFile(), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('review restoration runs after a thrown launch and after a timeout result', async (t) => {
  for (const behavior of ['throw', 'timeout']) {
    await t.test(behavior, async () => {
      const cwd = fixture();
      try {
        const invocation = runProtectedOperation({
          cwd, scope: 'outside', prefix: '__uro_review', stage: 'verify', role: 'reviewer',
          runId: `review-${behavior}`, captureSnapshot, restoreSnapshot,
          operation: async () => {
            writeFileSync(join(cwd, 'implementation.js'), `${behavior} edit\n`);
            if (behavior === 'throw') throw new Error('review launch failed');
            return { timedOut: true };
          },
        });
        if (behavior === 'throw') await assert.rejects(invocation, /review launch failed/);
        else assert.equal((await invocation).result.timedOut, true);
        assert.equal(readFileSync(join(cwd, 'implementation.js'), 'utf8'), 'original\n');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});

test('executor deletion of a reviewer test is restored and reported', async () => {
  const cwd = fixture();
  const events = [];
  try {
    mkdirSync(join(cwd, '__uro_review', 'tests'), { recursive: true });
    const proof = join(cwd, '__uro_review', 'tests', 'proof.test.js');
    writeFileSync(proof, 'reviewer proof\n');

    const protectedRun = await runProtectedOperation({
      cwd, scope: 'inside', prefix: '__uro_review', stage: 'executor', role: 'executor',
      runId: 'executor-protection', reporter: (event) => events.push(event),
      captureSnapshot, restoreSnapshot,
      operation: async () => {
        rmSync(proof);
        return { changedFiles: [] };
      },
    });

    assert.equal(readFileSync(proof, 'utf8'), 'reviewer proof\n');
    assert.deepEqual(protectedRun.restoredPaths, ['__uro_review/tests/proof.test.js']);
    assert.deepEqual(events[0].paths, ['__uro_review/tests/proof.test.js']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('executor mode-only changes to reviewer tests are restored and reported', async (t) => {
  const cwd = fixture();
  const events = [];
  try {
    mkdirSync(join(cwd, '__uro_review', 'tests'), { recursive: true });
    const proof = join(cwd, '__uro_review', 'tests', 'proof.test.js');
    writeFileSync(proof, 'reviewer proof\n');
    chmodSync(proof, 0o600);
    const originalMode = statSync(proof).mode & 0o777;
    chmodSync(proof, 0o400);
    const changedMode = statSync(proof).mode & 0o777;
    chmodSync(proof, originalMode);
    if (changedMode === originalMode) {
      t.skip('this filesystem does not expose permission changes');
      return;
    }

    const protectedRun = await runProtectedOperation({
      cwd, scope: 'inside', prefix: '__uro_review', stage: 'executor', role: 'executor',
      runId: 'executor-mode-protection', reporter: (event) => events.push(event),
      captureSnapshot: captureReviewSnapshot,
      restoreSnapshot: restoreReviewSnapshot,
      operation: async () => {
        chmodSync(proof, 0o400);
        return { changedFiles: [] };
      },
    });

    assert.equal(statSync(proof).mode & 0o777, originalMode);
    assert.deepEqual(protectedRun.restoredPaths, ['__uro_review/tests/proof.test.js']);
    assert.deepEqual(events[0].paths, ['__uro_review/tests/proof.test.js']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

test('harness artifacts are invisible to the reviewer scope check', async (t) => {
  // The harness itself appends to events.jsonl (its own run log) while the reviewer
  // subprocess is in flight — that write must never be attributed to the reviewer and
  // rolled back; the peer session watched exactly that happen twice in live runs. This
  // exercises runProtectedOperation's real default (git-based) snapshot machinery, the
  // same path run.js uses for the reviewer's 'verify' stage, not the fs-diff test
  // doubles above. A genuinely out-of-scope reviewer write must still be restored.
  const cwd = mkdtempSync(join(tmpdir(), 'uro-harness-scope-'));
  try {
    const initialized = git(cwd, ['init', '--quiet']);
    if (initialized.error?.code === 'EPERM') {
      t.skip('sandbox does not permit child-process Git integration tests');
      return;
    }
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(git(cwd, ['config', 'user.email', 'uro@example.invalid']).status, 0);
    assert.equal(git(cwd, ['config', 'user.name', 'Uro Test']).status, 0);
    writeFileSync(join(cwd, 'implementation.js'), 'original\n');
    // events.jsonl exists but is deliberately never `git add`ed — the harness keeps its
    // run log out of the index for the whole run (see run.js's diffText/fresh-pivot clean).
    writeFileSync(join(cwd, 'events.jsonl'), '{"seed":true}\n');
    assert.equal(git(cwd, ['add', 'implementation.js']).status, 0);
    assert.equal(git(cwd, ['commit', '--quiet', '-m', 'fixture']).status, 0);

    const events = [];
    const protectedRun = await runProtectedOperation({
      cwd,
      scope: 'outside',
      prefix: '__uro_review',
      stage: 'verify',
      role: 'reviewer',
      runId: 'scope-harness',
      reporter: (event) => events.push(event),
      captureSnapshot: captureWorktreeSnapshot,
      restoreSnapshot: restoreWorktreeSnapshot,
      operation: async () => {
        appendFileSync(join(cwd, 'events.jsonl'), '{"appended":true}\n');
        mkdirSync(join(cwd, '__uro_review'), { recursive: true });
        writeFileSync(join(cwd, '__uro_review', 'REVIEW.md'), 'findings\n');
        writeFileSync(join(cwd, 'stray.txt'), 'out of scope\n');
        return { timedOut: false };
      },
    });

    assert.deepEqual(protectedRun.restoredPaths, ['stray.txt'], 'only the stray write is restored');
    assert.equal(existsSync(join(cwd, 'stray.txt')), false);
    assert.match(readFileSync(join(cwd, 'events.jsonl'), 'utf8'), /appended/,
      'the run log keeps its mid-run append');
    assert.equal(readFileSync(join(cwd, '__uro_review', 'REVIEW.md'), 'utf8'), 'findings\n');
    const violation = events.find((event) => event.type === 'scope_violation');
    assert.ok(violation, 'a genuine out-of-scope write is still reported');
    assert.deepEqual(violation.paths, ['stray.txt']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('executor empty-directory changes in reviewer output are restored and reported', async () => {
  const cwd = fixture();
  const events = [];
  try {
    const oldEmpty = join(cwd, '__uro_review', 'tests', 'old-empty');
    const newEmpty = join(cwd, '__uro_review', 'tests', 'new-empty');
    mkdirSync(oldEmpty, { recursive: true });

    const protectedRun = await runProtectedOperation({
      cwd, scope: 'inside', prefix: '__uro_review', stage: 'executor', role: 'executor',
      runId: 'executor-directory-protection', reporter: (event) => events.push(event),
      captureSnapshot: captureReviewSnapshot,
      restoreSnapshot: restoreReviewSnapshot,
      operation: async () => {
        rmSync(oldEmpty, { recursive: true });
        mkdirSync(newEmpty, { recursive: true });
        return { changedFiles: [] };
      },
    });

    assert.equal(statSync(oldEmpty).isDirectory(), true);
    assert.equal(existsSync(newEmpty), false);
    assert.ok(protectedRun.restoredPaths.includes('__uro_review/tests/old-empty'));
    assert.ok(protectedRun.restoredPaths.includes('__uro_review/tests/new-empty'));
    assert.deepEqual(events[0].paths, protectedRun.restoredPaths);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
