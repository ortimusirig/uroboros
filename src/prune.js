import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { resolveArtifact, resolveArtifactRoot } from './artifacts.js';
import { assertSafeScratchRoot } from './isolation.js';
import { physicalRunIdFor } from './run-id.js';
import { spawnCapture } from './spawn.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function createRunMarker({ scratchRoot, runId, target }) {
  try {
    const root = resolve(scratchRoot);
    assertSafeScratchRoot(root);
    const directory = join(root, physicalRunIdFor(runId));
    const marker = join(directory, '.uro-running');
    mkdirSync(directory, { recursive: true });
    writeFileSync(marker, JSON.stringify({
      runId,
      pid: process.pid,
      ...(typeof target === 'string' && target !== '' ? { target: resolve(target) } : {}),
    }), { flag: 'wx' });
    return marker;
  } catch {
    return null;
  }
}

export function releaseRunMarker(marker) {
  if (marker === null) return;
  try { unlinkSync(marker); } catch { /* best effort */ }
}

function normalizedPath(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function futureRealPath(path) {
  const missing = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(existing.slice(parent.length).replace(/^[/\\]+/, ''));
    existing = parent;
  }
  const canonical = existsSync(existing) ? realpathSync(existing) : existing;
  return normalizedPath(join(canonical, ...missing));
}

function containsPath(parent, child) {
  const fromParent = relative(normalizedPath(parent), normalizedPath(child));
  return fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent));
}

function overlapsArtifactRoot(directory, artifactRoot) {
  return containsPath(directory, artifactRoot) || containsPath(artifactRoot, directory);
}

function isLiveProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function isActiveRun(directory) {
  const marker = join(directory, '.uro-running');
  if (!existsSync(marker)) return false;
  try {
    const value = JSON.parse(readFileSync(marker, 'utf8'));
    return isLiveProcess(value?.pid);
  } catch {
    return true;
  }
}

function isCompletedRun(directory) {
  return existsSync(resolveArtifact(join(directory, 'w'), 'uro-runfacts.json'));
}

function metadataTarget(directory) {
  for (const path of [
    join(directory, '.uro-running'),
    resolveArtifact(join(directory, 'w'), 'uro-runfacts.json'),
  ]) {
    if (!existsSync(path)) continue;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      const target = typeof value?.targetPath === 'string' && value.targetPath !== ''
        ? value.targetPath
        : value?.target;
      if (typeof target === 'string' && target !== '' && isAbsolute(target)) {
        return futureRealPath(target);
      }
    } catch {
      // Invalid metadata cannot name a target path; active markers are retained separately.
    }
  }
  return null;
}

function protectedTargets(runDirectories) {
  return runDirectories.map(metadataTarget).filter((target) => target !== null);
}

function overlapsAnyTarget(directory, targets) {
  const canonical = futureRealPath(directory);
  return targets.some((target) => containsPath(canonical, target)
    || containsPath(target, canonical));
}

function registeredGitDir(worktree) {
  const dotGit = join(worktree, '.git');
  if (!existsSync(dotGit) || !lstatSync(dotGit).isFile()) return null;
  const match = /^gitdir:\s*(.+)\s*$/im.exec(readFileSync(dotGit, 'utf8'));
  if (!match) return null;
  return resolve(worktree, match[1]);
}

async function cleanupRegisteredWorktree(worktree) {
  const gitDir = registeredGitDir(worktree);
  if (gitDir === null) return false;
  const commonDir = dirname(dirname(gitDir));
  const removed = await spawnCapture('git', [
    '--git-dir', commonDir, 'worktree', 'remove', '--force', worktree,
  ]).catch(() => null);
  if (removed?.code !== 0) {
    try { rmSync(worktree, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); }
    catch { return true; }
  }
  await spawnCapture('git', [
    '--git-dir', commonDir, 'worktree', 'prune', '--expire', 'now',
  ]).catch(() => null);
  return true;
}

function validateRetentionNumber(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

export async function pruneScratch({
  scratchRoot,
  artifactRoot,
  env = process.env,
  keep = 20,
  olderThan,
  dryRun = false,
  now = Date.now(),
  cleanupWorktree = cleanupRegisteredWorktree,
}) {
  validateRetentionNumber(keep, 'keep');
  if (olderThan !== undefined) validateRetentionNumber(olderThan, 'olderThan');
  const resolvedRoot = resolve(scratchRoot);
  const root = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;
  assertSafeScratchRoot(root);
  if (normalizedPath(parse(root).root) === normalizedPath(root)) {
    throw new Error(`scratch filesystem root is forbidden: ${root}`);
  }
  const durableRoot = futureRealPath(resolveArtifactRoot({
    scratchRoot: root, artifactRoot, env,
  }));
  const entries = readdirSync(root, { withFileTypes: true });
  const runDirectories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => join(root, entry.name))
    .filter((directory) => existsSync(join(directory, 'w')));
  const targetPaths = protectedTargets(runDirectories);
  const runs = runDirectories
    .map((directory) => ({ directory, mtimeMs: statSync(directory).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs
      || left.directory.localeCompare(right.directory, 'en'));

  const threshold = olderThan === undefined ? null : now - olderThan * DAY_MS;
  const wouldRemove = runs
    .filter((run, index) => index >= keep && (threshold === null || run.mtimeMs < threshold))
    .filter(({ directory }) => !overlapsArtifactRoot(futureRealPath(directory), durableRoot))
    .filter(({ directory }) => !overlapsAnyTarget(directory, targetPaths))
    .filter(({ directory }) => isCompletedRun(directory) && !isActiveRun(directory))
    .map(({ directory }) => directory)
    .reverse();

  if (dryRun) {
    return { removed: 0, kept: runs.length, removedDirectories: [], wouldRemove };
  }

  const removedDirectories = [];
  for (const directory of wouldRemove) {
    if (!existsSync(directory)
      || lstatSync(directory).isSymbolicLink()
      || overlapsArtifactRoot(futureRealPath(directory), durableRoot)
      || overlapsAnyTarget(directory, protectedTargets(runDirectories.filter(existsSync)))
      || isActiveRun(directory)) continue;
    const worktree = join(directory, 'w');
    if (existsSync(worktree)) await cleanupWorktree(worktree);
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
      if (!existsSync(directory)) removedDirectories.push(directory);
    } catch {
      // A failed cleanup is kept and reported in the retained count.
    }
  }

  return {
    removed: removedDirectories.length,
    kept: runs.length - removedDirectories.length,
    removedDirectories,
    wouldRemove,
  };
}
