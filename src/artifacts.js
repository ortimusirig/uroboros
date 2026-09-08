import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readEnv } from './env-compat.js';
import { createHash } from 'node:crypto';
import { isSafePhysicalRunId, physicalRunIdFor } from './run-id.js';

// Files written by the harness inside an isolated worktree. Keep this list central:
// every Git staging/diff operation must exclude the same paths. Both prefixes are listed
// so a run directory created before the rename is still excluded.
export const HARNESS_ARTIFACTS = Object.freeze([
  'TASK.md',
  'DECISION.md',
  'uro-checkpoint.json',
  'uro-resume.lock',
  '__uro_review/',
  '__uro_evidence/',
  '__uro_context/',
  '__uro_dialogue/',
  '.uro-tmp/',
  'CHANGES.diff',
  'uro-report.md',
  'uro-runfacts.json',
  'uro-github.json',
  'uro-merge-resolutions.json',
  'ccc-report.md',
  'ccc-runfacts.json',
  'ccc-github.json',
  'ccc-merge-resolutions.json',
  'events.jsonl',
  'campaign-events.jsonl',
]);

// Read either prefix; write only the current one.
export function resolveArtifact(directory, basename) {
  const current = join(directory, basename);
  if (existsSync(current)) return current;
  const legacy = join(directory, basename.replace(/^uro-/, 'ccc-'));
  if (legacy !== current && existsSync(legacy)) return legacy;
  return current;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function eventTimeRange(dir) {
  const eventsPath = join(dir, 'events.jsonl');
  if (!existsSync(eventsPath)) return null;
  const times = [];
  for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const timestamp = Date.parse(JSON.parse(line)?.ts);
      if (Number.isFinite(timestamp)) times.push(timestamp);
    } catch {
      // A damaged observability line is not allowed to affect the run outcome.
    }
  }
  return times.length === 0 ? null : { start: times[0], end: times.at(-1) };
}

function indexEntry(facts, dir, startedAt, endedAt) {
  const eventTimes = eventTimeRange(dir);
  const start = eventTimes === null
    ? (startedAt instanceof Date ? startedAt : new Date(startedAt))
    : new Date(eventTimes.start);
  const end = eventTimes === null
    ? (endedAt instanceof Date ? endedAt : new Date(endedAt))
    : new Date(eventTimes.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new TypeError('artifact index timestamps must be valid dates');
  }
  return {
    runId: facts.runId,
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    durationMs: Math.max(0, end.getTime() - start.getTime()),
    outcome: facts.outcome ?? null,
    evidenceNonZero: (facts.evidence ?? []).filter((entry) => entry.code !== 0).length,
    findingsLastRound: (facts.debate?.roundHistory?.at(-1)?.findings ?? []).length,
    inputTokens: tokenCount(facts.tokens?.total?.inputTokens),
    outputTokens: tokenCount(facts.tokens?.total?.outputTokens),
  };
}

export function resolveArtifactRoot({ scratchRoot, artifactRoot, env = process.env }) {
  const configured = artifactRoot ?? readEnv(env, 'ARTIFACT_ROOT');
  return resolve(configured ?? join(scratchRoot, 'artifacts'));
}

function persistFinalFacts({ dir, durableDirectory, facts, result }) {
  facts.artifacts = result;
  const sourceFacts = join(dir, 'uro-runfacts.json');
  if (!existsSync(sourceFacts)) return;
  try {
    writeFileSync(sourceFacts, JSON.stringify(facts, null, 2));
  } catch (error) {
    result.status = 'failed';
    result.factsWrite = { status: 'failed', error: errorMessage(error) };
  }
  if (durableDirectory === null || !existsSync(durableDirectory)) return;
  try {
    writeFileSync(join(durableDirectory, 'uro-runfacts.json'), JSON.stringify(facts, null, 2));
  } catch (error) {
    result.status = 'failed';
    result.refresh = { status: 'failed', error: errorMessage(error) };
    try {
      writeFileSync(sourceFacts, JSON.stringify(facts, null, 2));
    } catch {
      // The in-memory facts still carry the non-fatal retention failure.
    }
  }
}

export function archiveRunArtifacts({
  dir,
  runId,
  facts,
  scratchRoot,
  artifactRoot,
  env = process.env,
  startedAt,
  endedAt,
  refresh = false,
  retainedFiles = [],
  requiredRetention = false,
}) {
  const root = resolveArtifactRoot({ scratchRoot, artifactRoot, env });
  let physicalRunId = null;
  try { physicalRunId = physicalRunIdFor(runId); } catch { /* recorded below */ }
  const durableDirectory = physicalRunId === null ? null : join(root, physicalRunId);
  const result = {
    status: 'ok',
    root,
    directory: durableDirectory,
    copied: [],
    copyFailures: [],
    index: { status: 'pending', path: join(root, 'index.jsonl') },
  };
  let retentionAllowed = false;
  let retentionError = null;
  const digestFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const retainedPath = (root, path, missingAllowed = false) => {
    if (typeof path !== 'string' || path.includes('\\') || path.split('/').some(part => ['.', '..', ''].includes(part))
      || !/^\.uro-tmp\/retained-phases\/[^/]+\/(?:phase-link\.json|__uro_(?:context|dialogue|evidence)\/.+)$/.test(path)
      || path.endsWith('/controller.lock')) throw new Error('invalid retained phase file path');
    let current = resolve(root);
    for (let ancestor = current; ; ancestor = dirname(ancestor)) {
      if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('retained phase symbolic-link ancestor refused');
      if (dirname(ancestor) === ancestor) break;
    }
    for (const part of ['', ...path.split('/')]) {
      if (part) current = join(current, part);
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error('retained phase symbolic-link ancestor refused');
      if (!stat && !missingAllowed) throw new Error('required retained phase source is missing');
    }
    if (!containsPath(resolve(root), current)) throw new Error('retained phase path escape');
    return current;
  };
  const sourceFailure = (error, path) => {
    result.requiredSource = { status: 'failed', error: errorMessage(error), path };
    facts.approved = false; facts.approval = null; facts.outcome = 'needs-pivot'; facts.nextAction = 'paused';
    facts.reason = `required retained source integrity failed: ${errorMessage(error)}`;
    if (facts.checkpointState) Object.assign(facts.checkpointState, { approved: false, action: 'paused', reason: facts.reason,
      requiredSourceFailure: result.requiredSource });
    throw error;
  };
  const requiredSource = item => {
    try {
      const path = retainedPath(dir, item.path);
      if (!/^[a-f0-9]{64}$/i.test(item.sha256) || !lstatSync(path).isFile() || digestFile(path) !== item.sha256.toLowerCase()) {
        throw new Error('required retained phase source digest changed');
      }
      return path;
    } catch (error) {
      sourceFailure(error, item?.path);
    }
  };

  try {
    if (!isSafePhysicalRunId(physicalRunId)) {
      throw new TypeError('runId could not be mapped to a safe physical directory');
    }
    if (!Array.isArray(retainedFiles)) sourceFailure(new Error('exact retained file list required'));
    const seenRetained = new Set();
    for (const item of retainedFiles) {
      requiredSource(item);
      if (seenRetained.has(item.path)) sourceFailure(new Error('duplicate retained phase file path'), item.path);
      seenRetained.add(item.path);
    }
    const canonicalWorktree = futureRealPath(dir);
    const canonicalRoot = futureRealPath(root);
    if (containsPath(canonicalWorktree, canonicalRoot)
      || containsPath(canonicalRoot, canonicalWorktree)) {
      throw new Error('artifact directory must be outside the disposable worktree');
    }
    retentionAllowed = true;
    mkdirSync(durableDirectory, { recursive: true });

    const copyEvidenceDirectory = (source, destination, boundary) => {
      if (lstatSync(source).isSymbolicLink() || !containsPath(realpathSync(boundary), realpathSync(source))) {
        throw new Error('evidence retention refused a symbolic-link boundary');
      }
      if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) throw new Error('artifact destination is a symbolic link');
      if (lstatSync(source).isDirectory()) {
        mkdirSync(destination, { recursive: true });
        for (const entry of readdirSync(source)) copyEvidenceDirectory(join(source, entry), join(destination, entry), boundary);
      } else if (lstatSync(source).isFile()) {
        const before = requiredRetention ? digestFile(source) : null;
        copyFileSync(source, destination);
        if (requiredRetention && (digestFile(source) !== before || digestFile(destination) !== before)) throw new Error('required context archive copy digest mismatch');
      }
      else throw new Error('evidence retention refused a nonregular file');
    };
    for (const filename of HARNESS_ARTIFACTS) {
      if (filename === 'uro-resume.lock') continue;
      const source = join(dir, filename);
      if (!existsSync(source)) continue;
      try {
        if (['__uro_evidence/', '__uro_review/', '__uro_context/', '__uro_dialogue/'].includes(filename)) {
          copyEvidenceDirectory(source, join(durableDirectory, filename), dir);
          result.copied.push(filename);
          continue;
        }
        if (!statSync(source).isFile()) continue;
        if (lstatSync(source).isSymbolicLink() || (existsSync(join(durableDirectory, filename))
          && lstatSync(join(durableDirectory, filename)).isSymbolicLink())) throw new Error('artifact symbolic link refused');
        copyFileSync(source, join(durableDirectory, filename));
        result.copied.push(filename);
      } catch (error) {
        result.copyFailures.push({ filename, error: errorMessage(error) });
      }
    }
    for (const item of retainedFiles) {
      try {
        const source = requiredSource(item);
        const destination = retainedPath(durableDirectory, item.path, true);
        mkdirSync(dirname(destination), { recursive: true });
        copyEvidenceDirectory(source, destination, dir);
        requiredSource(item);
        if (digestFile(destination) !== item.sha256.toLowerCase()) throw new Error('retained destination copy digest mismatch');
        result.copied.push(item.path);
      } catch (error) {
        result.copyFailures.push({ filename: item.path, error: errorMessage(error) });
        if (result.requiredSource?.status === 'failed') break;
      }
    }
    if (result.copyFailures.length > 0) result.status = 'failed';
  } catch (error) {
    result.status = 'failed';
    retentionError = errorMessage(error);
    result.error = retentionError;
  }

  if (!retentionAllowed) {
    result.index = { ...result.index, status: 'failed', error: retentionError };
  } else {
    try {
      mkdirSync(root, { recursive: true });
      const entry = indexEntry(facts, dir, startedAt, endedAt);
      if (!refresh) appendFileSync(result.index.path, `${JSON.stringify(entry)}\n`);
      result.index = { ...result.index, status: 'ok' };
    } catch (error) {
      result.status = 'failed';
      result.index = { ...result.index, status: 'failed', error: errorMessage(error) };
    }
  }

  const revokeRequiredRetention = () => {
    if (!requiredRetention || result.status === 'ok') return false;
    result.requiredRetention = { status: 'failed' };
    facts.approved = false; facts.approval = null; facts.outcome = 'needs-pivot'; facts.nextAction = 'paused';
    facts.reason = `required artifact retention failed: ${result.error ?? result.copyFailures[0]?.error ?? result.factsWrite?.error ?? result.refresh?.error ?? result.index.error}`;
    if (facts.checkpointState) Object.assign(facts.checkpointState, { approved: false, action: 'paused', reason: facts.reason,
      requiredRetentionFailure: result.requiredRetention });
    return true;
  };
  revokeRequiredRetention();
  persistFinalFacts({
    dir,
    durableDirectory: retentionAllowed ? durableDirectory : null,
    facts,
    result,
  });
  if (revokeRequiredRetention()) persistFinalFacts({ dir, durableDirectory: retentionAllowed ? durableDirectory : null, facts, result });
  return result;
}
