import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertCleanTarget,
  judgeGoalAcceptance,
  judgeLandingWithClaude,
  landQueueDiff,
  launchLoopPlan,
  launchLoopRun,
  readRunFacts,
} from '../src/queue-runtime.js';
import { EMPTY_USAGE } from '../src/usage.js';

function scratch() {
  const directory = mkdtempSync(join(process.cwd(), '.ccc-test-queue-runtime-'));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('the production launcher composes loop run and accepts facts from a stopping exit', async () => {
  const calls = [];
  const env = { CODEX_HOME: 'C:/registered-codex-home' };
  const runCommand = async (bin, args, options) => {
    calls.push({ bin, args, options });
    return {
      code: 1,
      stdout: JSON.stringify({ runId: 'run-17', dir: 'C:/scratch/run-17/w' }),
      stderr: '',
      timedOut: false,
    };
  };

  const result = await launchLoopRun({
    unit: { task: 'C:/repo/plan.md', gate: 'C:/repo/gate.json' },
    target: 'C:/repo',
    mode: 'autonomous',
  }, { runCommand, loopPath: 'C:/tools/loop.js', nodePath: 'C:/node.exe', env });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'C:/node.exe');
  assert.deepEqual(calls[0].args, [
    'C:/tools/loop.js',
    'run',
    '--task', 'C:/repo/plan.md',
    '--target', resolve('C:/repo'),
    '--gate', 'C:/repo/gate.json',
    '--mode', 'autonomous',
    '--no-dashboard',
  ]);
  // The child is NOT silenced, and its stderr streams through live — a queue
  // that buffers heartbeats until exit leaves the operator unable to tell
  // deliberation from a hang for the length of a unit.
  assert.equal(typeof calls[0].options.onStderr, 'function',
    'the launcher must forward the child heartbeat as it arrives');
  assert.equal(calls[0].options.cwd, resolve('C:/repo'));
  assert.equal(calls[0].options.env.CODEX_HOME, env.CODEX_HOME);
  assert.equal(calls[0].options.env.PATH, process.env.PATH);
  assert.deepEqual(result, {
    runId: 'run-17',
    runDirectory: 'C:/scratch/run-17/w',
    exitCode: 1,
  });
});

test('the production plan launcher composes loop plan and accepts non-convergence', async () => {
  const calls = [];
  const env = { CODEX_HOME: 'C:/registered-plan-home' };
  const runCommand = async (bin, args, options) => {
    calls.push({ bin, args, options });
    return {
      code: 1,
      stdout: JSON.stringify({ converged: false, rounds: 3, reason: 'rounds-exhausted' }),
      stderr: '',
    };
  };
  const result = await launchLoopPlan({
    unit: { goal: 'Improve the parser', out: 'C:/plans/x' },
    target: 'C:/repo',
  }, { runCommand, loopPath: 'C:/tools/loop.js', nodePath: 'C:/node.exe', env });

  assert.deepEqual(calls[0].args, [
    'C:/tools/loop.js', 'plan', '--goal', 'Improve the parser',
    '--target', resolve('C:/repo'), '--out', 'C:/plans/x',
  ]);
  assert.equal(calls[0].options.cwd, resolve('C:/repo'));
  assert.equal(calls[0].options.env.CODEX_HOME, env.CODEX_HOME);
  assert.equal(calls[0].options.env.PATH, process.env.PATH);
  assert.equal(result.converged, false);
  assert.equal(result.exitCode, 1);
});

test('the production launcher refuses output that cannot identify completed run facts', async () => {
  await assert.rejects(
    launchLoopRun({
      unit: { task: 'plan.md', gate: 'gate.json' },
      target: process.cwd(),
      mode: 'manual',
    }, {
      runCommand: async () => ({ code: 3, stdout: '', stderr: 'fatal launch', timedOut: false }),
      loopPath: 'loop.js',
      nodePath: 'node',
    }),
    /loop run did not return readable facts.*fatal launch/,
  );
});

test('completed run facts are re-read from uro-runfacts.json', async () => {
  const fixture = scratch();
  try {
    const runDirectory = join(fixture.directory, 'run', 'w');
    mkdirSync(runDirectory, { recursive: true });
    const facts = { runId: 'run-1', outcome: 'review-ready' };
    writeFileSync(join(runDirectory, 'uro-runfacts.json'), JSON.stringify(facts));

    assert.deepEqual(readRunFacts({ runDirectory }), facts);
  } finally {
    fixture.cleanup();
  }
});

test('clean-tree inspection rejects dirty output and Git inspection failures', async () => {
  await assert.doesNotReject(assertCleanTarget('C:/repo', {
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
  }));

  await assert.doesNotReject(assertCleanTarget('C:/repo', {
    allowedPaths: ['C:/repo/queue-log.jsonl'],
    runCommand: async () => ({ code: 0, stdout: '?? queue-log.jsonl\0', stderr: '' }),
  }));

  await assert.rejects(assertCleanTarget('C:/repo', {
    allowedPaths: ['C:/repo/queue-log.jsonl'],
    runCommand: async () => ({ code: 0, stdout: ' M queue-log.jsonl\0', stderr: '' }),
  }), /target working tree is dirty.*queue-log[.]jsonl/);

  await assert.rejects(assertCleanTarget('C:/repo', {
    allowedPaths: ['C:/repo/queue-log.jsonl'],
    runCommand: async () => ({ code: 0, stdout: '?? queue-log.jsonl\0?? local.txt\0', stderr: '' }),
  }), /target working tree is dirty.*local[.]txt/);

  await assert.rejects(assertCleanTarget('C:/repo', {
    runCommand: async () => ({ code: 0, stdout: '?? local.txt\0', stderr: '' }),
  }), /target working tree is dirty.*local[.]txt/);

  await assert.rejects(assertCleanTarget('C:/repo', {
    runCommand: async () => ({ code: 128, stdout: '', stderr: 'not a repository' }),
  }), /cannot inspect target working tree.*not a repository/);
});

test('landing checks first, applies to the index, and commits only touched paths', async () => {
  const calls = [];
  const responses = [
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\u00001\t0\tdocs/b.md\0', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\u00001\t0\tdocs/b.md\0', stderr: '' },
    { code: 0, stdout: 'src/a.js\0docs/b.md\0', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\u00001\t0\tdocs/b.md\0', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '[main abc123] queue commit\n', stderr: '' },
    { code: 0, stdout: '9f1c0de6a4b2c8d0e1f2a3b4c5d6e7f8091a2b3c\n', stderr: '' },
  ];
  const runCommand = async (bin, args, options = {}) => {
    calls.push({ bin, args, options });
    return responses.shift();
  };

  const result = await landQueueDiff({
    target: 'C:/repo',
    diffPath: 'C:/scratch/run/CHANGES.diff',
    unit: { name: 'plan x' },
    runId: 'run-9',
    allowedDirtyPaths: ['C:/repo/queue-log.jsonl'],
  }, { runCommand });

  assert.deepEqual(calls.map(({ args }) => args), [
    ['-C', resolve('C:/repo'), 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    ['-C', resolve('C:/repo'), 'apply', '--numstat', '-z', '--', 'C:/scratch/run/CHANGES.diff'],
    ['-C', resolve('C:/repo'), 'apply', '--check', '--index', '--', 'C:/scratch/run/CHANGES.diff'],
    ['-C', resolve('C:/repo'), 'apply', '--index', '--', 'C:/scratch/run/CHANGES.diff'],
    ['-C', resolve('C:/repo'), 'diff', '--cached', '--numstat', '-z', '--find-renames'],
    ['-C', resolve('C:/repo'), 'diff', '--cached', '--name-only', '-z', '--find-renames'],
    ['-C', resolve('C:/repo'), 'diff', '--cached', '--numstat', '-z', '--find-renames'],
    ['-C', resolve('C:/repo'), 'apply', '--check', '--reverse', '--index', '--',
      'C:/scratch/run/CHANGES.diff'],
    [
      '-C', resolve('C:/repo'), 'commit', '--only', '-m', 'queue: land plan x (run-9)',
      '--pathspec-from-file=-', '--pathspec-file-nul',
    ],
    ['-C', resolve('C:/repo'), 'rev-parse', 'HEAD'],
  ]);
  assert.equal(calls[8].options.input, 'src/a.js\0docs/b.md\0');
  assert.deepEqual(result.paths, ['src/a.js', 'docs/b.md']);
  // The landed commit SHA is the queue log's audit trail and the acceptance
  // review's diff base, so it travels back with the paths.
  assert.equal(result.commit, '9f1c0de6a4b2c8d0e1f2a3b4c5d6e7f8091a2b3c');
});

test('landing accepts Git rename numstat records while still comparing the new path', async () => {
  const calls = [];
  const stagedRename = '0\t0\t\0src/old.js\0src/new.js\0';
  const responses = [
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '0\t0\tsrc/new.js\0', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: stagedRename, stderr: '' },
    { code: 0, stdout: 'src/old.js\0src/new.js\0', stderr: '' },
    { code: 0, stdout: stagedRename, stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '[main abc123] queue commit\n', stderr: '' },
    { code: 0, stdout: '5c4b3a29187f6e5d4c3b2a1908f7e6d5c4b3a291\n', stderr: '' },
  ];
  const runCommand = async (bin, args, options = {}) => {
    calls.push({ bin, args, options });
    return responses.shift();
  };

  const result = await landQueueDiff({
    target: 'C:/repo',
    diffPath: 'C:/scratch/run/CHANGES.diff',
    unit: { name: 'rename plan' },
    runId: 'run-rename',
  }, { runCommand });

  assert.deepEqual(result.paths, ['src/old.js', 'src/new.js']);
  const commitCall = calls.at(-2);
  assert.equal(commitCall.args.includes('--no-verify'), false);
  assert.equal(commitCall.args.includes('--no-gpg-sign'), false);
  assert.equal(commitCall.args.includes('--only'), true);
  assert.equal(commitCall.options.input, 'src/old.js\0src/new.js\0');
});

test('the commit a real landing creates is the SHA it reports back', async () => {
  const { directory, cleanup } = scratch();
  const root = join(directory, 'repo');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    stdio: 'pipe', encoding: 'utf8',
  });
  try {
    mkdirSync(root);
    git('init', '-q');
    git('config', 'user.email', 'queue-runtime@example.test');
    git('config', 'user.name', 'uro queue test');
    writeFileSync(join(root, 'a.txt'), 'one\n');
    git('add', '--', 'a.txt');
    git('commit', '-qm', 'base');
    const before = git('rev-parse', 'HEAD').trim();

    // A real patch, produced by Git itself, then restored so the tree is clean
    // again — exactly the shape landQueueDiff receives from a completed run.
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
    const patch = git('diff', '--', 'a.txt');
    git('checkout', '--', 'a.txt');
    const diffPath = join(directory, 'CHANGES.diff');
    writeFileSync(diffPath, patch);

    // No injected runCommand: this exercises the production Git path.
    const result = await landQueueDiff({
      target: root, diffPath, unit: { name: 'unit-1' }, runId: 'run-real',
    });

    const head = git('rev-parse', 'HEAD').trim();
    assert.notEqual(head, before, 'positive control: the landing must create a commit');
    assert.equal(result.commit, head, 'the reported SHA is the commit the landing created');
    assert.deepEqual(result.paths, ['a.txt']);
    assert.match(git('log', '-1', '--pretty=%s'), /queue: land unit-1 \(run-real\)/);
  } finally {
    cleanup();
  }
});

test('a commit failure reverses the applied patch before reporting the stop', async () => {
  const calls = [];
  const responses = [
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\0', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\0', stderr: '' },
    { code: 0, stdout: 'src/a.js\0', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\0', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 1, stdout: '', stderr: 'identity missing' },
    { code: 0, stdout: '', stderr: '' },
  ];
  const runCommand = async (bin, args, options = {}) => {
    calls.push({ bin, args, options });
    return responses.shift();
  };

  await assert.rejects(landQueueDiff({
    target: 'C:/repo',
    diffPath: 'C:/scratch/run/CHANGES.diff',
    unit: { name: 'plan x' },
    runId: 'run-9',
  }, { runCommand }), /queue commit failed.*identity missing/);

  assert.deepEqual(calls.at(-1).args, [
    '-C', resolve('C:/repo'), 'apply', '--reverse', '--index', '--',
    'C:/scratch/run/CHANGES.diff',
  ]);
});

test('a rollback failure reports that manual recovery is required', async () => {
  const responses = [
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\0', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\0', stderr: '' },
    { code: 0, stdout: 'src/a.js\0', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\0', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 1, stdout: '', stderr: 'identity missing' },
    { code: 1, stdout: '', stderr: 'reverse conflict' },
  ];

  await assert.rejects(landQueueDiff({
    target: 'C:/repo',
    diffPath: 'C:/scratch/run/CHANGES.diff',
    unit: { name: 'plan x' },
    runId: 'run-9',
  }, {
    runCommand: async () => responses.shift(),
  }), /rollback failed.*reverse conflict.*manual recovery required.*git status.*CHANGES[.]diff/i);
});

test('an unexpected staged path stops and rolls back before commit', async () => {
  const calls = [];
  const responses = [
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\0', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\u00001\t0\tsecrets.txt\0', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
  ];
  const runCommand = async (bin, args, options = {}) => {
    calls.push({ bin, args, options });
    return responses.shift();
  };

  await assert.rejects(landQueueDiff({
    target: 'C:/repo',
    diffPath: 'C:/scratch/run/CHANGES.diff',
    unit: { name: 'plan x' },
    runId: 'run-9',
  }, { runCommand }), /staged changes do not exactly match the queue diff/);

  assert.equal(calls.some(({ args }) => args.includes('commit')), false);
  assert.deepEqual(calls.at(-1).args.slice(2, 5), ['apply', '--reverse', '--index']);
});

test('a failed dry-run apply check performs no mutating Git command', async () => {
  const calls = [];
  const responses = [
    { code: 0, stdout: '', stderr: '' },
    { code: 0, stdout: '1\t0\tsrc/a.js\0', stderr: '' },
    { code: 1, stdout: '', stderr: 'patch does not apply' },
  ];
  await assert.rejects(landQueueDiff({
    target: 'C:/repo',
    diffPath: 'C:/scratch/run/CHANGES.diff',
    unit: { name: 'plan x' },
    runId: 'run-9',
  }, {
    runCommand: async (bin, args) => {
      calls.push({ bin, args });
      return responses.shift();
    },
  }), /diff does not apply cleanly.*patch does not apply/);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args.slice(2, 5), ['apply', '--check', '--index']);
});

test('judgeLandingWithClaude hands Claude the composed task, diff, findings, and evidence', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.ccc-test-landing-'));
  try {
    writeFileSync(join(directory, 'TASK.md'), 'Composed task exactly as executed.');
    writeFileSync(join(directory, 'CHANGES.diff'), 'diff --git a/x b/x');
    const requests = [];
    const judgement = await judgeLandingWithClaude({
      unit: { name: 'unit-1' },
      facts: {
        debate: { roundHistory: [{ findings: [{ id: 'F1', severity: 'suggestion', description: 'nit' }] }] },
        evidence: [
          { bin: 'node', code: 0, excerpt: 'fine' },
          { bin: 'npm', code: 2, excerpt: 'lint failed' },
        ],
      },
      runDirectory: directory,
    }, {
      arbiter: async ({ request }) => {
        requests.push(request);
        return { approved: true, reasoning: 'verified the diff first-hand' };
      },
    });
    assert.deepEqual(judgement, {
      approved: true, reasoning: 'verified the diff first-hand', findings: [],
    });
    assert.equal(requests[0].type, 'landing');
    assert.equal(requests[0].task, 'Composed task exactly as executed.');
    assert.equal(requests[0].diff, 'diff --git a/x b/x');
    assert.deepEqual(requests[0].findings.map((finding) => finding.id), ['F1']);
    assert.deepEqual(requests[0].evidence.map((entry) => entry.bin), ['npm'],
      'only non-zero exits travel as landing evidence');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('judgeLandingWithClaude treats an unreachable or unreadable arbiter as not-approved', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.ccc-test-landing-down-'));
  try {
    const thrown = await judgeLandingWithClaude({
      unit: { name: 'unit-1' }, facts: {}, runDirectory: directory,
    }, { arbiter: async () => { throw new Error('spawn claude ENOENT'); } });
    assert.equal(thrown.approved, null);
    assert.match(thrown.reasoning, /ENOENT/);

    const unreadable = await judgeLandingWithClaude({
      unit: { name: 'unit-1' }, facts: {}, runDirectory: directory,
    }, { arbiter: async () => ({ answer: 'sure, ship it' }) });
    assert.equal(unreadable.approved, null,
      'prose without a readable approval boolean is never consent');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The tier-1 layout the acceptance review reads from:
//   <project>/constitution.md
//   <project>/goals/G1-first/spec.md
function goalWorkspace(withConstitution = true) {
  const { directory, cleanup } = scratch();
  const project = join(directory, 'uro-project');
  const goalDirectory = join(project, 'goals', 'G1-first');
  mkdirSync(goalDirectory, { recursive: true });
  writeFileSync(join(goalDirectory, 'spec.md'), '# Goal 1\n\nDeliver the capability.\n');
  if (withConstitution) {
    writeFileSync(join(project, 'constitution.md'), 'The project constitution stands.\n');
  }
  return {
    directory,
    cleanup,
    goalSpecPath: join(goalDirectory, 'spec.md'),
    target: join(directory, 'repo'),
    logPath: join(directory, 'queue-log.jsonl'),
  };
}

test('judgeGoalAcceptance hands Claude the spec, constitution, aggregate diff, and log rows', async () => {
  const workspace = goalWorkspace();
  try {
    writeFileSync(workspace.logPath, `${[
      JSON.stringify({ name: 'unit-1', landed: true, commit: 'aaaa111' }),
      JSON.stringify({ name: 'unit-2', landed: false }),
      'this line is not JSON and must not stop the review',
      JSON.stringify({ name: 'unit-2', landed: true, commit: 'bbbb222' }),
    ].join('\n')}\n`);
    const calls = [];
    const requests = [];
    const judgement = await judgeGoalAcceptance(workspace, {
      runCommand: async (bin, args) => {
        calls.push({ bin, args });
        return { code: 0, stdout: 'diff --git a/x b/x\n+capability\n', stderr: '' };
      },
      arbiter: async ({ request }) => {
        requests.push(request);
        return {
          approved: true,
          reasoning: 'the tree delivers the goal',
          findings: [{ id: 'A1', severity: 'P2', text: 'a note, not a blocker' }],
          usage: { inputTokens: 90, cachedInputTokens: 10, outputTokens: 15 },
        };
      },
    });

    // The base is the PARENT of the EARLIEST landed commit, so a goal finished
    // across several invocations still gets its complete aggregate diff.
    assert.deepEqual(calls, [{
      bin: 'git',
      args: ['-C', resolve(workspace.target), 'diff', 'aaaa111^..HEAD'],
    }]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].type, 'acceptance');
    assert.match(requests[0].goalSpec, /Deliver the capability/);
    assert.match(requests[0].constitution, /constitution stands/);
    assert.equal(requests[0].diff, 'diff --git a/x b/x\n+capability\n');
    assert.deepEqual(requests[0].queueLog.map((row) => row.commit),
      ['aaaa111', undefined, 'bbbb222']);
    assert.deepEqual(judgement, {
      approved: true,
      reasoning: 'the tree delivers the goal',
      findings: [{ id: 'A1', severity: 'P2', text: 'a note, not a blocker' }],
      usage: { inputTokens: 90, cachedInputTokens: 10, outputTokens: 15 },
    });
  } finally { workspace.cleanup(); }
});

test('goal acceptance without a constitution still asks, and no readable answer is never consent', async () => {
  const workspace = goalWorkspace(false);
  try {
    writeFileSync(workspace.logPath,
      `${JSON.stringify({ name: 'unit-1', landed: true, commit: 'aaaa111' })}\n`);
    const runCommand = async () => ({ code: 0, stdout: 'diff --git a/x b/x\n', stderr: '' });

    const requests = [];
    const unreadable = await judgeGoalAcceptance(workspace, {
      runCommand,
      arbiter: async ({ request }) => {
        requests.push(request);
        return { answer: 'looks finished to me' };
      },
    });
    assert.equal(requests[0].constitution, '',
      'an absent constitution is empty, and the prompt drops its line');
    assert.equal(unreadable.approved, null,
      'prose without a readable approval boolean is never consent');

    const thrown = await judgeGoalAcceptance(workspace, {
      runCommand,
      arbiter: async () => { throw new Error('spawn claude ENOENT'); },
    });
    assert.equal(thrown.approved, null);
    assert.match(thrown.reasoning, /ENOENT/);
    assert.deepEqual(thrown.usage, EMPTY_USAGE);
  } finally { workspace.cleanup(); }
});

test('goal acceptance refuses to judge a goal with no landed commit trail', async () => {
  const workspace = goalWorkspace();
  try {
    writeFileSync(workspace.logPath,
      `${JSON.stringify({ name: 'unit-1', landed: false })}\n`);
    let arbiterCalls = 0;
    let gitCalls = 0;
    const judgement = await judgeGoalAcceptance(workspace, {
      runCommand: async () => { gitCalls++; return { code: 0, stdout: '', stderr: '' }; },
      arbiter: async () => { arbiterCalls++; return { approved: true, reasoning: 'sure' }; },
    });
    assert.equal(judgement.approved, null);
    assert.match(judgement.reasoning, /no landed commit/i);
    assert.equal(arbiterCalls, 0, 'there is nothing first-hand to read, so nothing is asked');
    assert.equal(gitCalls, 0);
  } finally { workspace.cleanup(); }
});
