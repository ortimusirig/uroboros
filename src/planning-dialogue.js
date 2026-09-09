import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createSharedContext, extendSharedContext, persistSharedContext, validateSharedContext, contextDigest, renderSharedContext, readSharedContextReference } from './shared-context.js';
import { assertNativeContext, resolveNativeWorkflowBinding } from './shared-context.js';
import { workflowIdentity, readWorkflowBinding } from './workflow-profiles.js';
import { captureEvidence, validateEvidence } from './context-evidence.js';
import { resolveProjectIdentity, openProjectMemory } from './project-memory.js';
import { resolveArtifactRoot } from './artifacts.js';
import { readEnv } from './env-compat.js';
import { openDialogueJournal } from './dialogue-journal.js';
import { createDialogueState, parseDialogueEnvelope, applyDialogueEnvelope, validateDialogueEvidence, canApproveDialogue } from './dialogue.js';
import { runIssueDialogue, registerObservations, installMaterialEvidence } from './dialogue-dispatch.js';
import { canonicalPlanningArtifact, planningArtifactDigest, RepairableArtifactError, MAX_ARTIFACT_REPAIRS, dialoguePromptText } from './conversation.js';
import { reportEvent } from './events.js';
import { nativeHumanQuestion } from './checkpoint.js';
import { MERGE_LEDGER_FILENAME } from './merge.js';

const digestBytes = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function compatibleDialogueStance({ action, transport, content }) {
  if (transport?.error) return 'unavailable';
  if (action === 'approve') return 'agree';
  if (['challenge', 'withdraw'].includes(action)) return 'disagree';
  return 'neutral';
}

const sidecarRoots = ['__uro_context', '__uro_dialogue', '__uro_evidence'];
function assertSidecarInventory({ directory, registeredPaths }) {
  if (lstatSync(directory).isSymbolicLink()) throw new Error('planning sidecar root must not be a symbolic link');
  const root = realpathSync.native(directory);
  const registered = new Set([...registeredPaths].map(path => relative(resolve(directory), resolve(path)).replaceAll('\\', '/')));
  const visit = path => {
    const stats = lstatSync(path), rel = relative(root, path).replaceAll('\\', '/');
    if (stats.isSymbolicLink() || rel.startsWith('../') || isAbsolute(rel)) throw new Error('planning sidecar escape or symbolic link');
    if (stats.isDirectory()) {
      if (!sidecarRoots.includes(rel) && ![...registered].some(file => file.startsWith(`${rel}/`))) throw new Error(`unexpected planning sidecar directory: ${rel}`);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    }
    else if (stats.isFile()) { if (!registered.has(rel)) throw new Error(`unregistered planning sidecar file already exists: ${rel}`); }
    else throw new Error('nonregular planning sidecar');
  };
  for (const name of sidecarRoots) if (existsSync(join(root, name))) visit(join(root, name));
}
function planningSidecarManifest({ directory, runId, contextDigest: snapshotDigest, registeredPaths }) {
  registeredPaths = [...registeredPaths];
  assertSidecarInventory({ directory, registeredPaths });
  const files = [...registeredPaths].map(path => {
    const rel = relative(resolve(directory), resolve(path)).replaceAll('\\', '/');
    if (rel.startsWith('../') || isAbsolute(rel) || !sidecarRoots.some(root => rel.startsWith(`${root}/`))
      || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('invalid registered planning sidecar path');
    return { path: rel, sha256: digestBytes(path) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { schemaVersion: 1, directory: resolve(directory), runId, contextDigest: snapshotDigest, files };
}

/** Only this validated exact file set can be exempted from queue cleanliness. */
export function assertPlanningSidecars({ directory, runId, approval, manifest }) {
  if (!manifest || manifest.runId !== runId || resolve(manifest.directory) !== resolve(directory)
    || manifest.contextDigest !== approval.contextDigest
    || contextDigest({ manifest }) !== approval.sidecarDigest) throw new Error('planning sidecar manifest identity mismatch');
  const actual = planningSidecarManifest({ directory, runId, contextDigest: approval.contextDigest,
    registeredPaths: manifest.files.map(file => join(directory, file.path)) });
  if (contextDigest({ manifest: actual }) !== approval.sidecarDigest) throw new Error('planning sidecar manifest changed');
  return manifest.files.map(file => join(directory, file.path));
}

/** Validate the durable native producer before delivering its attributed records. */
export function validatePlanningHandoff({ handoff, target, directory = handoff?.directory, completedExecution }) {
  const approval = handoff?.approval, project = resolveProjectIdentity({ target });
  if (handoff?.schemaVersion !== 1 || !approval || resolve(handoff.directory) !== resolve(directory)
    || planningArtifactDigest(handoff.requirements, handoff.proposal) !== approval.artifactDigest) throw new Error('required planning handoff identity missing or stale');
  validateSharedContext({ snapshot: handoff.snapshot, projectId: project.projectId });
  if (handoff.snapshot.completeness?.complete !== true || approval.contextDigest !== handoff.snapshot.digest
    || handoff.snapshot.runId !== handoff.runId || handoff.snapshot.phase !== 'planning') throw new Error('planning handoff context incomplete or stale');
  assertPlanningSidecars({ directory, runId: handoff.runId, approval, manifest: handoff.planningArtifacts });
  // History is established by a real landed operation and its exact reviewed
  // diff, including a commit whose return/log receipt was interrupted.
  let historical = false;
  if (completedExecution) {
    const { operationId, commit, diffPath, artifactDigest } = completedExecution;
    if (!/^[a-f0-9]{64}$/.test(operationId) || commit && !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('invalid completed queue operation identity');
    const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const revision = commit ?? 'HEAD';
    if (git('show', '-s', '--format=%B', revision).split(/\r?\n/).includes(`Uroboros-Operation: ${operationId}`)) {
      const diff = readFileSync(diffPath, 'utf8');
      if (createHash('sha256').update(diff).digest('hex') !== artifactDigest || git('diff', `${revision}^`, revision) !== diff) throw new Error('completed queue operation differs from reviewed execution');
      git('merge-base', '--is-ancestor', revision, 'HEAD');
      historical = true;
    } else if (commit) throw new Error('saved completed queue operation commit changed');
  }
  const journal = openDialogueJournal({ directory, runId: handoff.runId, projectId: project.projectId });
  try {
    const events = journal.read(), tail = events.at(-1), dialogue = events.findLast(event => event.type === 'state')?.state;
    if (!dialogue || tail.hash !== handoff.journalIdentity?.hash || tail.sequence !== handoff.journalIdentity?.sequence
      || contextDigest({ state: dialogue }) !== handoff.stateDigest || dialogue.artifactDigest !== approval.artifactDigest
      || dialogue.snapshot.digest !== handoff.snapshot.digest
      || contextDigest(planningHistory(dialogue)) !== contextDigest(handoff.history)) throw new Error('planning handoff journal or history identity changed');
    const targetRoot = realpathSync.native(target), evidenceRoot = realpathSync.native(join(directory, '__uro_evidence'));
    if (contextDigest(dialogue.scope) !== contextDigest({ sourceRoots: [targetRoot], evidenceRoots: [evidenceRoot] })) throw new Error('planning handoff scope changed');
    const stored = JSON.parse(readFileSync(join(directory, '__uro_context', `${handoff.snapshot.id}.json`), 'utf8'));
    validateSharedContext({ snapshot: stored, projectId: project.projectId });
    if (stored.digest !== handoff.snapshot.digest) throw new Error('planning handoff stored context changed');
    assertCompletedEffects({ journal }, dialogue);
    const checkEvidence = historical ? (state, evidence) => {
      const captured = realpathSync.native(evidence.capturedPath), captureRel = relative(evidenceRoot, captured);
      if (captureRel.startsWith('..') || isAbsolute(captureRel)) throw new Error('historical evidence capture outside scope');
      if (evidence.kind === 'code') {
        const sourceRel = relative(targetRoot, resolve(targetRoot, evidence.locator.path));
        if (sourceRel.startsWith('..') || isAbsolute(sourceRel)) throw new Error('historical source outside scope');
      }
      const valid = validateEvidence({ evidence, projectId: state.projectId, roots: [targetRoot, evidenceRoot] });
      if (!valid.valid && !(evidence.kind === 'code' && ['evidence is stale: current source digest differs', 'current evidence source is missing'].includes(valid.reason))) throw new Error(valid.reason);
    } : validateDialogueEvidence;
    if (approval.decidedBy === 'human') humanPlanningApproval({ state: dialogue }, checkEvidence);
    else if (approval.decidedBy !== 'codex' || (historical
      ? dialogue.approval?.seat !== 'codex' || dialogue.approval.artifactDigest !== approval.artifactDigest || dialogue.approval.contextDigest !== approval.contextDigest
      : !canApproveDialogue({ state: dialogue, seat: 'codex' }).approved)) throw new Error('planning handoff lacks current approval');
    for (const evidence of dialogue.evidence) checkEvidence(dialogue, evidence);
    if (!Array.isArray(handoff.evidenceCaptures) || handoff.evidenceCaptures.length !== dialogue.evidence.length
      || dialogue.evidence.some((e, i) => handoff.evidenceCaptures[i].id !== e.id
        || handoff.evidenceCaptures[i].bytes !== readFileSync(e.capturedPath, 'utf8'))) throw new Error('planning handoff evidence capture changed');
  } finally { journal.close(); }
  return handoff;
}

// This is the complete public protocol history, not a display summary. Preserve
// ordinary text and attribution without copying opaque envelope extensions.
const historyIdentity = ['id', 'sender', 'speaker', 'phase', 'operationId', 'sequence', 'artifactDigest', 'contextDigest', 'messageId', 'decisionId'];
function historyFields(value, fields) {
  return Object.fromEntries(fields.filter(key => value?.[key] !== undefined && (value[key] === null
    || typeof value[key] !== 'object' || Array.isArray(value[key]) && value[key].every(item => item === null || typeof item !== 'object')))
    .map(key => [key, value[key]]));
}
const historyDisposition = value => historyFields(value, [...historyIdentity, 'kind', 'by', 'basis', 'seat', 'reason', 'claimIds', 'issueId']);
const historyVerification = value => historyFields(value, [...historyIdentity, 'claimId', 'evidenceIds', 'inspectionReceiptIds', 'result', 'reason', 'seat']);
function historyClaim(value) {
  return { ...historyFields(value, [...historyIdentity, 'kind', 'text', 'evidenceIds', 'status']),
    ...(value.retirement ? { retirement: historyDisposition(value.retirement) } : {}) };
}
function historyIssue(value) {
  return { ...historyFields(value, ['id', 'title', 'status', 'kind', 'blocking', 'claimIds', 'openedBy', 'needsHuman']),
    ...(value.disposition ? { disposition: historyDisposition(value.disposition) } : {}) };
}
function historyQuestion(value) {
  return { ...historyFields(value, [...historyIdentity, 'authority', 'kind', 'question', 'reason', 'decisionKind', 'issueIds', 'disputedIssueIds']),
    ...(value.issues ? { issues: value.issues.map(historyIssue) } : {}) };
}
function historyMessage(value) {
  return { ...historyFields(value, [...historyIdentity, 'schemaVersion', 'action', 'replyTo', 'content']),
    ...(value.claims ? { claims: value.claims.map(historyClaim) } : {}),
    ...(value.issues ? { issues: value.issues.map(historyIssue) } : {}),
    ...(value.evidence ? { evidence: value.evidence.map(item => typeof item === 'string' ? item : item.id) } : {}),
    ...(value.verifications ? { verifications: value.verifications.map(historyVerification) } : {}),
    ...(value.next !== undefined ? { next: value.next === null ? null : historyFields(value.next, ['seat', 'action', 'reason']) } : {}),
    ...(value.requests ? { requests: value.requests.map(item => historyFields(item, ['evidenceId', 'path', 'line', 'claimIds'])) } : {}),
    ...(value.memoryProposals ? { memoryProposals: value.memoryProposals.map(item => historyFields(item, ['id', 'content', 'kind', 'claimIds', 'issueId', 'tags'])) } : {}),
    ...(value.replan ? { replan: historyFields(value.replan, ['issueId', 'evidenceIds', 'novelty']) } : {}),
  };
}
export function planningHistory(state) {
  const map = (value, project) => Object.fromEntries(Object.entries(value).map(([id, item]) => [id, project(item)]));
  return { messages: state.messages.map(historyMessage), issues: map(state.issues, historyIssue), claims: map(state.claims, historyClaim),
    evidence: state.evidence, inspectionReceipts: state.inspectionReceipts, verifications: state.verifications.map(historyVerification),
    ...(state.humanRuling ? { humanRuling: { ...historyFields(state.humanRuling, [...historyIdentity, 'action']),
      answers: state.humanRuling.answers.map(item => historyFields(item, ['id', 'answer'])),
      ...(state.humanRuling.question ? { question: historyQuestion(state.humanRuling.question) } : {}),
    } } : {}) };
}

export function createPlanningHandoff({ result, target, directory }) {
  const saved = result?.checkpointState, state = saved?.dialogue;
  if (saved?.version !== 2 || saved.phase !== 'planning' || saved.tier !== 'plan' || !state
    || saved.runId !== result.runId || resolve(saved.directory) !== resolve(directory)
    || contextDigest(saved.approval) !== contextDigest(result.approval)
    || contextDigest(saved.planningArtifacts) !== contextDigest(result.planningArtifacts)
    || contextDigest({ state }) !== contextDigest({ state: result.dialogue })
    || state.snapshot.digest !== result.sharedContext?.digest
    || contextDigest(state.snapshot) !== contextDigest(result.sharedContext)) throw new Error('required native planning handoff records missing or stale');
  return validatePlanningHandoff({ target, directory, handoff: { schemaVersion: 1, runId: saved.runId, directory,
    requirements: saved.requirements, proposal: saved.proposal, approval: result.approval, snapshot: state.snapshot,
    stateDigest: contextDigest({ state }), history: planningHistory(state), journalIdentity: saved.journalIdentity,
    planningArtifacts: saved.planningArtifacts,
    evidenceCaptures: state.evidence.map(e => ({ id: e.id, bytes: readFileSync(e.capturedPath, 'utf8') })),
  } });
}

export function readPlanningHandoffReference({ reference, target, completedExecution }) {
  const snapshot = readSharedContextReference({ reference, target });
  const entries = snapshot.entries.filter(entry => entry.kind === 'planning-handoff');
  if (!reference.planningHandoff && entries.length === 0) return snapshot;
  if (!reference.planningHandoff || entries.length !== 1 || entries[0].status !== 'required'
    || snapshot.completeness?.complete !== true) throw new Error('required planning handoff reference missing or incomplete');
  const handoff = validatePlanningHandoff({ handoff: JSON.parse(entries[0].content), target, directory: reference.planningHandoff.directory, completedExecution });
  resolveNativeWorkflowBinding({ parentSnapshots: [snapshot, handoff.snapshot] });
  if (handoff.runId !== reference.planningHandoff.runId || handoff.approval.contextDigest !== reference.planningHandoff.contextDigest
    || handoff.approval.artifactDigest !== reference.planningHandoff.artifactDigest
    || handoff.approval.sidecarDigest !== reference.planningHandoff.sidecarDigest) throw new Error('planning handoff reference identity changed');
  return snapshot;
}

/** Create required common grounding before any author, selector or reviewer launch. */
export function openPlanningContext({ requirements, target, directory, runId, tier = 'plan', context = {},
  artifactRoot, env = process.env, searchIndex, phase = 'planning', retained, workflowBinding }) {
  assertNativeContext(context);
  if (retained) retained.validate();
  workflowBinding = resolveNativeWorkflowBinding({ workflowBinding,
    parentSnapshots: retained?.snapshot ? [retained.snapshot] : [] });
  mkdirSync(directory, { recursive: true });
  assertSidecarInventory({ directory, registeredPaths: [] });
  const project = resolveProjectIdentity({ target });
  let sourceRevision;
  try { sourceRevision = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { sourceRevision = `unversioned:${project.projectId}`; }
  const root = resolveArtifactRoot({ artifactRoot, env, scratchRoot: readEnv(env, 'SCRATCH_ROOT')
    ?? (process.platform === 'win32' ? 'C:/uro/w' : join(homedir(), '.uro', 'w')) });
  const memory = openProjectMemory({ artifactRoot: root, project, searchIndex });
  const text = typeof requirements === 'string' ? requirements : JSON.stringify(requirements);
  const recalled = memory.search({ text });
  const sourceIdentity = contextDigest({ requirements, sourceRevision });
  const entries = Object.entries({ ...context, requirements, target: project })
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([id, value]) => ({ id, kind: id, content: typeof value === 'string' ? value : JSON.stringify(value),
      sourceIdentity, provenance: { origin: 'phase-controller', runId }, status: 'required' }));
  entries.push({ id: 'memory-selection', kind: 'memory-selection', content: JSON.stringify({
    query: { text, tags: [] }, selectedVersionIds: recalled.map(record => record.versionId),
    status: recalled.searchStatus, error: recalled.searchError,
  }), sourceIdentity, provenance: { origin: 'harness-recall', projectId: project.projectId }, status: 'historical' });
  const evidenceDirectory = join(directory, '__uro_evidence');
  mkdirSync(evidenceDirectory, { recursive: true });
  const evidence = captureEvidence({ projectId: project.projectId, root: target, directory: evidenceDirectory,
    evidence: { id: 'requirement-briefing', kind: 'requirement', projectId: project.projectId, claimIds: ['briefing-requirement'],
      text, locator: { briefingId: `${runId}:${tier}` }, sourceIdentity } });
  const imported = [];
  if (retained) {
    retained.validate();
    entries.push({ id: 'retained-phase', kind: 'retained-phase', content: JSON.stringify(retained.context),
      sourceIdentity: retained.context.parent.runId, provenance: { origin: 'validated-phase-handoff', runId }, status: 'historical' });
    for (const original of retained.evidence) {
      const valid = validateEvidence({ evidence: original, projectId: project.projectId, roots: [target, ...retained.evidenceRoots] });
      if (!valid.valid) {
        if (original.kind !== 'code' || !['evidence is stale: current source digest differs', 'current evidence source is missing'].includes(valid.reason)) throw new Error(valid.reason);
        entries.push({ id: `historical-${original.id}`, kind: 'historical-source', content: JSON.stringify({
          evidence: original, bytes: readFileSync(original.capturedPath, 'utf8') }), sourceIdentity: original.sourceDigest,
          provenance: { origin: 'retained-source-capture', runId: retained.context.parent.runId }, status: 'historical' });
        continue;
      }
      const { capturedPath, sourceDigest, recordDigest, ...record } = original;
      imported.push(captureEvidence({ projectId: project.projectId, root: target, directory: evidenceDirectory,
        evidence: { ...record, id: `${retained.context.parent.runId}:${original.id}`,
          provenance: { origin: 'historical-phase-capture', runId: retained.context.parent.runId, originalEvidence: original }, historical: true } }));
    }
  }
  const snapshot = createSharedContext({ projectId: project.projectId, runId, unitId: `${runId}:${tier}`,
    phase, sourceRevision, workflowBinding, entries, evidence: [evidence, ...imported], recalled: recalled.map(record => ({
      ...record, id: record.versionId, notebookEntryId: record.id, status: 'historical', notebookStatus: record.status,
    })) });
  const path = persistSharedContext({ directory, snapshot });
  const journal = openDialogueJournal({ directory, runId, projectId: project.projectId });
  journal.append({ type: 'workflow-start', workflow: workflowIdentity({ binding: workflowBinding }), contextDigest: snapshot.digest });
  return { snapshot, workflowBinding, journal, memory, project, directory, artifactRoot: root, evidenceDirectory, contextPaths: new Map([[path, digestBytes(path)]]),
    ownedFiles: new Map([[path, digestBytes(path)], ...[evidence, ...imported].map(item => [item.capturedPath, digestBytes(item.capturedPath)]),
      ...['journal.jsonl', 'journal-tail.jsonl'].map(name => [join(directory, '__uro_dialogue', name), null])]),
    preparationMessages: [], retained,
    recall: { status: recalled.searchStatus, error: recalled.searchError } };
}

export function reopenPlanningContext({ continuation, target, directory }) {
  const snapshot = continuation.dialogue?.snapshot ?? continuation.preparationSnapshot;
  const project = resolveProjectIdentity({ target });
  if (project.projectId !== snapshot.projectId) throw new Error('saved planning project identity changed');
  const path = join(directory, '__uro_context', `${snapshot.id}.json`);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  validateSharedContext({ snapshot: stored, projectId: project.projectId });
  if (stored.digest !== snapshot.digest) throw new Error('saved shared context identity changed');
  const manifest = continuation.executionArtifacts ?? continuation.planningArtifacts;
  if (!manifest || manifest.runId !== snapshot.runId || manifest.contextDigest !== snapshot.digest
    || resolve(manifest.directory) !== resolve(directory)) throw new Error('saved planning sidecar provenance missing or stale');
  const registeredPaths = manifest.files.map(file => join(directory, file.path));
  if (contextDigest({ manifest }) !== contextDigest({ manifest: planningSidecarManifest({ directory, runId: snapshot.runId,
    contextDigest: snapshot.digest, registeredPaths }) })) throw new Error('saved planning sidecar manifest changed');
  const journal = openDialogueJournal({ directory, runId: snapshot.runId, projectId: project.projectId });
  try {
    const events = journal.read();
    if (events.at(-1)?.hash !== continuation.journalIdentity.hash || events.at(-1)?.sequence !== continuation.journalIdentity.sequence) throw new Error('saved planning journal identity changed');
    const preparing = !continuation.dialogue && Boolean(continuation.preparationSnapshot);
    const latest = events.filter(e => preparing ? ['preparation-state', 'preparation-paused'].includes(e.type) : e.type === 'state').at(-1)?.state;
    if (contextDigest({ state: latest ?? null }) !== contextDigest({ state: preparing ? continuation.preparationState : continuation.dialogue })) throw new Error('saved planning dialogue differs from journal');
    const workflowStart = events.find(event => event.type === 'workflow-start');
    const workflowBinding = readWorkflowBinding({ snapshot, expected: continuation.workflow, allowLegacy: true });
    if (workflowBinding.mode === 'bound' && (!workflowStart || !continuation.workflow)) throw new Error('bound workflow continuation identity missing');
    if (workflowStart) readWorkflowBinding({ snapshot, expected: workflowStart.workflow, allowLegacy: true });
    if (latest) createDialogueState({ ...latest, continuation: latest });
    return { snapshot, workflowBinding, journal, project, directory, ...(preparing ? { preparationMessages: latest?.messages ?? [], resourceBudget: continuation.resourceBudget } : { dialogue: latest }), artifactRoot: continuation.artifactRoot,
      memory: openProjectMemory({ artifactRoot: continuation.artifactRoot, project }),
      evidenceDirectory: join(directory, '__uro_evidence'),
      ownedFiles: new Map(manifest.files.map(file => [join(directory, file.path), file.path.startsWith('__uro_dialogue/') ? null : file.sha256])),
      contextPaths: new Map(manifest.files.filter(file => file.path.startsWith('__uro_context/')).map(file => [join(directory, file.path), file.sha256])), recall: continuation.recall };
  } catch (error) { journal.close(); throw error; }
}

export function applyScopedHumanRuling({ session, state: saved, humanRuling }) {
  const question = nativeHumanQuestion({ dialogue: saved });
  if (!question || !humanRuling?.decisionId || humanRuling.answers?.length !== 1
    || humanRuling.answers[0].id !== question.id) throw new Error('human answer does not match the native question');
  const state = structuredClone(saved);
  const entryId = `${state.runId}:human:${humanRuling.decisionId}`;
  const content = humanRuling.answers[0].answer;
  state.snapshot = extendSharedContext({ snapshot: state.snapshot, entries: [{ id: entryId,
    kind: 'human-decision', content, sourceIdentity: humanRuling.decisionId,
    provenance: { origin: 'validated-human-answer', question, decisionId: humanRuling.decisionId }, status: 'required' }] });
  state.messages.push({ id: entryId, sender: 'human', speaker: 'human', phase: state.phase,
    action: 'answer', replyTo: question.messageId, content, artifactDigest: state.artifactDigest,
    contextDigest: state.snapshot.digest, decisionId: humanRuling.decisionId, sequence: state.messages.length + 1 });
  state.humanRuling = { ...humanRuling, question, artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest };
  if (question.decisionKind === 'merge-conflicting-intent') state.mergeHumanReview = {
    operationId: question.operationId, decisionId: humanRuling.decisionId, artifactDigest: state.artifactDigest,
    contextDigest: state.snapshot.digest, status: 'pending' };
  for (const id of question.issueIds ?? []) state.issues[id].needsHuman = false;
  state.pendingDecision = null; state.approval = null; state.terminalAction = null;
  state.technicalPause = null;
  state.next = { seat: state.reviewer, action: 'verify', reason: 'Assess scoped human direction against current retained work' };
  persistContext(session, state.snapshot);
  session.journal.append({ type: 'human-ruling', ruling: state.humanRuling });
  session.journal.append({ type: 'state', state });
  session.dialogue = state; session.snapshot = state.snapshot;
  return state;
}

function assertCompletedEffects(session, saved) {
  for (const event of session.journal.read().filter(event => event.type === 'prepare')) {
    if (session.journal.operation(event.operationId).status !== 'completed') throw new Error('uncertain prepared external effect requires reconciliation; replay refused');
  }
  if (saved.pendingOperation && session.journal.operation(saved.pendingOperation.operationId)?.status !== 'completed') {
    throw new Error('uncertain pending operation requires reconciliation');
  }
}

function assertTechnicalContinuation({ session, state: saved, account = session.journal.account(), ceiling = saved.resourceBudget?.tokenBudget,
  prior = saved.resourceBudget?.prior }) {
  if (!saved.technicalPause || saved.pendingDecision) throw new Error('technical continuation requires a technical pause without a human decision');
  assertCompletedEffects(session, saved);
  if (saved.pendingOperation) {
    const operation = session.journal.operation(saved.pendingOperation.operationId);
    if (!operation || operation.status !== 'completed') throw new Error('uncertain pending operation requires reconciliation');
    if (['provider', 'repair'].includes(operation.effect)) {
      if (operation.result?.error || operation.result?.timedOut || operation.result?.aborted) throw new Error('uncertain provider outcome requires reconciliation');
      try { parseDialogueEnvelope({ response: operation.result }); }
      catch { throw new Error('unreadable saved provider outcome requires reconciliation'); }
    }
  }
  if (!saved.next && !saved.pendingOperation) throw new Error('technical pause has no known safe next effect');
  if (ceiling !== undefined && (account.usageUnknown || prior?.usageUnknown)) throw new Error('accounting-incomplete: unknown saved usage');
  if (ceiling !== undefined && account.knownUsage.inputTokens + account.knownUsage.outputTokens
    + (prior?.knownUsage?.inputTokens ?? 0) + (prior?.knownUsage?.outputTokens ?? 0) >= ceiling) throw new Error('budget-exhausted: saved budget cannot change');
  if (/limit reached|budget exhausted|budget-exhausted|accounting-incomplete|irreparable|liveness|reconciliation/i.test(saved.technicalPause.reason)) {
    throw new Error(`unsafe technical continuation: ${saved.technicalPause.reason}`);
  }
}

/** Validate the complete native input before accepting an answer or continuation receipt. */
export function validateNativeContinuation(continuation, { technicalContinue = false, humanRuling } = {}) {
  if (continuation.version !== 2 || !(continuation.dialogue ?? continuation.preparationSnapshot)) throw new Error('native dialogue or preparation checkpoint required');
  const workspace = continuation.workspace?.dir ?? continuation.executionContinuation?.workspace?.dir;
  if (continuation.options?.contextRef) readPlanningHandoffReference({ reference: continuation.options.contextRef,
    target: continuation.workspace.targetPath });
  const question = nativeHumanQuestion(continuation);
  if (continuation.phase === 'planning' && question?.decisionKind === 'manual-dispute'
    && /^approve(?:\s*:|\s*$)/i.test(humanRuling?.answers?.[0]?.answer ?? '')) {
    assertHumanPlanningApproval({ state: continuation.dialogue, question, humanRuling });
  }
  if (question?.decisionKind === 'merge-conflicting-intent') {
    const progress = continuation.dialogue.mergeProgress;
    const operation = continuation.dialogue.operations[question.operationId];
    const ledger = join(workspace, MERGE_LEDGER_FILENAME);
    const gitRead = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let mergeHead = null;
    try { mergeHead = gitRead('rev-parse', '-q', '--verify', 'MERGE_HEAD'); } catch { /* No merge head is also identity. */ }
    if (!existsSync(ledger) || lstatSync(ledger).isSymbolicLink() || digestBytes(ledger) !== question.ledger.sha256
      || gitRead('rev-parse', 'HEAD') !== progress.head || mergeHead !== progress.mergeHead
      || gitRead('ls-files', '--stage') !== operation.selection.index) throw new Error('saved merge ledger or Git identity changed');
  }
  const phases = [...(continuation.phaseChain ?? []).filter(item => item.runId !== continuation.runId),
    { runId: continuation.runId, directory: continuation.directory, phase: continuation.phase, checkpointState: continuation }];
  const ids = new Set();
  let workflowBinding;
  const total = { knownUsage: { inputTokens: 0, outputTokens: 0 }, usageUnknown: false };
  for (const phase of phases) {
    const state = phase.checkpointState, dialogue = state?.dialogue, snapshot = dialogue?.snapshot ?? state?.preparationSnapshot;
    if (ids.has(phase.runId) || !snapshot || phase.runId !== snapshot.runId || phase.runId !== state.runId
      || phase.phase !== snapshot.phase || state.phase !== phase.phase || resolve(phase.directory) !== resolve(state.directory)) throw new Error('native phase identity changed');
    ids.add(phase.runId);
    if (workspace) {
      const rel = relative(realpathSync.native(workspace), realpathSync.native(phase.directory));
      if (rel.startsWith('..') || isAbsolute(rel) || lstatSync(phase.directory).isSymbolicLink()) throw new Error('native phase workspace escape');
    }
    const target = workspace ?? continuation.planningContext?.request?.target;
    const session = reopenPlanningContext({ continuation: state, target, directory: phase.directory });
    try {
      workflowBinding = resolveNativeWorkflowBinding({ workflowBinding, parentSnapshots: [session.snapshot] });
      assertCompletedEffects(session, session.dialogue ?? state.preparationState ?? {});
      const account = session.journal.account();
      total.usageUnknown ||= account.usageUnknown;
      total.knownUsage.inputTokens += account.knownUsage.inputTokens;
      total.knownUsage.outputTokens += account.knownUsage.outputTokens;
      if (phase.runId === continuation.runId && technicalContinue) {
        const resourceBudget = dialogue?.resourceBudget ?? state.resourceBudget;
        if (!dialogue) {
          if (state.technicalPause?.reason !== 'reviewer-unavailable' || state.candidateState?.selection
            || state.candidateState?.selectedCandidateId || !state.candidateState?.candidates?.length
            || state.candidateState.candidates.some(candidate => !candidate.gateResult?.passed || candidate.repairable)) {
            throw new Error(`unsafe preparation continuation requires reconciliation: ${state.technicalPause?.reason}`);
          }
          for (const candidate of state.candidateState.candidates) {
            const operationId = candidate.response?.preparationOperationId;
            const artifact = session.journal.read().find(event => event.type === 'candidate-artifact' && event.operationId === operationId);
            if (!artifact || artifact.artifactDigest !== planningArtifactDigest(state.requirements, { plan: candidate.plan, gate: candidate.gate })) throw new Error('saved preparation candidate identity changed');
          }
        }
        assertTechnicalContinuation({ session, state: dialogue ?? { technicalPause: state.technicalPause, next: { seat: 'codex', action: 'verify' } },
          account: total, ceiling: continuation.options?.tokenBudget ?? resourceBudget?.tokenBudget,
          prior: workspace ? null : resourceBudget?.prior });
      }
    } finally { session.journal.close(); }
  }
  for (const link of continuation.phaseLinks ?? []) {
    if (!workspace || !ids.has(link.runId) || lstatSync(link.path).isSymbolicLink() || digestBytes(link.path) !== link.digest) throw new Error('retained phase handoff changed');
    const context = JSON.parse(readFileSync(link.path, 'utf8'));
    const parent = phases.find(phase => phase.runId === context.parent?.runId), child = phases.find(phase => phase.runId === context.child?.runId);
    if (!parent || !child || child.runId !== link.runId || context.child.directory !== child.directory
      || context.workspace.directory !== workspace || context.workspace.baseCommit !== continuation.workspace.baseCommit
      || context.parent.stateDigest !== contextDigest({ state: parent.checkpointState.dialogue })
      || context.parent.contextDigest !== parent.checkpointState.dialogue.snapshot.digest) throw new Error('retained phase parent identity changed');
  }
}

export function resumeTechnicalDialogue({ session, state: saved }) {
  assertTechnicalContinuation({ session, state: saved });
  const state = structuredClone(saved);
  state.technicalPause = null;
  session.journal.append({ type: 'technical-continue', previousPause: saved.technicalPause });
  session.journal.append({ type: 'state', state });
  session.dialogue = state;
  return state;
}

function checkContext(session) {
  try {
  session.retained?.validate();
  session.journal.read();
  assertSidecarInventory({ directory: session.directory,
    registeredPaths: [...session.ownedFiles.keys(), join(session.directory, '__uro_dialogue', 'controller.lock')] });
  for (const [path, digest] of session.contextPaths) {
    if (!existsSync(path) || digestBytes(path) !== digest) throw new Error('persisted shared context changed during provider access');
    validateSharedContext({ snapshot: JSON.parse(readFileSync(path, 'utf8')), projectId: session.project.projectId });
  }
  for (const [path, digest] of session.ownedFiles) if (digest !== null && digestBytes(path) !== digest) throw new Error('registered planning sidecar bytes changed');
  } catch (error) {
    if (session.retained) error.retainedIntegrityFailure = true;
    throw error;
  }
}

function registerEvidenceFiles(session, evidence) {
  for (const item of evidence) if (!session.ownedFiles.has(item.capturedPath)) session.ownedFiles.set(item.capturedPath, item.sourceDigest);
}
function persistContext(session, snapshot) {
  const path = join(session.directory, '__uro_context', `${snapshot.id}.json`);
  if (!session.contextPaths.has(path)) {
    persistSharedContext({ directory: session.directory, snapshot });
    session.contextPaths.set(path, digestBytes(path)); session.ownedFiles.set(path, digestBytes(path));
  }
}
function publishPreparationMaterial(session, state) {
  const material = structuredClone(state);
  material.snapshot = session.snapshot;
  installMaterialEvidence(material);
  session.snapshot = material.snapshot;
  persistContext(session, session.snapshot);
  checkContext(session);
}

/** Frozen prior spend plus this phase's live journal; never roll the same phase into prior. */
export function createPlanningBudgetGuard({ session, resourceBudget, budget }) {
  if (resourceBudget !== undefined) {
    const prior = resourceBudget?.prior;
    if (!Number.isSafeInteger(resourceBudget?.tokenBudget) || resourceBudget.tokenBudget < 1
      || !prior || typeof prior.usageUnknown !== 'boolean'
      || !Number.isSafeInteger(prior.providerLaunches) || prior.providerLaunches < 0
      || !['inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(prior.knownUsage?.[key]) && prior.knownUsage[key] >= 0)) {
      throw new Error('invalid saved planning resource budget');
    }
    if (session.resourceBudget && JSON.stringify(session.resourceBudget) !== JSON.stringify(resourceBudget)) throw new Error('saved planning resource budget cannot change');
    session.resourceBudget ??= structuredClone(resourceBudget);
  }
  if (!session.resourceBudget && typeof budget !== 'function') return undefined;
  return async request => {
    const account = session.journal.account();
    const saved = session.resourceBudget;
    const consumed = saved ? {
      inputTokens: saved.prior.knownUsage.inputTokens + account.knownUsage.inputTokens,
      outputTokens: saved.prior.knownUsage.outputTokens + account.knownUsage.outputTokens,
      providerLaunches: saved.prior.providerLaunches + account.providerLaunches,
      usageUnknown: saved.prior.usageUnknown || account.usageUnknown,
    } : null;
    let decision = consumed?.usageUnknown ? { allowed: false, reason: 'accounting-incomplete: unknown usage under enforced budget' }
      : consumed && consumed.inputTokens + consumed.outputTokens >= saved.tokenBudget
        ? { allowed: false, reason: 'budget-exhausted: token budget reached' } : { allowed: true };
    if (decision.allowed && typeof budget === 'function') {
      try {
        const additional = await budget({ ...request, account: structuredClone(account) });
        if (additional?.allowed !== true) decision = { allowed: false, reason: additional?.reason ?? 'budget-exhausted: caller resource guard denied launch' };
      } catch (error) { decision = { allowed: false, reason: `accounting-incomplete: ${error.message}` }; }
    }
    session.journal.append({ type: 'budget-check', nextAction: request.nextAction,
      resourceBudget: saved ?? null, account, consumed, decision });
    return decision;
  };
}

/** Alternatives are independent proposals, with serialized, accounted preparation calls. */
export async function callPlanningPreparation({ session, requirements, input, call, seat, action, request = {}, previousPreparationOperationId, budget }) {
  checkContext(session);
  let allocatedRepairCycle = null;
  let state = createDialogueState({ runId: session.snapshot.runId, projectId: session.project.projectId,
    phase: 'planning', interactionMode: request.interactionMode, snapshot: session.snapshot,
    artifactDigest: contextDigest({ requirements, proposal: null }),
    scope: { sourceRoots: [session.project.root], evidenceRoots: [session.evidenceDirectory] } });
  if (previousPreparationOperationId) {
    const previous = session.journal.read().find(event => event.type === 'preparation-state' && event.operationId === previousPreparationOperationId);
    if (!previous || previous.candidateId !== request.candidateId || seat !== 'claude' || action !== 'propose') throw new Error('candidate repair preparation identity mismatch');
    state = structuredClone(previous.state);
    state.snapshot = session.snapshot;
    state.evidence = structuredClone(session.snapshot.evidence);
    state.pendingArtifact = null; state.pendingOperation = null;
    allocatedRepairCycle = state.proposalCycles;
    state.proposalCycles--; // Known artifact-format repair reuses the allocated proposal cycle.
  }
  state.messages = structuredClone(session.preparationMessages);
  let failedResponse, repairOf;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Capture the current published material even if this attempted dispatch is denied.
    state.snapshot = structuredClone(session.snapshot);
    if (budget) {
      const decision = await budget({ state: structuredClone(state), account: session.journal.account(),
        nextAction: { seat, action: attempt ? 'repair' : action } });
      if (decision?.allowed !== true) {
        if (allocatedRepairCycle !== null) state.proposalCycles = allocatedRepairCycle;
        state.technicalPause = { reason: decision?.reason ?? 'budget-exhausted' };
        state.resourceBudget = session.resourceBudget;
        session.journal.append({ type: 'preparation-paused', candidateId: request.candidateId ?? null, state,
          ...(repairOf ? { repairOf } : {}), ...(previousPreparationOperationId ? { previousPreparationOperationId } : {}) });
        return { budgetPaused: true, reason: state.technicalPause.reason };
      }
    }
    // A completed malformed response may have published authenticated material.
    // The new operation uses that current context; the old input remains history.
    const completeInput = [dialoguePromptText(input), renderSharedContext({ snapshot: state.snapshot }),
      'Return one UROBOROS_DIALOGUE JSON envelope beside artifact/selection tags. schemaVersion:1; action:' + action +
        '; replyTo:null; content:explanation; claims:[]; issues:[]; evidence:[]; verifications:[]; next:null.',
      JSON.stringify({ artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest,
        preparationMessages: state.messages, issues: state.issues, claims: state.claims, memoryProposals: state.memoryProposals })].join('\n\n');
    const operationId = `${state.runId}:candidate:${randomUUID()}`;
    const submitted = completeInput + (attempt ? `\nFORMAT REPAIR ONLY. Preserve the saved substance and return the required envelope using the current prepared input identities above. Original prepared input provenance (historical): ${JSON.stringify(repairOf)}\nPrevious response:\n${JSON.stringify(failedResponse)}` : '');
    session.journal.prepare({ operationId, seat, effect: attempt ? 'repair' : 'provider', action, input: submitted,
      candidateId: request.candidateId ?? null,
      ...(attempt ? { repairOf } : {}),
      contextDigest: state.snapshot.digest, artifactDigest: state.artifactDigest,
      evidenceIds: state.evidence.map(e => e.id), unreadMessageIds: [] });
    let response;
    try {
      const invoke = () => call({ ...request, input: submitted, dialogueMode: true, state: structuredClone(state), operationId, action: attempt ? 'repair' : action });
      response = session.retained?.protect ? await session.retained.protect(invoke, { operationId, seat, effect: attempt ? 'repair' : 'provider' }) : await invoke();
    }
    catch (error) {
      if (error.retainedIntegrityFailure) throw error;
      response = { error: error.message, unavailable: true };
    }
    response = typeof response === 'string' ? { content: response, answer: response } : {
      ...response, content: response?.content ?? response?.answer ?? response?.lastMessage ?? '',
    };
    session.journal.complete({ operationId, result: response, usage: response.usage ?? null, delivery: response.delivery ?? null });
    const operation = session.journal.operation(operationId);
    registerObservations(state, operation, response.observations);
    registerEvidenceFiles(session, state.evidence);
    checkContext(session);
    if (response.error || response.unavailable || response.launchFailed || response.timedOut) {
      publishPreparationMaterial(session, state); return response;
    }
    let envelope;
    try { envelope = parseDialogueEnvelope({ response }); }
    catch (error) {
      publishPreparationMaterial(session, state);
      if (attempt) throw error;
      failedResponse = response;
      repairOf = { operationId, artifactDigest: operation.artifactDigest, contextDigest: operation.contextDigest };
      continue;
    }
    state.pendingOperation = { operationId, seat, effect: operation.effect, action };
    const previousNext = state.next;
    try {
      if (envelope.action !== action) throw new Error(`candidate preparation requires explicit ${action}`);
      state = applyDialogueEnvelope({ state, envelope, seat });
    } finally { publishPreparationMaterial(session, state); }
    if (previousPreparationOperationId && envelope.next === null) state.next = previousNext;
    state.pendingOperation = null;
    const message = state.messages.at(-1);
    message.candidateId = request.candidateId ?? null;
    session.preparationMessages = structuredClone(state.messages);
    session.journal.append({ type: 'preparation-state', operationId, candidateId: request.candidateId ?? null, state });
    return { ...response, preparationOperationId: operationId };
  }
}

// Only journal-validated preparation state is eligible to become the selected live state.
function selectedPreparationState(session, prelude, requirements) {
  const events = session.journal.read();
  const prepared = events.filter(event => event.type === 'preparation-state');
  const selected = prepared.find(event => event.operationId === prelude.preparationOperationId);
  if (!selected || selected.state.pendingArtifact?.providerOperationId !== selected.operationId) throw new Error('selected candidate lacks authenticated preparation');
  const artifact = session.journal.read().find(event => event.type === 'candidate-artifact' && event.operationId === selected.operationId);
  if (!artifact || artifact.artifactDigest !== planningArtifactDigest(requirements, prelude.proposal)) throw new Error('selected candidate differs from its validated saved artifact');
  const state = structuredClone(selected.state);
  const selector = prepared.find(event => event.operationId === prelude.selectionOperationId);
  if (selector) {
    for (const field of ['claims', 'issues']) for (const [id, value] of Object.entries(selector.state[field])) {
      if (state[field][id] && JSON.stringify(state[field][id]) !== JSON.stringify(value)) throw new Error(`selected/selector ${field} identity conflict`);
      state[field][id] = value;
    }
    for (const proposal of selector.state.memoryProposals) {
      if (state.memoryProposals.some(old => old.id === proposal.id)) throw new Error('selected/selector memory identity conflict');
      state.memoryProposals.push(proposal);
    }
    state.verifications.push(...selector.state.verifications);
    if (selector.state.messages.at(-1).next) state.next = selector.state.next;
  }
  // Rejected alternatives stay explicitly attributed history, never live premises.
  session.snapshot = extendSharedContext({ snapshot: session.snapshot, entries: [{ id: 'candidate-preparation-history', kind: 'candidate-history',
    content: JSON.stringify([...prepared.map(event => ({ operationId: event.operationId, candidateId: event.candidateId,
      status: event === selected ? 'selected' : event === selector ? 'selection' : 'not-selected',
      messages: event.state.messages.filter(message => message.operationId === event.operationId),
      claims: event.state.claims, issues: event.state.issues, memoryProposals: event.state.memoryProposals, next: event.state.next })),
      ...events.filter(event => event.type === 'prepare' && ['provider', 'repair'].includes(event.effect)
        && !prepared.some(record => record.operationId === event.operationId)).map(event => ({ operationId: event.operationId,
          candidateId: event.candidateId, status: 'unparsed-or-unavailable', response: session.journal.operation(event.operationId)?.result }))]),
    sourceIdentity: selected.operationId, provenance: { origin: 'validated-preparation-journal', runId: state.runId }, status: 'historical' }] });
  persistContext(session, session.snapshot);
  state.snapshot = session.snapshot;
  state.evidence = structuredClone(session.snapshot.evidence);
  state.messages = structuredClone(session.preparationMessages);
  for (const event of prepared) {
    Object.assign(state.operations, event.state.operations);
    Object.assign(state.inspectionReceipts, event.state.inspectionReceipts);
  }
  // Installing the already parsed saved artifact changes current identity, never historical claim identities.
  state.artifactDigest = artifact.artifactDigest;
  state.pendingArtifact = null; state.pendingOperation = null; state.approval = null;
  session.journal.append({ type: 'selected-preparation', operationId: selected.operationId,
    selectionOperationId: selector?.operationId ?? null, artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest });
  return state;
}

function promoteMemory(session, state) {
  for (const proposal of state.memoryProposals) {
    const issue = proposal.issueId && state.issues[proposal.issueId];
    if (!state.approval && !issue?.disposition) continue;
    const claims = proposal.claimIds.map(id => state.claims[id]);
    const verified = claims.every(claim => claim && claim.status === 'active'
      && claim.artifactDigest === state.artifactDigest && claim.contextDigest === state.snapshot.digest
      && state.verifications.some(v => v.claimId === claim.id && v.seat === state.reviewer && v.result === 'supports'
        && v.artifactDigest === state.artifactDigest && v.contextDigest === state.snapshot.digest)
      && !state.verifications.some(v => v.claimId === claim.id && v.result !== 'supports'
        && v.artifactDigest === state.artifactDigest && v.contextDigest === state.snapshot.digest));
    const operationId = `${state.runId}:memory:${proposal.id}`;
    if (session.journal.operation(operationId)) continue;
    const entry = { id: proposal.id, kind: proposal.kind, content: proposal.content, tags: proposal.tags,
      sourceIdentity: state.snapshot.digest, provenance: { ...proposal.provenance, promotionOperationId: operationId },
      status: verified ? 'verified' : issue?.status === 'disputed' ? 'disputed' : 'unsupported',
      claims, evidence: state.evidence.filter(e => claims.some(c => c?.evidenceIds.includes(e.id))),
      disposition: issue?.disposition ?? { kind: 'approved', messageId: state.approval?.messageId } };
    session.journal.prepare({ operationId, seat: 'harness', effect: 'memory', input: JSON.stringify(entry),
      contextDigest: state.snapshot.digest, artifactDigest: state.artifactDigest, evidenceIds: entry.evidence.map(e => e.id), unreadMessageIds: [] });
    const result = session.memory.append({ entry });
    session.journal.complete({ operationId, result, usage: null, delivery: null });
  }
}

// Execution shares the same exact-file provenance and notebook disposition checks.
export const contextLifecycle = Object.freeze({ checkContext, registerEvidenceFiles, persistContext, promoteMemory,
  manifest: planningSidecarManifest });

/** Direct human artifact authority is scoped risk acceptance, never a fabricated verification. */
export function assertHumanPlanningApproval(options) { return humanPlanningApproval(options, validateDialogueEvidence); }

function humanPlanningApproval({ state, question = state?.humanRuling?.question, humanRuling = state?.humanRuling }, checkEvidence) {
  validateSharedContext({ snapshot: state?.snapshot, projectId: state?.projectId });
  if (state.phase !== 'planning' || state.interactionMode !== 'manual' || question?.decisionKind !== 'manual-dispute'
    || question.artifactDigest !== state.artifactDigest || question.contextDigest !== state.snapshot.digest
    || !humanRuling?.decisionId || humanRuling.answers?.length !== 1 || humanRuling.answers[0].id !== question.id
    || !/^approve(?:\s*:|\s*$)/i.test(humanRuling.answers[0].answer)) throw new Error('human approval question or answer identity changed');
  if (state.snapshot.completeness?.complete !== true) throw new Error('required context incomplete');
  if (state.technicalPause || state.pendingArtifact || state.pendingOperation) throw new Error('human approval has pending technical work');
  const scope = new Set(question.disputedIssueIds);
  if (!scope.size) throw new Error('human approval has no identified dispute');
  for (const id of scope) {
    const issue = state.issues[id];
    if (!issue || !(issue.status === 'disputed' || issue.status === 'resolved' && issue.disposition?.by === 'human'
      && issue.disposition.decisionId === humanRuling.decisionId)) throw new Error('human approval dispute scope changed');
  }
  const open = issue => ['open', 'awaiting-answer', 'awaiting-verification', 'disputed'].includes(issue.status);
  if (Object.values(state.issues).some(issue => issue.blocking && open(issue) && !scope.has(issue.id))) throw new Error('unrelated open blocking issue prevents human approval');
  const current = item => item.artifactDigest === state.artifactDigest && item.contextDigest === state.snapshot.digest;
  for (const claim of Object.values(state.claims).filter(claim => claim.status !== 'retired' && ['fact', 'inference'].includes(claim.kind))) {
    const scoped = [...scope].some(id => state.issues[id].claimIds.includes(claim.id));
    if (!scoped && !current(claim)) continue;
    if (!claim.evidenceIds?.length) throw new Error(`claim ${claim.id} requires evidence`);
    for (const id of claim.evidenceIds) checkEvidence(state, state.evidence.find(e => e.id === id));
    const usedElsewhere = Object.values(state.issues).some(issue => !scope.has(issue.id)
      && (open(issue) && issue.claimIds?.includes(claim.id) || issue.disposition?.claimIds?.includes(claim.id)));
    if (scoped && !usedElsewhere) continue;
    const assessments = state.verifications.filter(v => v.claimId === claim.id && current(v));
    if (!assessments.some(v => v.seat === state.reviewer && v.result === 'supports')
      || assessments.some(v => v.result !== 'supports')) throw new Error(`claim ${claim.id} requires reviewer support verification`);
  }
  return true;
}

/** New runs use explicit dialogue; historical runConversation remains a separate reader. */
export async function runPlanningDialogue({ requirements, target, directory, tier = 'plan', interactionMode = 'manual',
  rounds, runId = `planning-${randomUUID()}`, seats, strategy, reporter, context, artifactRoot, env, searchIndex,
  session: suppliedSession, continuation, humanRuling, technicalContinue = false, prelude, budget, resourceBudget, retained, workflowBinding }) {
  const session = suppliedSession ?? (continuation ? reopenPlanningContext({ continuation, target, directory })
    : openPlanningContext({ requirements, target, directory, runId, tier, context, retained, workflowBinding, artifactRoot, env, searchIndex }));
  resolveNativeWorkflowBinding({ workflowBinding, parentSnapshots: [session.snapshot] });
  let proposal = prelude?.proposal ?? continuation?.proposal ?? null;
  let state = session.dialogue ?? continuation?.dialogue ?? (prelude?.preparationOperationId ? selectedPreparationState(session, prelude, requirements) : createDialogueState({ runId, projectId: session.project.projectId,
    phase: 'planning', interactionMode, snapshot: session.snapshot,
    artifactDigest: proposal ? planningArtifactDigest(requirements, proposal) : contextDigest({ requirements, proposal: null }),
    limits: { ...(rounds === undefined ? {} : { rounds }), artifactRepairs: MAX_ARTIFACT_REPAIRS }, scope: { sourceRoots: [target], evidenceRoots: [session.evidenceDirectory] } }));
  if (!continuation) {
    if (!prelude?.preparationOperationId) state.next = proposal ? { seat: 'codex', action: 'verify', reason: 'Review selected proposal' }
      : { seat: 'claude', action: 'propose', reason: 'Draft the initial proposal' };
    state.proposalCycles = proposal ? 1 : 0;
    state.artifactRepairs = prelude?.artifactRepairs ?? 0;
    state.limits = { ...(rounds === undefined ? {} : { rounds }), artifactRepairs: MAX_ARTIFACT_REPAIRS };
  }
  const requestFor = ({ state, seat, action, input, operationId }) => ({ state, input, operationId, action,
    dialogueMode: true, type: action === 'propose' && !proposal && !state.artifactRepair ? 'draft' : action,
    round: state.proposalCycles + (['propose', 'revise'].includes(action) ? 1 : 0),
    interactionMode, artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest,
    previousProposal: proposal ? (strategy.proposalText?.(proposal) ?? proposal.plan ?? JSON.stringify(proposal)) : '',
    feedback: state.artifactRepair?.reason ?? state.messages.at(-1)?.content ?? '', messages: state.messages,
    ...(seat === 'codex' && proposal ? strategy.reviewRequests?.({ proposal, round: state.proposalCycles })?.codex : {}),
    ...(seat === 'claude' ? strategy.draftRequest?.({}) : {}),
  });
  try {
    if (continuation?.resourceBudget && resourceBudget !== undefined
      && JSON.stringify(continuation.resourceBudget) !== JSON.stringify(resourceBudget)) throw new Error('saved planning resource budget cannot change');
    const budgetGuard = createPlanningBudgetGuard({ session,
      resourceBudget: continuation?.resourceBudget ?? resourceBudget, budget });
    if (session.resourceBudget) state.resourceBudget = structuredClone(session.resourceBudget);
    let humanAction = null;
    if (technicalContinue) state = resumeTechnicalDialogue({ session, state });
    if (humanRuling) {
      const question = nativeHumanQuestion({ dialogue: state });
      if (question?.decisionKind !== 'manual-dispute') {
        state = applyScopedHumanRuling({ session, state, humanRuling });
      } else {
      if (state.interactionMode !== 'manual' || !state.pendingDecision || !humanRuling.decisionId) throw new Error('human ruling has no current manual decision');
      if (planningArtifactDigest(requirements, proposal) !== state.artifactDigest) throw new Error('saved planning artifact identity changed');
      const content = humanRuling.answers.map(answer => answer.answer).join('\n');
      humanAction = /^approve(?:\s*:|\s*$)/i.test(content) ? 'approve' : /^stop(?:\s*:|\s*$)/i.test(content) ? 'stop' : null;
      if (humanAction === 'approve') assertHumanPlanningApproval({ state, question, humanRuling });
      state = structuredClone(state);
      state.messages.push({ id: `${runId}:human:${humanRuling.decisionId}`, sender: 'human', speaker: 'human',
        phase: 'planning', action: 'decide', content, artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest,
        decisionId: humanRuling.decisionId, sequence: state.messages.length + 1 });
      state.humanRuling = { ...humanRuling, question, action: humanAction, artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest };
      if (humanAction === 'approve') for (const id of question.disputedIssueIds) {
        state.issues[id] = { ...state.issues[id], status: 'resolved', disposition: {
          kind: 'accepted', by: 'human', basis: 'risk-acceptance', reason: content, claimIds: [],
          decisionId: humanRuling.decisionId, messageId: state.messages.at(-1).id,
          artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest,
        } };
      }
      state.pendingDecision = null;
      state.next = { seat: 'codex', action: 'verify', reason: 'Assess the human clarification' };
      session.journal.append({ type: 'human-ruling', ruling: state.humanRuling });
      session.journal.append({ type: 'state', state });
      }
    }
    const result = humanAction ? { state, approved: humanAction === 'approve', action: humanAction === 'approve' ? 'complete' : 'stop',
      reason: state.messages.at(-1).content, messages: state.messages, rounds: state.proposalCycles, resources: session.journal.account() }
      : await runIssueDialogue({ state, journal: session.journal, budget: budgetGuard,
      seats: Object.fromEntries([['claude', seats.author], ['codex', seats.reviewCodex]].map(([seat, call]) => [seat, async request => {
        checkContext(session);
        const invoke = () => call(requestFor({ ...request, seat }));
        const response = session.retained?.protect ? await session.retained.protect(invoke, { operationId: request.operationId, seat, effect: request.action === 'repair' ? 'repair' : 'provider' }) : await invoke();
        const observed = structuredClone(request.state);
        registerObservations(observed, session.journal.operation(request.operationId), response?.observations);
        registerEvidenceFiles(session, observed.evidence);
        checkContext(session);
        const normalized = typeof response === 'string' ? { content: response } : { ...response,
          content: response?.content ?? response?.answer ?? response?.lastMessage ?? '' };
        if (response?.unavailable || response?.launchFailed || response?.timedOut) normalized.error ??= `${seat} transport unavailable`;
        reportEvent(reporter, runId, 'plan', seat === 'claude' ? 'proposal' : 'review', {
          tier, speaker: seat, role: seat === 'claude' ? 'author' : 'reviewer', round: request.state.proposalCycles,
          content: normalized.content, artifactDigest: request.state.artifactDigest,
        });
        return normalized;
      }])),
      renderInput: request => {
        const r = requestFor(request);
        return [dialoguePromptText(strategy.renderInput?.(r) ?? ''), `Requested action: ${request.action}.`,
          proposal ? `CURRENT ARTIFACT\n${strategy.proposalText?.(proposal) ?? JSON.stringify(proposal)}` : '',
          'Conversation-only answers, rebuttals and questions must not emit or apply revised artifacts. Only propose/revise returns complete artifact tags.'].join('\n\n');
      },
      revise: ({ state, response }) => {
        checkContext(session);
        try { proposal = strategy.parseProposal(response); }
        catch (error) {
          if (!(error instanceof RepairableArtifactError)) throw error;
          return { artifactDigest: state.artifactDigest, snapshot: state.snapshot, response,
            artifactRepair: { reason: error.message } };
        }
        return { artifactDigest: planningArtifactDigest(requirements, proposal), snapshot: state.snapshot,
          response: canonicalPlanningArtifact(proposal) };
      },
      persist: ({ state }) => {
        registerEvidenceFiles(session, state.evidence);
        checkContext(session);
        persistContext(session, state.snapshot);
      },
    });
    state = result.state;
    checkContext(session);
    promoteMemory(session, state);
    const approval = result.approved ? { artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest,
      basis: humanAction === 'approve' ? 'human' : interactionMode === 'manual' ? 'consensus' : 'reviewer',
      decidedBy: humanAction === 'approve' ? 'human' : 'codex',
      reason: state.messages.find(m => m.id === state.approval?.messageId)?.content ?? result.reason } : null;
    const pendingDecision = state.pendingDecision ? { ...state.pendingDecision,
      id: `${state.pendingDecision.messageId}:decision`, question: state.pendingDecision.reason } : null;
    const messages = session.journal.read().filter(e => e.type === 'prepare' && ['provider', 'repair'].includes(e.effect)).map(operation => {
      const transport = session.journal.operation(operation.operationId)?.result ?? {};
      const message = state.messages.find(m => m.operationId === operation.operationId);
      const content = transport.agentMessages?.length ? transport.agentMessages.join('\n\n')
        : message?.content ?? transport.content ?? transport.answer ?? transport.lastMessage ?? '';
      return { ...message, speaker: operation.seat, role: operation.seat === 'claude' ? 'author' : 'reviewer',
        content, transport, ...(transport.error ? { error: transport.error } : {}),
        stance: compatibleDialogueStance({ action: message?.action, transport, content }),
        ...(message?.action === 'stop' ? { decision: 'stop' } : {}) };
    });
    messages.push(...state.messages.filter(m => m.sender === 'human'));
    const tail = session.journal.read().at(-1);
    const checkpointState = { version: 2, phase: 'planning', tier, runId, interactionMode, requirements,
      workflow: workflowIdentity({ binding: session.workflowBinding }),
      proposal: canonicalPlanningArtifact(proposal), artifactDigest: state.artifactDigest, approval,
      dialogue: state, directory, roundsLimit: rounds ?? null, pendingDecision,
      messages, artifactRepairs: state.artifactRepairs ?? 0, roundHistory: [], memoryDirectory: session.memory.directory, artifactRoot: session.artifactRoot,
      journalIdentity: { sequence: tail.sequence, hash: tail.hash }, recall: session.recall,
      ...(session.resourceBudget ? { resourceBudget: structuredClone(session.resourceBudget) } : {}),
      ...(continuation?.candidateState ? { candidateState: continuation.candidateState } : {}) };
    // The live journal owner must never be archived or retained as a stale controller lock.
    const resources = session.journal.account();
    session.journal.close();
    const planningArtifacts = planningSidecarManifest({ directory, runId, contextDigest: state.snapshot.digest, registeredPaths: session.ownedFiles.keys() });
    checkpointState.planningArtifacts = planningArtifacts;
    if (approval) approval.sidecarDigest = contextDigest({ manifest: planningArtifacts });
    const written = result.approved ? await strategy.writeConverged(proposal) : {};
    if (approval) reportEvent(reporter, runId, 'plan', 'agreement', {
      tier, artifactDigest: state.artifactDigest, approval, approved: true, converged: approval.basis === 'consensus',
    });
    reportEvent(reporter, runId, 'plan', 'finish', { tier, approved: result.approved, rounds: result.rounds });
    return { ...result, ...written, messages, pendingDecision, runId, directory, artifactDigest: state.artifactDigest,
      approved: result.approved, converged: approval?.basis === 'consensus',
      reason: result.action === 'needs-decision' ? 'needs-decision' : result.action === 'stop' ? 'reviewer-stopped'
        : result.reason.startsWith('provider failed:') ? `${state.pendingOperation?.seat === 'claude' ? 'author' : 'reviewer'}-unavailable` : result.reason, approval,
      checkpointState, sharedContext: state.snapshot, dialogue: state, resources, planningArtifacts,
      tokens: { total: result.resources.knownUsage, usageUnknown: result.resources.usageUnknown },
      roundHistory: [], recall: session.recall };
  } finally { session.journal.close(); }
}
