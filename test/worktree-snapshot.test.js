import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureWorktreeSnapshot,
  restoreWorktreeSnapshot,
} from '../src/worktree-snapshot.js';

test('Git snapshot restoration resets tracked state, cleans additions, and excludes allowed paths', async () => {
  const commands = [];
  let capture = 'before';
  const runGit = async (bin, args, options = {}) => {
    commands.push({ bin, args: [...args], options });
    const command = args[2];
    if (command === 'write-tree') {
      if (options.env?.GIT_INDEX_FILE) return { code: 0, stdout: `work-${capture}\n`, stderr: '' };
      return { code: 0, stdout: `index-${capture}\n`, stderr: '' };
    }
    if (command === 'diff' && args.includes('--diff-filter=A')) {
      return { code: 0, stdout: 'extra.js\0__uro_review/tests/kept.test.js\0', stderr: '' };
    }
    if (command === 'diff') {
      const from = args.at(-2);
      if (from === 'work-before') {
        return {
          code: 0,
          stdout: 'implementation.js\0extra.js\0__uro_review/tests/kept.test.js\0',
          stderr: '',
        };
      }
      return {
        code: 0,
        stdout: 'staged.js\0__uro_review/tests/kept.test.js\0',
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const snapshot = await captureWorktreeSnapshot({ cwd: 'C:/target', runGit, tempRoot: tmpdir() });
  capture = 'after';
  const restoration = await restoreWorktreeSnapshot({
    snapshot,
    scope: 'outside',
    prefix: '__uro_review',
    runGit,
    tempRoot: tmpdir(),
  });

  assert.deepEqual(restoration.restoredPaths, ['extra.js', 'implementation.js', 'staged.js']);
  const reset = commands.find(({ args }) => args[2] === 'reset');
  assert.deepEqual(reset.args.slice(-4), [
    '__uro_review/tests/kept.test.js', 'extra.js', 'implementation.js', 'staged.js',
  ]);
  const clean = commands.find(({ args }) => args[2] === 'clean');
  assert.deepEqual(clean.args.slice(-1), ['extra.js']);
  const restore = commands.find(({ args }) => args[2] === 'restore');
  assert.deepEqual(restore.args.slice(-2), ['implementation.js', 'staged.js']);
  assert.equal(clean.args.includes('__uro_review/tests/kept.test.js'), false);
  assert.equal(restore.args.includes('__uro_review/tests/kept.test.js'), false);
  const forcedAdds = commands.filter(({ args }) => args[2] === 'add');
  assert.ok(forcedAdds.length >= 2);
  assert.ok(forcedAdds.every(({ args }) => args.includes('-f')),
    'ignored files must be included in both worktree trees');
  const hasConfig = (options, key, value) => {
    const count = Number(options.env?.GIT_CONFIG_COUNT ?? 0);
    return Array.from({ length: count }, (_, index) => index).some((index) => (
      options.env[`GIT_CONFIG_KEY_${index}`] === key
        && options.env[`GIT_CONFIG_VALUE_${index}`] === value
    ));
  };
  assert.ok(forcedAdds.every(({ options }) => hasConfig(options, 'core.autocrlf', 'false')),
    'snapshot staging must preserve the worktree line endings');
  assert.ok(hasConfig(restore.options, 'core.autocrlf', 'false'),
    'snapshot restoration must preserve the captured line endings');
  assert.ok(clean.args.includes('-x'), 'ignored additions must be removable');
});

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

test('real Git restoration covers ignored files and empty directories', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'uro-real-git-snapshot-'));
  try {
    const initialized = git(cwd, ['init', '--quiet']);
    if (initialized.error?.code === 'EPERM') {
      t.skip('sandbox does not permit child-process Git integration tests');
      return;
    }
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(git(cwd, ['config', 'user.email', 'uro@example.invalid']).status, 0);
    assert.equal(git(cwd, ['config', 'user.name', 'Uro Test']).status, 0);
    writeFileSync(join(cwd, '.gitignore'), 'ignored/\n');
    writeFileSync(join(cwd, 'implementation.js'), 'original\n');
    mkdirSync(join(cwd, 'ignored'), { recursive: true });
    writeFileSync(join(cwd, 'ignored', 'existing.txt'), 'ignored original\n');
    mkdirSync(join(cwd, 'empty-before'));
    assert.equal(git(cwd, ['add', '.gitignore', 'implementation.js']).status, 0);
    assert.equal(git(cwd, ['commit', '--quiet', '-m', 'fixture']).status, 0);

    const snapshot = await captureWorktreeSnapshot({ cwd });
    writeFileSync(join(cwd, 'implementation.js'), 'reviewer edit\n');
    writeFileSync(join(cwd, 'ignored', 'existing.txt'), 'ignored edit\n');
    writeFileSync(join(cwd, 'ignored', 'new.txt'), 'ignored addition\n');
    rmSync(join(cwd, 'empty-before'), { recursive: true });
    mkdirSync(join(cwd, 'empty-after'));
    mkdirSync(join(cwd, '__uro_review', 'tests'), { recursive: true });
    writeFileSync(join(cwd, '__uro_review', 'tests', 'kept.test.js'), 'kept\n');

    const restored = await restoreWorktreeSnapshot({
      snapshot,
      scope: 'outside',
      prefix: '__uro_review',
    });

    assert.equal(readFileSync(join(cwd, 'implementation.js'), 'utf8'), 'original\n');
    assert.equal(readFileSync(join(cwd, 'ignored', 'existing.txt'), 'utf8'),
      'ignored original\n');
    assert.equal(existsSync(join(cwd, 'ignored', 'new.txt')), false);
    assert.equal(existsSync(join(cwd, 'empty-before')), true);
    assert.equal(existsSync(join(cwd, 'empty-after')), false);
    assert.equal(readFileSync(join(cwd, '__uro_review', 'tests', 'kept.test.js'), 'utf8'),
      'kept\n');
    for (const path of [
      'implementation.js', 'ignored/existing.txt', 'ignored/new.txt',
      'empty-before', 'empty-after',
    ]) assert.ok(restored.restoredPaths.includes(path), `${path} must be reported`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
