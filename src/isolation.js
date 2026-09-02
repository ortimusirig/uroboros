import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { reportEvent } from './events.js';
import { spawnCapture } from './spawn.js';
import { physicalRunIdFor } from './run-id.js';

const repositoryLocks = new Map();

// Mirrors review-protection.js's HARNESS_ARTIFACT_PATTERNS: the same names the harness
// writes into a worktree it does not own the git history of. `git status` inside the
// isolated worktree must never list them as untracked — the executor seat has no way to
// tell they are the harness's own writes rather than stray output it forgot to add.
const HARNESS_GIT_EXCLUDE_MARKER = '# uroboros harness artifacts';
const HARNESS_GIT_EXCLUDE_BLOCK = `\n${HARNESS_GIT_EXCLUDE_MARKER} — not the seat's work\n`
  + 'TASK.md\nevents.jsonl\nCHANGES.diff\n__uro_review/\n';

// Containment check via canonicalPath (realpath-based, defined below) rather than a plain
// resolve(): a symlinked scratch root must still be recognized as containing its own
// resolved exclude path, or the hiding UX silently disappears for a tree the harness
// legitimately owns. Any throw here (a path that does not yet exist, a race, ...)
// propagates to excludeHarnessArtifacts's own try/catch and is treated as fail-closed — no
// write happens rather than guessing. Used only to gate excludeHarnessArtifacts below.
function isPathUnderRoot(candidate, root) {
  const fromRoot = relative(canonicalPath(root), canonicalPath(candidate));
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

export function defaultBranchName(runId) {
  return `uro/${runId}`;
}

export function assertSafeScratchRoot(root) {
  const segs = root.replace(/\\/g, '/').toLowerCase().split('/');
  for (const s of segs) {
    if (s === 'appdata') throw new Error(`scratch root under AppData is forbidden: ${root}`);
    if (s === 'onedrive' || s.startsWith('onedrive ') || s.startsWith('onedrive-')) {
      throw new Error(`scratch root under OneDrive is forbidden: ${root}`);
    }
  }
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

export function hashTree(dir) {
  const h = createHash('sha256');
  for (const rel of walk(dir)) {
    h.update(rel).update('\0').update(readFileSync(join(dir, rel))).update('\0');
  }
  return h.digest('hex');
}

async function git(cwd, ...args) {
  const r = await spawnCapture('git', ['-C', cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

// info/exclude is per-repository, not per-tree: for a linked worktree, `git --git-path`
// resolves it to the shared common .git dir (verified empirically) — so appending there
// unconditionally would mutate a repository the harness does not itself own whenever that
// shared dir is not something the harness created in scratch (the user's own repository,
// or a campaign base that reuses an already-existing repository as-is; see
// prepareCampaignBase). The harness must never mutate state it does not own, so this only
// writes when the resolved exclude path already lives under this run's own scratch root:
// a standalone copy's fresh `.git` always qualifies (it lives in scratch and is never
// shared with anything); a linked worktree only qualifies when its repository was itself
// created fresh in scratch. The skip applies to EVERY target that is already a git
// repository — that is the normal case (queue/batch against a real project, this repo
// dogfooding itself), not an edge case: hiding TASK.md/events.jsonl from `git status`
// exists only inside a tree whose .git the harness itself created under scratch, because
// providing it anywhere else would mutate a repository the harness does not own.
// merge.js's stageMergeChanges does not depend on this file for correctness either way.
// The marker check keeps repeated isolate() calls against one owned repository from
// growing the shared file without bound. A failure here is a `git status` UX nicety, not a
// run precondition, so it must not fail the isolation.
async function excludeHarnessArtifacts(dir, scratchRoot) {
  try {
    const excludePath = (await git(dir, 'rev-parse', '--git-path', 'info/exclude')).trim();
    const resolvedExclude = isAbsolute(excludePath) ? excludePath : join(dir, excludePath);
    if (!isPathUnderRoot(resolvedExclude, scratchRoot)) return;
    const existing = existsSync(resolvedExclude) ? readFileSync(resolvedExclude, 'utf8') : '';
    if (existing.includes(HARNESS_GIT_EXCLUDE_MARKER)) return;
    mkdirSync(dirname(resolvedExclude), { recursive: true });
    appendFileSync(resolvedExclude, HARNESS_GIT_EXCLUDE_BLOCK);
  } catch {
    // Best effort: see comment above.
  }
}

function canonicalPath(path) {
  const canonical = realpathSync(path);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function repositoryInfo(target) {
  const probe = await spawnCapture('git', ['-C', target, 'rev-parse', '--is-inside-work-tree']);
  if (probe.code !== 0) return null;

  const [gitDirResult, commonDirResult, superprojectResult] = await Promise.all([
    spawnCapture('git', ['-C', target, 'rev-parse', '--path-format=absolute', '--git-dir']),
    spawnCapture('git', ['-C', target, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
    spawnCapture('git', ['-C', target, 'rev-parse', '--show-superproject-working-tree']),
  ]);
  for (const result of [gitDirResult, commonDirResult, superprojectResult]) {
    if (result.code !== 0) {
      throw new Error(`cannot inspect git repository at ${target}: ${result.stderr.trim()}`);
    }
  }
  const gitDir = resolve(target, gitDirResult.stdout.trim());
  const commonDir = resolve(target, commonDirResult.stdout.trim());
  const isSubmodule = superprojectResult.stdout.trim() !== '';
  // A submodule can also report different git and common directories. Only classify a
  // linked worktree after ruling the submodule case out; both still lock on commonDir.
  const isLinkedWorktree = !isSubmodule && canonicalPath(gitDir) !== canonicalPath(commonDir);
  return {
    repository: target,
    commonDir,
    lockKey: canonicalPath(commonDir),
    isSubmodule,
    isLinkedWorktree,
  };
}

async function withRepositoryLock(key, action) {
  let release;
  const current = new Promise((resolveLock) => { release = resolveLock; });
  const previous = repositoryLocks.get(key);
  repositoryLocks.set(key, current);
  if (previous) await previous;
  try {
    return await action();
  } finally {
    release();
    if (repositoryLocks.get(key) === current) repositoryLocks.delete(key);
  }
}

async function validateBranchName(branch) {
  if (typeof branch !== 'string' || branch === '') {
    throw new TypeError('branch must be a non-empty string');
  }
  const result = await spawnCapture('git', ['check-ref-format', '--branch', branch]);
  if (result.code !== 0) throw new Error(`invalid branch name "${branch}"`);
}

async function resolveBaseCommit(repository, baseRef) {
  if (typeof baseRef !== 'string' || baseRef === '') {
    throw new TypeError('baseRef must be a non-empty string');
  }
  const result = await spawnCapture('git', [
    '-C', repository, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`,
  ]);
  if (result.code !== 0) {
    throw new Error(`base ref "${baseRef}" does not name an existing commit`);
  }
  return result.stdout.trim();
}

async function assertBranchAbsent(repository, branch) {
  const result = await spawnCapture('git', [
    '-C', repository, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`,
  ]);
  if (result.code === 0) throw new Error(`branch "${branch}" already exists`);
  if (result.code !== 1) {
    throw new Error(`cannot check branch "${branch}": ${result.stderr.trim()}`);
  }
}

async function cleanupWorktree(repositoryInfoValue, dir) {
  await withRepositoryLock(repositoryInfoValue.lockKey, async () => {
    // Git normally removes both the worktree and its w/w1/w2 administrative directory.
    // On Windows a lingering handle can make that removal return EPERM. Cleanup is
    // best-effort, but prune after a direct removal so stale administration cannot block
    // a later worktree add.
    let removed = false;
    for (let attempt = 0; attempt < 3 && !removed; attempt++) {
      const result = await spawnCapture('git', [
        '-C', repositoryInfoValue.repository, 'worktree', 'remove', '--force', dir,
      ]).catch(() => null);
      removed = result?.code === 0;
      if (!removed && attempt < 2) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)));
      }
    }
    if (!removed) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
      } catch {
        // The worktree contents are disposable and a lingering OS handle is transient.
      }
    }
    await spawnCapture('git', [
      '-C', repositoryInfoValue.repository, 'worktree', 'prune', '--expire', 'now',
    ]).catch(() => null);
  });
}

async function addWorktree({ repositoryInfoValue, dir, branch, baseRef }) {
  return withRepositoryLock(repositoryInfoValue.lockKey, async () => {
    await validateBranchName(branch);
    const baseCommit = await resolveBaseCommit(repositoryInfoValue.repository, baseRef);
    await assertBranchAbsent(repositoryInfoValue.repository, branch);
    const result = await spawnCapture('git', [
      '-C', repositoryInfoValue.repository,
      'worktree', 'add', '-b', branch, dir, baseCommit,
    ]);
    if (result.code !== 0) {
      // A failed add can leave an empty directory or a stale worktree record. Remove only
      // the path allocated for this run, then prune while the repository is still locked.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
      } catch {
        // Preserve the original, more useful git error below.
      }
      await spawnCapture('git', [
        '-C', repositoryInfoValue.repository, 'worktree', 'prune', '--expire', 'now',
      ]).catch(() => null);
      throw new Error(`git worktree add failed for branch "${branch}" from base ref "${baseRef}": ${result.stderr.trim()}`);
    }
    return baseCommit;
  });
}

export async function withDetachedWorktree({ repository, commit, dir, action }) {
  if (typeof action !== 'function') throw new TypeError('detached worktree action must be a function');
  const info = await repositoryInfo(repository);
  if (!info) throw new Error(`campaign base is not a git repository: ${repository}`);
  await withRepositoryLock(info.lockKey, async () => {
    const resolvedCommit = await resolveBaseCommit(repository, commit);
    const result = await spawnCapture('git', [
      '-C', repository, 'worktree', 'add', '--detach', dir, resolvedCommit,
    ]);
    if (result.code !== 0) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      await spawnCapture('git', [
        '-C', repository, 'worktree', 'prune', '--expire', 'now',
      ]).catch(() => null);
      throw new Error(`git detached worktree add failed for ${commit}: ${result.stderr.trim()}`);
    }
  });
  try {
    return await action(dir);
  } finally {
    await cleanupWorktree(info, dir);
  }
}

export async function prepareCampaignBase({ target, campaignId, scratchRoot }) {
  if (typeof campaignId !== 'string' || campaignId === '') {
    throw new TypeError('campaignId must be a non-empty string');
  }
  assertSafeScratchRoot(scratchRoot);
  const existingRepository = await repositoryInfo(target);
  if (existingRepository) {
    return {
      campaignId,
      repository: target,
      isRepo: true,
      source: 'git-worktree',
    };
  }

  const campaignDirectory = join(scratchRoot, campaignId);
  const baseDirectory = join(campaignDirectory, 'base');
  mkdirSync(campaignDirectory, { recursive: true });
  const sourcePath = canonicalPath(target);
  const campaignLockKey = `campaign-base:${canonicalPath(campaignDirectory)}`;
  return withRepositoryLock(campaignLockKey, async () => {
    if (existsSync(baseDirectory)) {
      const info = await repositoryInfo(baseDirectory);
      const [storedCampaign, storedSource] = info ? await Promise.all([
        spawnCapture('git', ['-C', baseDirectory, 'config', '--get', 'ccc.campaign-id']),
        spawnCapture('git', ['-C', baseDirectory, 'config', '--get', 'ccc.source-path']),
      ]) : [];
      if (!info
        || storedCampaign.code !== 0
        || storedSource.code !== 0
        || storedCampaign.stdout.trim() !== campaignId
        || storedSource.stdout.trim() !== sourcePath) {
        throw new Error(`campaign base for "${campaignId}" does not match target "${target}"`);
      }
      return {
        campaignId,
        repository: baseDirectory,
        isRepo: false,
        source: 'campaign-base-worktree',
      };
    }

    const stagingDirectory = join(campaignDirectory, `.base-${randomUUID()}`);
    try {
      cpSync(target, stagingDirectory, { recursive: true });
      await git(stagingDirectory, 'init', '-b', 'ccc-base');
      await git(stagingDirectory, 'config', 'ccc.campaign-id', campaignId);
      await git(stagingDirectory, 'config', 'ccc.source-path', sourcePath);
      await git(stagingDirectory, 'add', '-A');
      await git(
        stagingDirectory,
        '-c', 'user.email=ccc@local',
        '-c', 'user.name=ccc',
        'commit', '--allow-empty', '-m', `baseline for campaign ${campaignId}`,
      );
      renameSync(stagingDirectory, baseDirectory);
    } catch (error) {
      try { rmSync(stagingDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    }
    return {
      campaignId,
      repository: baseDirectory,
      isRepo: false,
      source: 'campaign-base-worktree',
    };
  });
}

export async function commitCampaignResult({ dir, branch, unitId }) {
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError('campaign result directory must be a non-empty string');
  }
  if (typeof branch !== 'string' || branch === '') {
    throw new TypeError('campaign result branch must be a non-empty string');
  }
  if (typeof unitId !== 'string' || unitId === '') {
    throw new TypeError('campaign result unitId must be a non-empty string');
  }
  const info = await repositoryInfo(dir);
  if (!info) throw new Error(`campaign result is not a git worktree: ${dir}`);

  return withRepositoryLock(info.lockKey, async () => {
    const currentBranch = (await git(dir, 'symbolic-ref', '--short', 'HEAD')).trim();
    if (currentBranch !== branch) {
      throw new Error(
        `campaign unit "${unitId}" expected result branch "${branch}", found "${currentBranch}"`,
      );
    }

    const staged = await spawnCapture('git', ['-C', dir, 'diff', '--cached', '--quiet', 'HEAD']);
    if (staged.code !== 0 && staged.code !== 1) {
      throw new Error(`cannot inspect campaign result for unit "${unitId}": ${staged.stderr.trim()}`);
    }
    if (staged.code === 1) {
      await git(
        dir,
        '-c', 'user.email=ccc@local',
        '-c', 'user.name=ccc',
        'commit', '-m', `campaign result for ${unitId}`,
      );
    }
    return (await git(dir, 'rev-parse', 'HEAD')).trim();
  });
}

export async function isolate({
  target,
  runId,
  physicalRunId: suppliedPhysicalRunId,
  scratchRoot,
  reporter,
  baseRef = 'HEAD',
  branch: suppliedBranch,
  branchName,
  correctsRunId,
  campaignId,
  campaignBase,
}) {
  if (suppliedBranch !== undefined && branchName !== undefined && suppliedBranch !== branchName) {
    throw new Error('branch and branchName must match when both are supplied');
  }
  const branch = suppliedBranch ?? branchName ?? defaultBranchName(runId);
  const physicalRunId = physicalRunIdFor(runId);
  if (suppliedPhysicalRunId !== undefined && suppliedPhysicalRunId !== physicalRunId) {
    throw new Error('physicalRunId must match the directory derived from runId');
  }
  reportEvent(reporter, runId, 'isolate', 'start', {
    source: target,
    baseRef,
    branch,
    ...(correctsRunId === undefined ? {} : { correctsRunId }),
  });
  assertSafeScratchRoot(scratchRoot);
  await validateBranchName(branch);
  const dir = join(scratchRoot, physicalRunId, 'w');
  if (campaignBase && campaignId !== undefined && campaignBase.campaignId !== campaignId) {
    throw new Error(`campaign base belongs to "${campaignBase.campaignId}", not "${campaignId}"`);
  }
  const resolvedCampaignBase = campaignBase ?? (campaignId === undefined
    ? undefined
    : await prepareCampaignBase({ target, campaignId, scratchRoot }));
  const targetRepository = resolvedCampaignBase
    ? await repositoryInfo(resolvedCampaignBase.repository)
    : await repositoryInfo(target);

  if (resolvedCampaignBase && !targetRepository) {
    throw new Error(`campaign base is not a git repository: ${resolvedCampaignBase.repository}`);
  }

  if (targetRepository) {
    const baseCommit = await addWorktree({
      repositoryInfoValue: targetRepository,
      dir,
      branch,
      baseRef,
    });
    // Same repository lock as addWorktree: info/exclude is shared repo state (see
    // excludeHarnessArtifacts above), and concurrent isolations of one repository must not
    // race a read-then-append of it.
    await withRepositoryLock(
      targetRepository.lockKey,
      () => excludeHarnessArtifacts(dir, scratchRoot),
    );
    const source = resolvedCampaignBase?.source ?? 'git-worktree';
    const isRepo = resolvedCampaignBase?.isRepo ?? true;
    reportEvent(reporter, runId, 'isolate', 'finish', {
      dir, source, baseRef, baseCommit, branch,
    });
    return {
      dir,
      isRepo,
      branch,
      baseRef,
      baseCommit,
      cleanup: async () => cleanupWorktree(targetRepository, dir),
    };
  }

  // A standalone non-repository isolation creates its first and only commit here, so HEAD
  // is the only possible base. Campaigns use prepareCampaignBase and the worktree path above.
  if (baseRef !== 'HEAD') {
    throw new Error(`base ref "${baseRef}" does not exist in non-repository target "${target}"`);
  }
  mkdirSync(dir, { recursive: true });
  cpSync(target, dir, { recursive: true });
  await git(dir, 'init', '-b', branch);
  // This dir is a brand-new standalone repository, wholly owned by this run, so no
  // repository lock is needed here (unlike the linked-worktree branch above).
  await excludeHarnessArtifacts(dir, scratchRoot);
  await git(dir, 'add', '-A');
  await git(dir, '-c', 'user.email=ccc@local', '-c', 'user.name=ccc', 'commit', '-m', 'baseline');
  const baseCommit = (await git(dir, 'rev-parse', 'HEAD')).trim();
  reportEvent(reporter, runId, 'isolate', 'finish', {
    dir, source: 'copy', baseRef, baseCommit, branch,
  });
  return {
    dir,
    isRepo: false,
    branch,
    baseRef,
    baseCommit,
    cleanup: async () => {
      try { rmSync(join(scratchRoot, physicalRunId), { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
