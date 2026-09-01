import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { run as executeRun } from '../src/run.js';
import { withVerifiedSuperpowers } from '../fixtures/verified-superpowers.mjs';

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

async function captureWorktreeSnapshot({ cwd }) {
  return { cwd, files: filesIn(cwd) };
}

async function restoreWorktreeSnapshot({ snapshot, scope, prefix }) {
  const current = filesIn(snapshot.cwd);
  const changed = [...new Set([...snapshot.files.keys(), ...current.keys()])]
    .filter((path) => {
      const inside = path === prefix || path.startsWith(`${prefix}/`);
      return scope === 'inside' ? inside : !inside;
    })
    .filter((path) => {
      const before = snapshot.files.get(path);
      const after = current.get(path);
      return before === undefined || after === undefined || !before.equals(after);
    })
    .sort();
  for (const path of changed) {
    const target = join(snapshot.cwd, path);
    const before = snapshot.files.get(path);
    if (before === undefined) rmSync(target, { recursive: true, force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, before);
    }
  }
  return { restoredPaths: changed };
}

function harness(runId, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), `uro-${runId}-`));
  const target = join(root, 'target');
  const scratchRoot = join(root, 'scratch');
  mkdirSync(target, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });
  writeFileSync(join(target, 'seed.js'), 'export const seed = true;\n');

  const baseAdapters = {
    isolate: async () => ({
      dir: target,
      isRepo: true,
      source: 'repository',
      baseRef: 'HEAD',
      baseCommit: 'a'.repeat(40),
      branch: `uro/${runId}`,
    }),
    diffText: async () => 'diff --git a/seed.js b/seed.js\n',
    captureWorktreeSnapshot,
    restoreWorktreeSnapshot,
    runExecutor: async ({ cwd }) => {
      writeFileSync(join(cwd, 'implementation.js'), 'implemented\n');
      return { changedFiles: ['implementation.js'], lastMessage: 'implemented' };
    },
    runGate: async () => ({ passed: true, results: [] }),
    runReview: async () => ({ launchFailed: false, timedOut: false }),
    runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
  };
  return {
    root,
    target,
    options: withVerifiedSuperpowers({
      task: 'Implement the requested change.',
      target,
      gate: [{ bin: 'node', args: ['--test', 'test/original.test.js'] }],
      gateRetries: 0,
      scratchRoot,
      artifactRoot: join(root, 'artifacts'),
      runId,
      adapters: { ...baseAdapters, ...overrides.adapters },
      ...overrides.options,
    }),
  };
}

function writeReview(cwd, { id, severity = 'blocking', testFile }) {
  mkdirSync(join(cwd, '__uro_review', 'tests'), { recursive: true });
  if (testFile) writeFileSync(join(cwd, testFile), `proof for ${id}\n`);
  writeFileSync(join(cwd, '__uro_review', 'REVIEW.md'), `
## ${id}
Severity: ${severity}
Category: correctness
Description: ${id} proves the implementation is broken.
${testFile ? `Test: ${testFile}` : ''}
`);
}

test('review scope violations are restored and retained in events and run facts', async () => {
  const events = [];
  const fixture = harness('review-scope-facts', {
    options: { reporter: (event) => events.push(event) },
    adapters: {
      runReview: async ({ cwd }) => {
        writeFileSync(join(cwd, 'implementation.js'), 'reviewer changed implementation\n');
        writeFileSync(join(cwd, 'reviewer-extra.js'), 'outside scope\n');
        writeReview(cwd, { id: 'F1', severity: 'suggestion' });
        return { launchFailed: false, timedOut: false };
      },
    },
  });
  try {
    const facts = await executeRun(fixture.options);
    assert.equal(readFileSync(join(fixture.target, 'implementation.js'), 'utf8'), 'implemented\n');
    assert.equal(existsSync(join(fixture.target, 'reviewer-extra.js')), false);
    assert.deepEqual(facts.reviewProtection.reviewerRestorations[0].paths,
      ['implementation.js', 'reviewer-extra.js']);
    const violation = events.find((event) => event.type === 'scope_violation');
    assert.deepEqual(violation.paths, ['implementation.js', 'reviewer-extra.js']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a throwing review pass still restores and records its out-of-scope writes', async () => {
  const fixture = harness('review-throw-restores', {
    adapters: {
      runReview: async ({ cwd }) => {
        writeFileSync(join(cwd, 'implementation.js'), 'reviewer edit before failure\n');
        throw new Error('reviewer crashed');
      },
    },
  });
  try {
    const facts = await executeRun(fixture.options);
    assert.equal(facts.outcome, 'verifier-failed');
    assert.equal(facts.debate.stopReason, 'review-failed');
    assert.equal(readFileSync(join(fixture.target, 'implementation.js'), 'utf8'), 'implemented\n');
    assert.deepEqual(facts.reviewProtection.reviewerRestorations[0].paths,
      ['implementation.js']);
    assert.match(facts.iterations[0].reviewer.error, /reviewer crashed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('executor review-file restoration and reviewer tests accumulate across rounds', async () => {
  const gateCommands = [];
  let executorCall = 0;
  let reviewRound = 0;
  const fixture = harness('review-accumulates', {
    adapters: {
      runExecutor: async ({ cwd }) => {
        executorCall++;
        writeFileSync(join(cwd, 'implementation.js'), `implementation ${executorCall}\n`);
        if (executorCall === 2) {
          rmSync(join(cwd, '__uro_review', 'tests', 'f1.test.js'));
        }
        return { changedFiles: ['implementation.js'], lastMessage: 'implemented' };
      },
      runReview: async ({ cwd }) => {
        reviewRound++;
        if (reviewRound === 1) {
          writeReview(cwd, {
            id: 'F1', testFile: '__uro_review/tests/f1.test.js',
          });
        } else if (reviewRound === 2) {
          writeReview(cwd, {
            id: 'F2', testFile: '__uro_review/tests/f2.test.js',
          });
        } else writeReview(cwd, { id: 'F3', severity: 'suggestion' });
        return { launchFailed: false, timedOut: false };
      },
      runGate: async ({ commands }) => {
        gateCommands.push(commands.map((command) => ({ ...command, args: [...command.args] })));
        return { passed: true, results: [] };
      },
    },
  });
  try {
    const facts = await executeRun(fixture.options);
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(readFileSync(
      join(fixture.target, '__uro_review', 'tests', 'f1.test.js'), 'utf8'), 'proof for F1\n');
    assert.deepEqual(facts.reviewProtection.executorRestorations[0].paths,
      ['__uro_review/tests/f1.test.js']);
    assert.deepEqual(facts.reviewProtection.accumulatedTestFiles, [
      '__uro_review/tests/f1.test.js',
      '__uro_review/tests/f2.test.js',
    ]);
    assert.equal(gateCommands.length, 4);
    assert.deepEqual(gateCommands[0], [
      { bin: 'node', args: ['--test', 'test/original.test.js'] },
    ]);
    assert.deepEqual(gateCommands[1].at(-1), {
      bin: 'node',
      args: ['--test', 'test/original.test.js', '__uro_review/tests/f1.test.js'],
      harness: 'uro-review-tests',
    });
    assert.deepEqual(gateCommands[2].at(-1), {
      bin: 'node',
      args: [
        '--test', 'test/original.test.js',
        '__uro_review/tests/f1.test.js', '__uro_review/tests/f2.test.js',
      ],
      harness: 'uro-review-tests',
    });
    assert.deepEqual(gateCommands[3].at(-1), gateCommands[2].at(-1),
      'the converged implementation must still pass every accumulated reviewer test');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a failing reviewer test is evidence fed back to the executor through the debate', async () => {
  const plans = [];
  let gateCall = 0;
  let reviewRound = 0;
  const fixture = harness('review-gate-feedback', {
    options: { gateRetries: 1 },
    adapters: {
      runExecutor: async ({ cwd, plan }) => {
        plans.push(plan);
        writeFileSync(join(cwd, 'implementation.js'), `implementation ${plans.length}\n`);
        return { changedFiles: ['implementation.js'], lastMessage: 'implemented' };
      },
      runReview: async ({ cwd }) => {
        reviewRound++;
        if (reviewRound === 1) {
          writeReview(cwd, {
            id: 'F1', severity: 'blocking', testFile: '__uro_review/tests/f1.test.js',
          });
        } else if (reviewRound === 2) {
          // The reviewer's f1 test just exited 9; a second blocking finding
          // drives the fix round whose plan must carry that evidence.
          writeReview(cwd, {
            id: 'F2', severity: 'blocking', testFile: '__uro_review/tests/f2.test.js',
          });
        } else writeReview(cwd, { id: 'F3', severity: 'suggestion' });
        return { launchFailed: false, timedOut: false };
      },
      runGate: async ({ commands }) => {
        gateCall++;
        if (gateCall !== 2) return { passed: true, results: [] };
        const reviewerCommand = commands.at(-1);
        return {
          passed: false,
          results: [{ ...reviewerCommand, code: 9, outputTail: 'reviewer proof failed' }],
        };
      },
    },
  });
  try {
    const facts = await executeRun(fixture.options);
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(plans.length, 3);
    // The round-2 fix plan carries the reviewer test's non-zero exit as
    // evidence — name, code and tail — in front of the executor.
    assert.match(plans[2], /Previous gate attempt failed/);
    assert.match(plans[2], /__uro_review\/tests\/f1[.]test[.]js/);
    assert.match(plans[2], /reviewer proof failed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
