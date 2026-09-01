import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { spawnCapture } from './spawn.js';
import { parseLandingJudgement, runArbiter } from './arbiter.js';

const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_LOOP_PATH = fileURLToPath(new URL('../bin/loop.js', import.meta.url));

function launchEnvironment(env) {
  return { ...process.env, ...(env ?? {}) };
}

function messageFrom(result, fallback) {
  return (result?.stderr || result?.stdout || '').trim() || fallback;
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

export async function launchLoopRun({ unit, target, mode }, {
  runCommand = spawnCapture,
  loopPath = DEFAULT_LOOP_PATH,
  nodePath = process.execPath,
  env,
} = {}) {
  const resolvedTarget = resolve(target);
  const result = await runCommand(nodePath, [
    loopPath,
    'run',
    '--task', unit.task,
    '--target', resolvedTarget,
    '--gate', unit.gate,
    '--mode', mode,
    '--no-dashboard',
  ], {
    cwd: resolvedTarget,
    env: launchEnvironment(env),
    // The child's stderr heartbeat streams through LIVE. Buffered-until-exit
    // meant 25-50 silent minutes per unit: an operator could not tell deep
    // deliberation from a hang and babysat by polling artifacts instead.
    onStderr: (chunk) => { process.stderr.write(chunk); },
  });

  let facts;
  try {
    facts = JSON.parse(result.stdout);
  } catch {
    const detail = messageFrom(result, 'no JSON was written to stdout');
    throw new Error(`loop run did not return readable facts: ${detail}`);
  }
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)
    || typeof facts.runId !== 'string' || facts.runId === ''
    || typeof facts.dir !== 'string' || facts.dir === '') {
    throw new Error('loop run did not return readable facts: runId or run directory is missing');
  }
  return {
    runId: facts.runId,
    runDirectory: facts.dir,
    exitCode: result.code,
  };
}

export async function launchLoopPlan({ unit, target }, {
  runCommand = spawnCapture,
  loopPath = DEFAULT_LOOP_PATH,
  nodePath = process.execPath,
  env,
} = {}) {
  const resolvedTarget = resolve(target);
  const result = await runCommand(nodePath, [
    loopPath,
    'plan',
    '--goal', unit.goal,
    '--target', resolvedTarget,
    '--out', unit.out,
  ], {
    cwd: resolvedTarget,
    env: launchEnvironment(env),
    // Planning heartbeats stream through live, same as runs: the three-way
    // conversation can deliberate for a long time, and silence must mean
    // stopped, not buffered.
    onStderr: (chunk) => { process.stderr.write(chunk); },
  });

  let planResult;
  try {
    planResult = JSON.parse(result.stdout);
  } catch {
    const detail = messageFrom(result, 'no JSON was written to stdout');
    throw new Error(`loop plan did not return readable results: ${detail}`);
  }
  if (planResult === null || typeof planResult !== 'object' || Array.isArray(planResult)
    || typeof planResult.converged !== 'boolean'
    || !Number.isSafeInteger(planResult.rounds) || planResult.rounds < 0) {
    throw new Error('loop plan did not return readable results: convergence or rounds is missing');
  }
  if (planResult.converged && result.code !== 0) {
    throw new Error(`loop plan reported convergence but exited ${result.code}`);
  }
  return { ...planResult, exitCode: result.code };
}

export function readRunFacts({ runDirectory }) {
  const factsPath = join(runDirectory, 'uro-runfacts.json');
  try {
    return JSON.parse(readFileSync(factsPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read completed run facts ${factsPath}: ${error.message}`);
  }
}

function allowedRelativePaths(target, allowedPaths) {
  const allowed = new Set();
  for (const path of allowedPaths) {
    const relativePath = relative(target, resolve(path));
    if (relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
      allowed.add(relativePath.replaceAll('\\', '/'));
    }
  }
  return allowed;
}

function dirtyStatus(output, allowed) {
  return output.split('\0').filter(Boolean).filter((record) => {
    const status = record.slice(0, 2);
    const path = record.slice(3).replaceAll('\\', '/');
    return status !== '??' || !allowed.has(path);
  });
}

export async function assertCleanTarget(target, {
  runCommand = spawnCapture,
  allowedPaths = [],
} = {}) {
  const resolvedTarget = resolve(target);
  const result = await runCommand('git', [
    '-C', resolvedTarget, 'status', '--porcelain=v1', '-z', '--untracked-files=normal',
  ], { timeoutMs: GIT_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(`cannot inspect target working tree: ${messageFrom(result, `git exited ${result.code}`)}`);
  }
  const dirty = dirtyStatus(result.stdout, allowedRelativePaths(resolvedTarget, allowedPaths));
  if (dirty.length > 0) {
    throw new Error(`target working tree is dirty: ${oneLine(dirty.join(' '))}`);
  }
}

async function gitCommand(runCommand, args, options, description) {
  const result = await runCommand('git', args, { timeoutMs: GIT_TIMEOUT_MS, ...options });
  if (result.code !== 0) {
    throw new Error(`${description}: ${messageFrom(result, `git exited ${result.code}`)}`);
  }
  return result;
}

function numstatRecords(output, description) {
  const fields = output.split('\0');
  const records = [];
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index];
    if (record === '') continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2) {
      throw new Error(`${description}: Git returned malformed numstat output`);
    }
    let path = record.slice(secondTab + 1);
    if (path === '') {
      const oldPath = fields[index + 1];
      const newPath = fields[index + 2];
      if (!oldPath || !newPath) {
        throw new Error(`${description}: Git returned malformed rename numstat output`);
      }
      path = newPath;
      index += 2;
    }
    records.push({
      added: record.slice(0, firstTab),
      deleted: record.slice(firstTab + 1, secondTab),
      path,
    });
  }
  records.sort((left, right) => (
    left.path.localeCompare(right.path)
      || left.added.localeCompare(right.added)
      || left.deleted.localeCompare(right.deleted)
  ));
  return records;
}

function sameNumstat(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function landQueueDiff({
  target,
  diffPath,
  unit,
  runId,
  allowedDirtyPaths = [],
}, {
  runCommand = spawnCapture,
} = {}) {
  const resolvedTarget = resolve(target);
  const prefix = ['-C', resolvedTarget];

  // Runs may take hours. Recheck immediately before applying so changes made since
  // queue startup can never be swept into the queue commit.
  await assertCleanTarget(resolvedTarget, { runCommand, allowedPaths: allowedDirtyPaths });

  const patchStats = await gitCommand(runCommand, [
    ...prefix, 'apply', '--numstat', '-z', '--', diffPath,
  ], {}, 'cannot inspect paths touched by the diff');
  const expectedStats = numstatRecords(patchStats.stdout, 'cannot inspect paths touched by the diff');
  if (expectedStats.length === 0) {
    throw new Error('queue diff touched no paths; refusing to create an empty commit');
  }

  const check = await runCommand('git', [
    ...prefix, 'apply', '--check', '--index', '--', diffPath,
  ], { timeoutMs: GIT_TIMEOUT_MS });
  if (check.code !== 0) {
    throw new Error(`diff does not apply cleanly: ${messageFrom(check, `git exited ${check.code}`)}`);
  }

  await gitCommand(runCommand, [
    ...prefix, 'apply', '--index', '--', diffPath,
  ], {}, 'diff apply failed after a successful check');

  try {
    const stagedStats = await gitCommand(runCommand, [
      ...prefix, 'diff', '--cached', '--numstat', '-z', '--find-renames',
    ], {}, 'cannot inspect staged paths after applying the diff');
    if (!sameNumstat(
      expectedStats,
      numstatRecords(stagedStats.stdout, 'cannot inspect staged paths after applying the diff'),
    )) {
      throw new Error('staged changes do not exactly match the queue diff; refusing to commit');
    }

    const names = await gitCommand(runCommand, [
      ...prefix, 'diff', '--cached', '--name-only', '-z', '--find-renames',
    ], {}, 'cannot list paths touched by the diff');
    const paths = names.stdout.split('\0').filter(Boolean);
    if (paths.length === 0) {
      throw new Error('applied diff touched no paths; refusing to create an empty commit');
    }

    // Close the window between path discovery and commit, then ensure the exact patch
    // remains reversible from both the index and worktree before invoking repository policy.
    const finalStats = await gitCommand(runCommand, [
      ...prefix, 'diff', '--cached', '--numstat', '-z', '--find-renames',
    ], {}, 'cannot recheck staged paths before committing the diff');
    if (!sameNumstat(
      expectedStats,
      numstatRecords(finalStats.stdout, 'cannot recheck staged paths before committing the diff'),
    )) {
      throw new Error('staged changes changed before the queue commit; refusing to commit');
    }
    const reversible = await runCommand('git', [
      ...prefix, 'apply', '--check', '--reverse', '--index', '--', diffPath,
    ], { timeoutMs: GIT_TIMEOUT_MS });
    if (reversible.code !== 0) {
      throw new Error(
        `staged content no longer matches the queue diff: `
        + messageFrom(reversible, `git exited ${reversible.code}`),
      );
    }

    const message = `queue: land ${oneLine(unit.name)} (${oneLine(runId)})`;
    await gitCommand(runCommand, [
      ...prefix,
      'commit',
      '--only',
      '-m', message,
      '--pathspec-from-file=-',
      '--pathspec-file-nul',
    ], { input: names.stdout }, 'queue commit failed');
    return { paths };
  } catch (error) {
    const rollback = await runCommand('git', [
      ...prefix, 'apply', '--reverse', '--index', '--', diffPath,
    ], { timeoutMs: GIT_TIMEOUT_MS });
    if (rollback.code !== 0) {
      throw new Error(
        `${error?.message ?? String(error)}; rollback failed: `
        + `${messageFrom(rollback, `git exited ${rollback.code}`)}. `
        + `Manual recovery required: inspect git status and ${diffPath} before continuing`,
      );
    }
    throw error;
  }
}

// Claude's final review before landing — the hierarchy's last step. Claude
// reads the composed task and the diff first-hand, with the closed findings
// and the non-zero evidence in front of it, and judges the landing. An
// unreachable or unreadable judgement returns approved: null; the queue
// treats anything but an explicit yes as a stop.
export async function judgeLandingWithClaude({ unit, facts, runDirectory }, {
  arbiter = runArbiter,
  cwd = process.cwd(),
} = {}) {
  const readOptional = (path) => {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  };
  const request = {
    type: 'landing',
    task: readOptional(join(runDirectory, 'TASK.md')) || unit?.name || '',
    diff: readOptional(join(runDirectory, 'CHANGES.diff')),
    findings: facts?.debate?.roundHistory?.at(-1)?.findings ?? [],
    evidence: (facts?.evidence ?? []).filter((entry) => entry.code !== 0),
  };
  let result;
  try {
    result = await arbiter({ cwd, request });
  } catch (error) {
    return {
      approved: null,
      reasoning: error instanceof Error ? error.message : String(error),
    };
  }
  const judgement = parseLandingJudgement(result);
  if (judgement.verdict !== 'answered') {
    return {
      approved: null,
      reasoning: result?.error ?? 'no readable landing judgement',
    };
  }
  return {
    approved: judgement.approved,
    reasoning: judgement.reasoning,
    findings: judgement.findings,
  };
}

export function createQueueRuntime(options = {}) {
  return {
    assertCleanTarget: (target, request = {}) => assertCleanTarget(target, { ...options, ...request }),
    launchPlan: (request) => launchLoopPlan(request, options),
    launchRun: (request) => launchLoopRun(request, options),
    readRunFacts,
    landDiff: (request) => landQueueDiff(request, options),
    judgeLanding: (request) => judgeLandingWithClaude(request, options),
  };
}
