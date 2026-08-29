import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertCleanTarget,
  landQueueDiff,
  launchLoopRun,
  readRunFacts,
} from '../src/queue-runtime.js';

function scratch() {
  const directory = mkdtempSync(join(process.cwd(), '.ccc-test-queue-runtime-'));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('the production launcher composes loop run and accepts facts from a stopping exit', async () => {
  const calls = [];
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
  }, { runCommand, loopPath: 'C:/tools/loop.js', nodePath: 'C:/node.exe' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'C:/node.exe');
  assert.deepEqual(calls[0].args, [
    'C:/tools/loop.js',
    'run',
    '--task', 'C:/repo/plan.md',
    '--target', resolve('C:/repo'),
    '--gate', 'C:/repo/gate.json',
    '--mode', 'autonomous',
    '--quiet',
    '--no-dashboard',
  ]);
  assert.equal(calls[0].options.cwd, resolve('C:/repo'));
  assert.deepEqual(result, {
    runId: 'run-17',
    runDirectory: 'C:/scratch/run-17/w',
    exitCode: 1,
  });
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
  ]);
  assert.equal(calls[8].options.input, 'src/a.js\0docs/b.md\0');
  assert.deepEqual(result.paths, ['src/a.js', 'docs/b.md']);
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
  assert.equal(calls.at(-1).args.includes('--no-verify'), false);
  assert.equal(calls.at(-1).args.includes('--no-gpg-sign'), false);
  assert.equal(calls.at(-1).args.includes('--only'), true);
  assert.equal(calls.at(-1).options.input, 'src/old.js\0src/new.js\0');
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
