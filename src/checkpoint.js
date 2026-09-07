import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalPlanningArtifact } from './conversation.js';
import { HARNESS_ARTIFACTS } from './artifacts.js';
import { assertSafeScratchRoot } from './isolation.js';

export const CHECKPOINT_FILE = 'uro-checkpoint.json';
export function checkpointDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalPlanningArtifact(value))).digest('hex');
}
export function answerIdentity(envelope) {
  return checkpointDigest({ schemaVersion: envelope?.schemaVersion, runId: envelope?.runId,
    artifactDigest: envelope?.artifactDigest, answers: Array.isArray(envelope?.answers)
      ? [...envelope.answers].sort((a, b) => String(a?.id).localeCompare(String(b?.id))) : envelope?.answers });
}
function integrityDigest(value) {
  const { checksum: _checksum, ...body } = value;
  return checkpointDigest(body);
}
function canonical(path) {
  const value = realpathSync(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
function assertRegular(path) {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`checkpoint path must not be a symbolic link: ${path}`);
}
export function writeCheckpointAtomic(path, value) {
  if (path.endsWith(CHECKPOINT_FILE)) value.checksum = integrityDigest(value);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) assertRegular(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function git(path, ...args) {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function treeDigest(root, ignoredPaths = []) {
  const hash = createHash('sha256');
  const excluded = new Set(['.git', CHECKPOINT_FILE, 'uro-resume.lock', ...HARNESS_ARTIFACTS.map(p => p.replace(/\/$/, ''))]);
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && excluded.has(entry.name)) continue;
      const path = join(directory, entry.name), name = `${prefix}${entry.name}`;
      if (ignoredPaths.includes(resolve(path).toLowerCase())) continue;
      if (entry.isSymbolicLink()) throw new Error(`cannot checkpoint a symbolic-link boundary: ${path}`);
      if (entry.isDirectory()) visit(path, `${name}/`);
      else if (entry.isFile()) hash.update(name).update('\0').update(readFileSync(path)).update('\0');
      else throw new Error(`cannot checkpoint a nonregular file: ${path}`);
    }
  }
  visit(root);
  return hash.digest('hex');
}
function identity(path, requireGit = false, ignoredPaths = []) {
  const directory = canonical(path);
  assertRegular(path);
  let repository = null;
  try {
    const top = canonical(git(directory, 'rev-parse', '--show-toplevel'));
    // A folder nested in a repository is not an isolated Git workspace.
    if (requireGit && top !== directory) throw new Error('workspace is not a Git root');
    repository = { top, head: git(directory, 'rev-parse', 'HEAD'),
      common: canonical(resolve(directory, git(directory, 'rev-parse', '--git-common-dir'))),
      gitDir: canonical(resolve(directory, git(directory, 'rev-parse', '--git-dir'))),
      branch: git(directory, 'symbolic-ref', '-q', 'HEAD') };
  } catch (error) {
    if (requireGit) throw new Error(`missing or corrupt Git workspace: ${directory}`, { cause: error });
  }
  const artifacts = requireGit ? Object.fromEntries(['CHANGES.diff', '__uro_review', '__uro_evidence'].map(name => {
    const file = join(directory, name);
    if (!existsSync(file)) return [name, null];
    assertRegular(file);
    return [name, lstatSync(file).isDirectory() ? treeDigest(file) : checkpointDigest(readFileSync(file).toString('base64'))];
  })) : undefined;
  return { directory, repository, ignoredPaths, treeDigest: treeDigest(repository?.top ?? directory, ignoredPaths), ...(requireGit ? { artifacts } : {}) };
}
function questionsFor(state) {
  const questions = state.phase === 'planning' ? [state.pendingDecision] : state.decision?.questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.some(q => !q?.id || !(q.question || q.text))) {
    throw new Error('checkpoint has no pending questions');
  }
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('duplicate pending question IDs');
  return questions;
}
export function validateCheckpoint(value) {
  if (value?.checksum !== integrityDigest(value ?? {})) throw new Error('checkpoint checksum is corrupt');
  if (value?.schemaVersion !== 1 || value?.continuation?.version !== 1) throw new Error('unsupported checkpoint schema version');
  if (!['planning', 'execution'].includes(value.phase) || value.phase !== value.continuation.phase) throw new Error('invalid checkpoint phase');
  if (value.interactionMode !== 'manual' || value.continuation.interactionMode !== 'manual') throw new Error('saved mode is not manual; mode cannot change on resume');
  if (!value.runId || value.runId !== value.continuation.runId || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('invalid checkpoint identity');
  if (checkpointDigest(value.continuation) !== value.stateDigest) throw new Error('checkpoint state changed or is corrupt');
  if (checkpointDigest({ runId: value.runId, revision: value.revision, stateDigest: value.stateDigest,
    questions: value.pending?.questions, queue: value.queue }) !== value.artifactDigest) throw new Error('checkpoint decision digest is corrupt');
  if (checkpointDigest(questionsFor(value.continuation)) !== checkpointDigest(value.pending.questions)) throw new Error('checkpoint pending questions changed');
  for (const receipt of value.receipts ?? []) {
    if (receipt.result && receipt.resultDigest !== checkpointDigest(receipt.result)) throw new Error('checkpoint result receipt is corrupt');
    if (receipt.decisionId !== answerIdentity({ schemaVersion: 1, runId: value.runId,
      artifactDigest: receipt.artifactDigest, answers: receipt.answers })) throw new Error('checkpoint answer receipt is corrupt');
  }
  return value;
}
export function readCheckpoint(directory) {
  const path = join(directory, CHECKPOINT_FILE);
  assertRegular(path);
  return validateCheckpoint(JSON.parse(readFileSync(path, 'utf8')));
}
export async function saveCheckpoint({ directory, checkpointState, references = [], previous, queue = previous?.queue, persist = true }) {
  if (checkpointState.interactionMode !== 'manual') throw new Error('only manual decisions can be checkpointed');
  // State has an explicit serializable contract. Never copy adapters or process environments.
  const state = canonicalPlanningArtifact(checkpointState);
  if (state.options) {
    for (const key of ['env', 'environment', 'adapters', 'credentials', 'apiKey', 'accessToken']) delete state.options[key];
  }
  mkdirSync(directory, { recursive: true });
  const execution = state.phase === 'execution' ? state : state.executionContinuation;
  const target = execution ? execution.workspace.targetPath : state.planningContext.request.target;
  const workspace = execution ? identity(execution.workspace.dir, true) : null;
  const checkpoint = { schemaVersion: 1, revision: (previous?.revision ?? (existsSync(join(directory, CHECKPOINT_FILE))
    ? readCheckpoint(directory).revision : 0)) + 1, runId: state.runId, phase: state.phase,
    interactionMode: 'manual', status: 'needs-decision', directory: canonical(directory),
    continuation: state, stateDigest: checkpointDigest(state), workspace, target: identity(target, false,
      [join(directory, CHECKPOINT_FILE), join(directory, 'uro-resume.lock'), ...(queue ? [queue.queue.logPath] : [])].map(path => resolve(path).toLowerCase())),
    ...(queue ? { queue } : {}),
    references: references.map(path => ({ path: canonical(path), digest: checkpointDigest(readFileSync(path).toString('base64')) })),
    pending: { questions: questionsFor(state) }, receipts: previous?.receipts ?? [],
    history: [...(previous?.history ?? []), { status: 'needs-decision', at: new Date().toISOString() }] };
  if (workspace && checkpoint.directory !== workspace.directory) throw new Error('execution checkpoint must be written in its recorded workspace');
  checkpoint.artifactDigest = checkpointDigest({ runId: checkpoint.runId, revision: checkpoint.revision,
    stateDigest: checkpoint.stateDigest, questions: checkpoint.pending.questions, queue: checkpoint.queue });
  checkpoint.checksum = integrityDigest(checkpoint);
  validateCheckpoint(checkpoint);
  if (persist) writeCheckpointAtomic(join(directory, CHECKPOINT_FILE), checkpoint);
  return checkpoint;
}

export async function attachQueueCheckpoint(directory, queue) {
  const previous = readCheckpoint(directory);
  const references = [...new Set([...previous.references.map(item => item.path), queue.queue.path,
    ...(queue.options.acceptGoalSpec ? [resolve(queue.options.acceptGoalSpec)] : []),
    ...queue.queue.units.flatMap(unit => [unit.task, unit.gate].filter(Boolean))])];
  const checkpoint = await saveCheckpoint({ directory, checkpointState: previous.continuation, previous, references, queue });
  const factsPath = join(directory, 'uro-runfacts.json');
  if (existsSync(factsPath)) {
    const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
    if (facts.artifacts?.directory) writeCheckpointAtomic(join(facts.artifacts.directory, CHECKPOINT_FILE), checkpoint);
  }
  return checkpoint;
}
export function validateAnswerEnvelope(checkpoint, envelope) {
  validateCheckpoint(checkpoint);
  if (envelope?.schemaVersion !== 1) throw new Error('unsupported answer schema version');
  if (envelope.runId !== checkpoint.runId) throw new Error('answer runId does not match the saved run');
  if (envelope.artifactDigest !== checkpoint.artifactDigest) throw new Error('stale answer artifactDigest; use the latest checkpoint');
  if (!Array.isArray(envelope.answers)) throw new Error('answers must be an array');
  const expected = new Set(checkpoint.pending.questions.map(q => q.id)), seen = new Set();
  for (const item of envelope.answers) {
    if (!expected.has(item?.id)) throw new Error('unknown answer ID');
    if (seen.has(item.id)) throw new Error('duplicate answer ID');
    if (typeof item.answer !== 'string' || !item.answer.trim()) throw new Error('blank answer');
    seen.add(item.id);
  }
  if (seen.size !== expected.size) throw new Error('missing pending answer IDs');
  return { answers: [...envelope.answers].sort((a, b) => a.id.localeCompare(b.id)),
    decisionId: answerIdentity(envelope), artifactDigest: checkpoint.artifactDigest };
}
export function checkpointPhaseIdentity(checkpoint) {
  return { workspace: checkpoint.workspace ? identity(checkpoint.workspace.directory, true) : null,
    target: identity(checkpoint.target.directory, false, checkpoint.target.ignoredPaths) };
}
export function validateDecisionFilePlacement(checkpoint, path) {
  const file = canonical(path);
  const roots = [checkpoint.target.repository?.top ?? checkpoint.target.directory, checkpoint.workspace?.directory].filter(Boolean);
  if (roots.some(root => inside(root, file))) {
    throw new Error('answer file must be outside the target repository/source tree and execution workspace; move it to an external directory and restore the saved source tree before resuming');
  }
}
export function resolveCheckpointDirectory(checkpoint, directory) {
  validateCheckpoint(checkpoint);
  const supplied = canonical(directory);
  if (supplied !== checkpoint.directory) {
    // Only the recorded durable copy may redirect to the live workspace.
    const factsPath = join(supplied, 'uro-runfacts.json');
    if (!existsSync(factsPath)) throw new Error('checkpoint is outside its recorded artifact directory');
    const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
    if (facts.runId !== checkpoint.runId || canonical(facts.artifacts?.directory) !== supplied
      || canonical(facts.dir) !== checkpoint.directory) throw new Error('checkpoint artifact reference does not match workspace');
  }
  return checkpoint.directory;
}
export async function validateCheckpointWorkspace(checkpoint, directory, { completed, recoveredLanding = false } = {}) {
  resolveCheckpointDirectory(checkpoint, directory);
  const expectedWorkspace = completed?.workspace ?? checkpoint.workspace;
  const expectedTarget = completed?.target ?? checkpoint.target;
  if (checkpoint.workspace) {
    const current = identity(checkpoint.workspace.directory, true);
    if (checkpointDigest(current) !== checkpointDigest(expectedWorkspace)) throw new Error('workspace identity or content changed; approval invalidated');
    const state = checkpoint.continuation.executionContinuation ?? checkpoint.continuation;
    if (canonical(state.workspace.dir) !== current.directory || canonical(state.workspace.targetPath) !== checkpoint.target.directory) throw new Error('checkpoint workspace reference mismatch');
    const scratch = canonical(state.options.scratchRoot);
    assertSafeScratchRoot(scratch);
    if (!inside(scratch, current.directory) || inside(current.directory, checkpoint.target.directory)) throw new Error('workspace is outside recorded isolation root');
    const common = current.repository.common;
    const targetCommon = checkpoint.target.repository?.common;
    if (common !== targetCommon && !inside(scratch, common)) throw new Error('workspace Git relationship is not owned by target or scratch');
    if (state.workspace.isRepo === true && common !== targetCommon) throw new Error('workspace does not belong to the recorded target repository');
    if (canonical(state.options.target) !== checkpoint.target.directory) throw new Error('resume target reference changed');
    if (state.options.campaignBase) {
      const base = state.options.campaignBase;
      const baseIdentity = identity(base.repository, true);
      if (baseIdentity.repository.common !== common) throw new Error('workspace campaign base relationship changed');
      if (!base.isRepo && (git(current.directory, 'config', '--get', 'ccc.campaign-id') !== base.campaignId
        || canonical(git(current.directory, 'config', '--get', 'ccc.source-path')) !== checkpoint.target.directory)) {
        throw new Error('campaign base no longer identifies the original target');
      }
    }
  }
  if (!recoveredLanding && checkpointDigest(identity(checkpoint.target.directory, false, checkpoint.target.ignoredPaths)) !== checkpointDigest(expectedTarget)) throw new Error('target identity or content changed; approval invalidated');
  for (const ref of checkpoint.references) {
    if (canonical(ref.path) !== ref.path || checkpointDigest(readFileSync(ref.path).toString('base64')) !== ref.digest) throw new Error('saved requirements or evidence configuration changed; approval invalidated');
  }
}
