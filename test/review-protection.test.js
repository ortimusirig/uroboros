import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
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
