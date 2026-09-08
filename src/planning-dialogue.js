import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createSharedContext, extendSharedContext, persistSharedContext, validateSharedContext, contextDigest, renderSharedContext } from './shared-context.js';
import { captureEvidence } from './context-evidence.js';
import { resolveProjectIdentity, openProjectMemory } from './project-memory.js';
import { resolveArtifactRoot } from './artifacts.js';
import { readEnv } from './env-compat.js';
import { openDialogueJournal } from './dialogue-journal.js';
import { createDialogueState, parseDialogueEnvelope, applyDialogueEnvelope } from './dialogue.js';
import { runIssueDialogue, registerObservations, installMaterialEvidence } from './dialogue-dispatch.js';
import { canonicalPlanningArtifact, planningArtifactDigest, RepairableArtifactError, MAX_ARTIFACT_REPAIRS, dialoguePromptText } from './conversation.js';
import { reportEvent } from './events.js';

const digestBytes = path => createHash('sha256').update(readFileSync(path)).digest('hex');

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

/** Create required common grounding before any author, selector or reviewer launch. */
export function openPlanningContext({ requirements, target, directory, runId, tier = 'plan', context = {},
  artifactRoot, env = process.env, searchIndex }) {
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
  const entries = Object.entries({ requirements, target: project, ...context })
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
  const snapshot = createSharedContext({ projectId: project.projectId, runId, unitId: `${runId}:${tier}`,
    phase: 'planning', sourceRevision, entries, evidence: [evidence], recalled: recalled.map(record => ({
      ...record, id: record.versionId, notebookEntryId: record.id, status: 'historical', notebookStatus: record.status,
    })) });
  const path = persistSharedContext({ directory, snapshot });
  const journal = openDialogueJournal({ directory, runId, projectId: project.projectId });
  return { snapshot, journal, memory, project, directory, artifactRoot: root, evidenceDirectory, contextPaths: new Map([[path, digestBytes(path)]]),
    ownedFiles: new Map([[path, digestBytes(path)], [evidence.capturedPath, digestBytes(evidence.capturedPath)],
      ...['journal.jsonl', 'journal-tail.jsonl'].map(name => [join(directory, '__uro_dialogue', name), null])]),
    preparationMessages: [],
    recall: { status: recalled.searchStatus, error: recalled.searchError } };
}

function reopenPlanningContext({ continuation, target, directory }) {
  const snapshot = continuation.dialogue.snapshot;
  const project = resolveProjectIdentity({ target });
  if (project.projectId !== snapshot.projectId) throw new Error('saved planning project identity changed');
  const path = join(directory, '__uro_context', `${snapshot.id}.json`);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  validateSharedContext({ snapshot: stored, projectId: project.projectId });
  if (stored.digest !== snapshot.digest) throw new Error('saved shared context identity changed');
  const manifest = continuation.planningArtifacts;
  if (!manifest || manifest.runId !== snapshot.runId || manifest.contextDigest !== snapshot.digest
    || resolve(manifest.directory) !== resolve(directory)) throw new Error('saved planning sidecar provenance missing or stale');
  const registeredPaths = manifest.files.map(file => join(directory, file.path));
  if (contextDigest({ manifest }) !== contextDigest({ manifest: planningSidecarManifest({ directory, runId: snapshot.runId,
    contextDigest: snapshot.digest, registeredPaths }) })) throw new Error('saved planning sidecar manifest changed');
  const journal = openDialogueJournal({ directory, runId: snapshot.runId, projectId: project.projectId });
  try {
    const events = journal.read();
    if (events.at(-1)?.hash !== continuation.journalIdentity.hash || events.at(-1)?.sequence !== continuation.journalIdentity.sequence) throw new Error('saved planning journal identity changed');
    const latest = events.filter(e => e.type === 'state').at(-1)?.state;
    if (contextDigest({ state: latest }) !== contextDigest({ state: continuation.dialogue })) throw new Error('saved planning dialogue differs from journal');
    return { snapshot, journal, project, directory, dialogue: latest, artifactRoot: continuation.artifactRoot,
      memory: openProjectMemory({ artifactRoot: continuation.artifactRoot, project }),
      evidenceDirectory: join(directory, '__uro_evidence'),
      ownedFiles: new Map(manifest.files.map(file => [join(directory, file.path), file.path.startsWith('__uro_dialogue/') ? null : file.sha256])),
      contextPaths: new Map(manifest.files.filter(file => file.path.startsWith('__uro_context/')).map(file => [join(directory, file.path), file.sha256])), recall: continuation.recall };
  } catch (error) { journal.close(); throw error; }
}

function checkContext(session) {
  session.journal.read();
  assertSidecarInventory({ directory: session.directory,
    registeredPaths: [...session.ownedFiles.keys(), join(session.directory, '__uro_dialogue', 'controller.lock')] });
  for (const [path, digest] of session.contextPaths) {
    if (!existsSync(path) || digestBytes(path) !== digest) throw new Error('persisted shared context changed during provider access');
    validateSharedContext({ snapshot: JSON.parse(readFileSync(path, 'utf8')), projectId: session.project.projectId });
  }
  for (const [path, digest] of session.ownedFiles) if (digest !== null && digestBytes(path) !== digest) throw new Error('registered planning sidecar bytes changed');
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

/** Alternatives are independent proposals, with serialized, accounted preparation calls. */
export async function callPlanningPreparation({ session, requirements, input, call, seat, action, request = {}, previousPreparationOperationId }) {
  checkContext(session);
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
    state.proposalCycles--; // Known artifact-format repair reuses the allocated proposal cycle.
  }
  state.messages = structuredClone(session.preparationMessages);
  let failedResponse, repairOf;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A completed malformed response may have published authenticated material.
    // The new operation uses that current context; the old input remains history.
    state.snapshot = structuredClone(session.snapshot);
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
    try { response = await call({ ...request, input: submitted, dialogueMode: true, state: structuredClone(state), operationId, action: attempt ? 'repair' : action }); }
    catch (error) { response = { error: error.message, unavailable: true }; }
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

/** New runs use explicit dialogue; historical runConversation remains a separate reader. */
export async function runPlanningDialogue({ requirements, target, directory, tier = 'plan', interactionMode = 'manual',
  rounds, runId = `planning-${randomUUID()}`, seats, strategy, reporter, context, artifactRoot, env, searchIndex,
  session: suppliedSession, continuation, humanRuling, prelude, budget }) {
  const session = suppliedSession ?? (continuation ? reopenPlanningContext({ continuation, target, directory })
    : openPlanningContext({ requirements, target, directory, runId, tier, context, artifactRoot, env, searchIndex }));
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
    let humanAction = null;
    if (humanRuling) {
      if (state.interactionMode !== 'manual' || !state.pendingDecision || !humanRuling.decisionId) throw new Error('human ruling has no current manual decision');
      if (planningArtifactDigest(requirements, proposal) !== state.artifactDigest) throw new Error('saved planning artifact identity changed');
      const content = humanRuling.answers.map(answer => answer.answer).join('\n');
      humanAction = /^approve(?:\s*:|\s*$)/i.test(content) ? 'approve' : /^stop(?:\s*:|\s*$)/i.test(content) ? 'stop' : null;
      state = structuredClone(state);
      state.messages.push({ id: `${runId}:human:${humanRuling.decisionId}`, sender: 'human', speaker: 'human',
        phase: 'planning', action: 'decide', content, artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest,
        decisionId: humanRuling.decisionId, sequence: state.messages.length + 1 });
      state.humanRuling = { ...humanRuling, action: humanAction, artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest };
      state.pendingDecision = null;
      state.next = { seat: 'codex', action: 'verify', reason: 'Assess the human clarification' };
      session.journal.append({ type: 'human-ruling', ruling: state.humanRuling });
      session.journal.append({ type: 'state', state });
    }
    const result = humanAction ? { state, approved: humanAction === 'approve', action: humanAction === 'approve' ? 'complete' : 'stop',
      reason: state.messages.at(-1).content, messages: state.messages, rounds: state.proposalCycles, resources: session.journal.account() }
      : await runIssueDialogue({ state, journal: session.journal, budget,
      seats: Object.fromEntries([['claude', seats.author], ['codex', seats.reviewCodex]].map(([seat, call]) => [seat, async request => {
        checkContext(session);
        const response = await call(requestFor({ ...request, seat }));
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
        stance: transport.error ? 'unavailable' : /AGREE:\s*no/i.test(content) ? 'disagree' : 'agree',
        ...(message?.action === 'stop' ? { decision: 'stop' } : {}) };
    });
    messages.push(...state.messages.filter(m => m.sender === 'human'));
    const tail = session.journal.read().at(-1);
    const checkpointState = { version: 2, phase: 'planning', tier, runId, interactionMode, requirements,
      proposal: canonicalPlanningArtifact(proposal), artifactDigest: state.artifactDigest, approval,
      dialogue: state, directory, roundsLimit: rounds ?? null, pendingDecision,
      messages, artifactRepairs: state.artifactRepairs ?? 0, roundHistory: [], memoryDirectory: session.memory.directory, artifactRoot: session.artifactRoot,
      journalIdentity: { sequence: tail.sequence, hash: tail.hash }, recall: session.recall,
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
