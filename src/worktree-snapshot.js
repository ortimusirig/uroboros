import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { spawnCapture } from './spawn.js';

function splitNull(value) {
  return String(value ?? '').split('\0').filter(Boolean);
}

async function checkedGit(runGit, cwd, args, options = {}) {
  const result = await runGit('git', ['-C', cwd, ...args], options);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed while protecting the worktree: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function exactWorktreeEnv(env = process.env) {
  const result = { ...env };
  const configuredCount = Number.parseInt(result.GIT_CONFIG_COUNT ?? '0', 10);
  const count = Number.isSafeInteger(configuredCount) && configuredCount >= 0
    ? configuredCount
    : 0;
  result.GIT_CONFIG_COUNT = String(count + 1);
  result[`GIT_CONFIG_KEY_${count}`] = 'core.autocrlf';
  result[`GIT_CONFIG_VALUE_${count}`] = 'false';
  return result;
}

async function worktreeTree({ cwd, runGit, tempRoot }) {
  const directory = mkdtempSync(join(tempRoot, 'uro-git-snapshot-'));
  const indexPath = join(directory, 'index');
  // The temporary index represents bytes that are already in the worktree. Do
  // not let a machine-wide core.autocrlf setting normalize them on the way in.
  const env = exactWorktreeEnv({ ...process.env, GIT_INDEX_FILE: indexPath });
  try {
    await checkedGit(runGit, cwd, ['read-tree', 'HEAD'], { env });
    // A normal `git add` omits ignored paths. Force-add them only to this
    // temporary index so ignored files participate in the exact tree snapshot.
    await checkedGit(runGit, cwd, ['add', '-A', '-f', '--', '.'], { env });
    return (await checkedGit(runGit, cwd, ['write-tree'], { env })).trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function directoryModes(cwd) {
  const directories = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      if (!entry.isDirectory()) continue;
      const absolute = join(directory, entry.name);
      const path = relative(cwd, absolute).split(sep).join('/');
      directories.set(path, statSync(absolute).mode & 0o7777);
      visit(absolute);
    }
  };
  if (existsSync(cwd)) visit(cwd);
  return directories;
}

export async function captureWorktreeSnapshot({
  cwd,
  runGit = spawnCapture,
  tempRoot = tmpdir(),
} = {}) {
  const indexTree = (await checkedGit(runGit, cwd, ['write-tree'])).trim();
  const capturedWorktreeTree = await worktreeTree({ cwd, runGit, tempRoot });
  return {
    cwd,
    indexTree,
    worktreeTree: capturedWorktreeTree,
    directoryModes: directoryModes(cwd),
  };
}

function selectedPaths(paths, scope, prefix) {
  return [...new Set(paths)].filter((path) => {
    const inside = path === prefix || path.startsWith(`${prefix}/`);
    return scope === 'inside' ? inside : !inside;
  }).sort();
}

export async function restoreWorktreeSnapshot({
  snapshot,
  scope,
  prefix,
  runGit = spawnCapture,
  tempRoot = tmpdir(),
} = {}) {
  if (!['inside', 'outside'].includes(scope)) throw new TypeError(`invalid snapshot scope: ${scope}`);
  const current = await captureWorktreeSnapshot({ cwd: snapshot.cwd, runGit, tempRoot });
  const worktreeChanged = splitNull(await checkedGit(runGit, snapshot.cwd, [
    'diff', '--no-renames', '--name-only', '-z', snapshot.worktreeTree, current.worktreeTree,
  ]));
  const indexChanged = splitNull(await checkedGit(runGit, snapshot.cwd, [
    'diff', '--no-renames', '--name-only', '-z', snapshot.indexTree, current.indexTree,
  ]));
  const directoryChanged = [...new Set([
    ...snapshot.directoryModes.keys(),
    ...current.directoryModes.keys(),
  ])].filter((path) => snapshot.directoryModes.get(path) !== current.directoryModes.get(path));
  const gitRestoredPaths = selectedPaths([...worktreeChanged, ...indexChanged], scope, prefix);
  const restoredDirectories = selectedPaths(directoryChanged, scope, prefix);
  const restoredPaths = [...new Set([...gitRestoredPaths, ...restoredDirectories])].sort();
  // The reviewer may keep files inside its allowed directory, but it may not keep Git
  // metadata changes there. Restoring every changed index path keeps harness artifacts
  // un-staged while the scope filter controls which working-tree files survive.
  const resetPaths = [...new Set([...gitRestoredPaths, ...indexChanged])].sort();
  if (restoredPaths.length === 0 && resetPaths.length === 0) return { restoredPaths };

  if (resetPaths.length > 0) {
    await checkedGit(runGit, snapshot.cwd, [
      'reset', '--quiet', snapshot.indexTree, '--', ...resetPaths,
    ]);
  }
  const addedPaths = new Set(splitNull(await checkedGit(runGit, snapshot.cwd, [
    'diff', '--no-renames', '--diff-filter=A', '--name-only', '-z',
    snapshot.worktreeTree, current.worktreeTree,
  ])));
  const removePaths = gitRestoredPaths.filter((path) => addedPaths.has(path));
  if (removePaths.length > 0) {
    await checkedGit(runGit, snapshot.cwd, ['clean', '-f', '-d', '-x', '--', ...removePaths]);
  }
  const existingPaths = gitRestoredPaths.filter((path) => !addedPaths.has(path));
  if (existingPaths.length > 0) {
    await checkedGit(runGit, snapshot.cwd, [
      'restore', `--source=${snapshot.worktreeTree}`, '--worktree', '--', ...existingPaths,
    ], { env: exactWorktreeEnv() });
  }
  const addedDirectories = restoredDirectories
    .filter((path) => !snapshot.directoryModes.has(path))
    .sort((left, right) => right.length - left.length);
  for (const path of addedDirectories) {
    rmSync(join(snapshot.cwd, path), { recursive: true, force: true });
  }
  const originalDirectories = restoredDirectories
    .filter((path) => snapshot.directoryModes.has(path))
    .sort((left, right) => left.length - right.length);
  for (const path of originalDirectories) mkdirSync(join(snapshot.cwd, path), { recursive: true });
  for (const path of originalDirectories) {
    chmodSync(join(snapshot.cwd, path), snapshot.directoryModes.get(path));
  }
  return { restoredPaths };
}
