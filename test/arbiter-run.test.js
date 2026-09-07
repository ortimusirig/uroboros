import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../src/run.js';


const SUPERPOWERS = {
  seats: {
    codex: { verified: true, path: null },
    cursor: { verified: true, path: null },
    claude: { verified: true, path: null },
  },
};

const blocking = [
  '## F1',
  'Severity: blocking',
  'Category: correctness',
  'Description: The reviewer objection must be handled.',
  'Test: __uro_review/tests/f1.test.js',
].join('\n');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'arbiter-run-'));
  const work = join(root, 'work');
  const scratch = join(root, 'scratch');
  mkdirSync(work);
  mkdirSync(scratch);
  writeFileSync(join(work, 'seed.txt'), 'seed\n');
  return { root, work, scratch, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function verifierSequence(rounds) {
  let round = 0;
  return async ({ cwd }) => {
    const findings = rounds[round++] ?? '';
    mkdirSync(join(cwd, '__uro_review/tests'), { recursive: true });
    if (findings) writeFileSync(join(cwd, '__uro_review/tests/f1.test.js'), '// independent proof\n');
    writeFileSync(join(cwd, '__uro_review', 'REVIEW.md'),
      findings === '' ? 'Reviewed. No findings this round.\n' : findings);
    return { launchFailed: false, timedOut: false,
      dispositions: findings === '' && round > 1 ? [{ id: 'F1', status: 'resolved', reason: 'Codex corrected the reported behavior and evidence now covers it.' }] : [] };
  };
}

function baseOptions(item, overrides = {}) {
  let executorCalls = 0;
  const adapters = {
    isolate: async () => ({
      dir: item.work,
      isRepo: false,
      baseRef: 'HEAD',
      baseCommit: 'base',
      branch: 'test',
    }),
    diffText: async () => 'diff --git a/seed.txt b/seed.txt\n+changed\n',
    runExecutor: async () => {
      executorCalls++;
      writeFileSync(join(item.work, 'changed.txt'), `${executorCalls}\n`);
      return { changedFiles: ['changed.txt'], lastMessage: 'implemented', exitCode: 0 };
    },
    runGate: async () => ({ passed: true, results: [] }),
    ...overrides.adapters,
  };
  return {
    task: 'Implement the approved behavior.',
    target: item.work,
    gate: [],
    gateRetries: 0,
    mode: 'autonomous',
    scratchRoot: item.scratch,
    runId: `arbiter-${Math.random()}`,
    superpowers: SUPERPOWERS,
    ...overrides,
    adapters,
    executorCalls: () => executorCalls,
  };
}

test('Claude cannot overrule its own finding before Codex gets a response turn', async () => {
  const item = fixture();
  try {
    const options = baseOptions(item, {
      adapters: {
        captureWorktreeSnapshot: async ({ cwd }) => ({ cwd }),
        restoreWorktreeSnapshot: async () => ({ restoredPaths: [] }),
        runReview: verifierSequence([blocking]),
        runArbiter: async ({ request }) => request.type === 'finding'
          ? {
              verdict: 'invalid',
              reason: 'The alleged path is unreachable.',
              usage: {
                inputTokens: 7, cachedInputTokens: 2, outputTokens: 3,
                reasoningOutputTokens: 0, cacheWriteTokens: 1,
              },
            }
          : { decision: 'conclude' },
      },
    });
    const facts = await run(options);
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(options.executorCalls(), 2);
    assert.deepEqual(facts.debate.roundHistory[0].acceptedFindingIds, ['F1']);
    assert.deepEqual(facts.debate.resolvedFindingIds, ['F1']);
    assert.equal(Object.hasOwn(facts.tokens, 'arbiter'), false, 'no invented separate arbiter usage bucket');
  } finally { item.cleanup(); }
});

test('a conflicting review severity cannot let the execution controller close a blocker', async () => {
  const item = fixture();
  try {
    const facts = await run(baseOptions(item, { adapters: {
      captureWorktreeSnapshot: async ({ cwd }) => ({ cwd }),
      restoreWorktreeSnapshot: async () => ({ restoredPaths: [] }),
      runReview: verifierSequence([blocking + '\nSeverity: suggestion']),
    } }));
    assert.equal(facts.outcome, 'verifier-failed');
    assert.deepEqual(facts.debate.resolvedFindingIds, []);
    assert.match(facts.messages.find(message => message.speaker === 'claude').content, /review report/);
  } finally { item.cleanup(); }
});

test('valid and unavailable judgements preserve findings and drive or retain fix work', async () => {
  for (const available of [true, false]) {
    const item = fixture();
    try {
      const options = baseOptions(item, {
        debateRounds: available ? undefined : 1,
        adapters: {
          captureWorktreeSnapshot: async ({ cwd }) => ({ cwd }),
        restoreWorktreeSnapshot: async () => ({ restoredPaths: [] }),
        runReview: verifierSequence(available ? [blocking, ''] : [blocking]),
          ...(available ? { runArbiter: async () => ({ verdict: 'valid' }) } : {}),
        },
      });
      const facts = await run(options);
      assert.deepEqual(facts.debate.roundHistory[0].acceptedFindingIds, ['F1']);
      if (available) {
        assert.equal(facts.outcome, 'review-ready');
        assert.equal(options.executorCalls(), 2);
      } else {
        assert.equal(facts.debate.stopReason, 'rounds-exhausted');
        assert.equal(options.executorCalls(), 1);
      }
    } finally { item.cleanup(); }
  }
});

test('an uncapped debate runs past two rounds and a judged amend can converge', async () => {
  const item = fixture();
  try {
    const options = baseOptions(item, {
      adapters: {
        captureWorktreeSnapshot: async ({ cwd }) => ({ cwd }),
        restoreWorktreeSnapshot: async () => ({ restoredPaths: [] }),
        runReview: verifierSequence([blocking, blocking, blocking, '']),
        runArbiter: async ({ request }) => request.type === 'pivot'
          ? { decision: 'amend', reason: 'the latest remedy is promising' }
          : { verdict: 'valid' },
      },
    });
    const facts = await run(options);
    assert.equal(facts.outcome, 'review-ready');
    assert.equal(facts.debate.roundsRun, 4);
    assert.equal(options.executorCalls(), 4);
    assert.equal(facts.debate.pivotHistory[0].unjudged, false);
  } finally { item.cleanup(); }
});

test('unavailable Claude pivot judgment stops without inventing an authority ruling', async () => {
  const item = fixture();
  try {
    const options = baseOptions(item, {
      adapters: {
        captureWorktreeSnapshot: async ({ cwd }) => ({ cwd }),
        restoreWorktreeSnapshot: async () => ({ restoredPaths: [] }),
        runReview: verifierSequence([
          blocking, blocking, blocking, blocking, blocking,
        ]),
        createFreshPivotBranch: async ({ baseCommit, branch }) => ({
          branch,
          branchPoint: baseCommit,
          reviewPaths: [],
        }),
        draftPlanCandidate: async ({ candidateId }) => ({
          plan: `Fresh fallback plan from ${candidateId}.\n`,
          gate: [],
        }),
        
        selectPlanCandidate: async () => ({ selectedCandidateId: 'candidate-1' }),
      },
    });
    const facts = await run(options);
    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.roundsRun, 3);
    assert.deepEqual(facts.debate.pivotHistory, []);
    assert.equal(facts.debate.stopReason, 'reviewer-unavailable');
  } finally { item.cleanup(); }
});

test('the token budget is checked before dispatching a debate round', async () => {
  const item = fixture();
  try {
    const options = baseOptions(item, {
      tokenBudget: 5,
      adapters: {
        runExecutor: async () => ({
          changedFiles: ['changed.txt'], lastMessage: 'implemented', exitCode: 0,
          usage: {
            inputTokens: 5, cachedInputTokens: 0, outputTokens: 0,
            reasoningOutputTokens: 0, cacheWriteTokens: 0,
          },
        }),
        runReview: async () => { throw new Error('budget must stop before review'); },
      },
    });
    const facts = await run(options);
    assert.equal(facts.outcome, 'needs-pivot');
    assert.equal(facts.debate.stopReason, 'token-budget');
    assert.equal(facts.debate.roundsRun, 0);
  } finally { item.cleanup(); }
});

test('autonomous challenges use arbiter merits and unavailable arbitration needs a decision', async () => {
  for (const available of [true, false]) {
    const item = fixture();
    let calls = 0;
    try {
      const options = baseOptions(item, {
        mode: 'autonomous',
        adapters: {
          diffText: async () => calls < 2 ? '' : 'diff --git a/x b/x\n+done\n',
          runExecutor: async () => {
            calls++;
            if (calls === 1) {
              writeFileSync(join(item.work, 'DECISION.md'), [
                '## Q1',
                'Kind: technical',
                'Question: Which option?',
                'Options: A, B',
                'Recommendation: A',
                '',
              ].join('\n'));
              return { changedFiles: ['DECISION.md'], lastMessage: 'question', exitCode: 0 };
            }
            try { unlinkSync(join(item.work, 'DECISION.md')); } catch { /* harness normally removes it */ }
            return { changedFiles: ['done.txt'], lastMessage: 'done', exitCode: 0 };
          },
          captureWorktreeSnapshot: async ({ cwd }) => ({ cwd }),
        restoreWorktreeSnapshot: async () => ({ restoredPaths: [] }),
        runReview: verifierSequence(['']),
          ...(available ? { runArbiter: async () => ({ answer: 'B', reason: 'B fits the plan' }) } : {}),
        },
      });
      const facts = await run(options);
      if (available) {
        assert.equal(facts.outcome, 'review-ready');
        assert.equal(facts.decision.answers[0].answer, 'B');
      } else {
        assert.equal(facts.outcome, 'needs-pivot');
        assert.equal(calls, 1);
      }
    } finally { item.cleanup(); }
  }
});
