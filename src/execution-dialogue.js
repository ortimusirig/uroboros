import { createDialogueState } from './dialogue.js';
import { runIssueDialogue, registerObservations } from './dialogue-dispatch.js';
import { openPlanningContext, contextLifecycle } from './planning-dialogue.js';
import { extendSharedContext } from './shared-context.js';
import { runProtectedOperation, captureReviewSnapshot, restoreReviewSnapshot } from './review-protection.js';
import { detectReview } from './review.js';

/** Phase adapter; the native dispatcher is the sole dialogue/effect controller. */
export async function runExecutionDialogue({ state, journal, snapshot, artifactDigest, directory, target,
  requirements, plan = requirements, runId, artifactRoot, interactionMode = 'manual', context = {}, limits = {},
  execute, review, completeReview, discuss, inspect, capture, selectChecks, runChecks, budget, reporter, env, searchIndex, retained, reviewInstructions = '', session: suppliedSession }) {
  // A retained handoff initializes a distinct phase; it is never a supplied-session reopening.
  if (retained && (state || journal || snapshot || suppliedSession)) throw new Error('retained successor must start a new execution phase');
  if (retained) {
    retained.validate();
    if (retained.context.child.runId !== runId || retained.context.child.phase !== 'execution'
      || retained.context.child.directory !== directory
      || !['proposalCycles', 'correctionCycles', 'challengeCycles'].every(key => Number.isSafeInteger(retained.context.execution[key]) && retained.context.execution[key] >= 0)) {
      throw new Error('retained execution phase or cycle identity mismatch');
    }
  }
  const session = suppliedSession ?? openPlanningContext({ requirements, target, directory, runId,
    artifactRoot, interactionMode, context: { ...context, approvedPlan: plan }, retained, phase: 'execution', tier: 'execution', env, searchIndex });
  journal ??= session.journal;
  snapshot ??= session.snapshot;
  state ??= createDialogueState({ runId, projectId: snapshot.projectId, phase: 'execution', interactionMode,
    snapshot, artifactDigest, limits, scope: { sourceRoots: [target], evidenceRoots: [session.evidenceDirectory] } });
  if (!state.messages.length && !state.pendingOperation) state.next = { seat: 'codex', action: 'propose', reason: 'Implement the approved plan' };
  if (retained) {
    retained.validate();
    const prior = retained.context.execution;
    for (const field of ['proposalCycles', 'correctionCycles', 'challengeCycles']) state[field] = prior[field];
    state.priorExecution = structuredClone(prior);
    if (prior.executionCycle?.open) {
      state.executionCycle = structuredClone(prior.executionCycle);
      state.next.action = state.executionCycle.action;
    }
    state.phaseParent = structuredClone(retained.context.parent);
  }
  const persist = ({ state }) => {
    contextLifecycle.registerEvidenceFiles(session, state.evidence);
    contextLifecycle.checkContext(session);
    contextLifecycle.persistContext(session, state.snapshot);
  };
  const callSeat = seat => async request => {
    retained?.validate();
    contextLifecycle.checkContext(session);
    const writing = seat === 'codex' && ['propose', 'revise'].includes(request.action);
    const call = writing ? execute : seat === 'claude' ? review : discuss;
    if (typeof call !== 'function') throw new Error(`missing ${writing ? 'execution' : seat + ' discussion'} transport`);
    const invoke = () => call({ ...request, seat, dialogueMode: true, plan, cwd: target,
      remainingWork: Boolean(retained || request.state.executionCycle?.open && request.state.executionCycle.completedOperationIds?.length) });
    const protectedResult = await runProtectedOperation({ cwd: target, scope: writing ? 'inside' : 'outside',
      prefix: '__uro_review', stage: 'execution-dialogue', role: seat, runId, reporter,
      ...(writing ? { captureSnapshot: captureReviewSnapshot, restoreSnapshot: restoreReviewSnapshot } : {}),
      operation: !writing ? async () => (await runProtectedOperation({
        cwd: target, scope: 'inside', prefix: '__uro_review', stage: 'execution-dialogue', role: seat, runId, reporter,
        captureSnapshot: captureReviewSnapshot, restoreSnapshot: restoreReviewSnapshot, operation: invoke,
      })).result : invoke,
    });
    let response = protectedResult.result;
    contextLifecycle.checkContext(session);
    retained?.validate();
    if (seat === 'claude' && typeof completeReview === 'function') {
      try { response = await completeReview({ ...request, response, cwd: target }); }
      catch (error) { response = { ...response, error: error.message }; }
    }
    const normalized = typeof response === 'string' ? { content: response } : { ...response,
      content: response?.content ?? response?.answer ?? response?.lastMessage ?? '' };
    if (seat === 'claude' && response?.artifact && !detectReview({ dir: target, artifact: response.artifact,
      round: request.state.proposalCycles, diffDigest: response.artifact.diffDigest }).reviewed) {
      normalized.error = 'retained review artifact is missing or changed after read-only restoration';
    }
    if (response?.unavailable || response?.launchFailed || response?.timedOut || response?.aborted || response?.artifactFailed
      || response?.resultSeen === false || response?.resultUsable === false
      || (Number.isInteger(response?.exitCode) && response.exitCode !== 0)) normalized.error ??= `${seat} transport unavailable`;
    const observed = structuredClone(request.state);
    registerObservations(observed, { operationId: request.operationId, seat, effect: 'provider' }, normalized.observations);
    contextLifecycle.registerEvidenceFiles(session, observed.evidence);
    contextLifecycle.checkContext(session);
    return normalized;
  };
  const observedSnapshot = (request, observed, kind) => {
    if (!observed?.artifactDigest || typeof observed.diff !== 'string') throw new Error('actual retained artifact and diff required');
    const snapshot = extendSharedContext({ snapshot: request.state.snapshot,
      entries: [{ id: `${kind}-${request.operationId}`, kind,
        content: JSON.stringify({ diff: observed.diff, providerOperationId: request.providerOperationId,
          artifactDigest: observed.artifactDigest, ...(request.selection ? { selection: request.selection } : {}) }),
        sourceIdentity: observed.artifactDigest, provenance: { origin: 'harness', operationId: request.operationId }, status: 'required' }],
      evidence: observed.evidence ?? [] });
    contextLifecycle.registerEvidenceFiles(session, snapshot.evidence);
    return { artifactDigest: observed.artifactDigest, snapshot };
  };
  try {
    const result = await runIssueDialogue({ state, journal, seats: { codex: callSeat('codex'), claude: callSeat('claude') },
      inspect, budget, reporter, persist,
      selectChecks,
      runChecks: typeof runChecks === 'function' ? async request => {
        contextLifecycle.checkContext(session);
        const observed = await runChecks({ ...request, evidenceDirectory: session.evidenceDirectory });
        return observedSnapshot(request, observed, 'execution-checks');
      } : undefined,
      renderInput: ({ state, seat, action }) => [
        seat === 'claude' ? reviewInstructions : '',
        `Approved implementation plan:\n${plan}`, `Requested ${seat} action: ${action}.`,
        'Only an explicitly requested Codex propose/revise operation may change project files. Answers, explanations, challenges, inspections and rebuttals are read-only.',
        'A completed execution process may ask a cited question after partial writes. Return the saved input artifact/context identities. The harness captures the resulting work before the answer.',
        state.executionCycle?.open ? `Continue only remaining work in execution cycle ${state.executionCycle.id}; preserve completed files and operations.` : '',
        'Claude may approve the current artifact with evidenced issue dispositions in this response. decide settles issues without signing off the artifact. No extra clean final review is required.',
        'To request retained replanning, Claude returns action:"replan" with replan:{issueId:"existing issue ID",evidenceIds:["registered evidence ID"],novelty:"concrete new-evidence explanation"}. A claimId may replace issueId. Explain what the new evidence changes in the remaining-work decision.',
        retained ? 'This is authorized remaining execution after retained planning. Preserve completed work and historical operation identities; do not repeat completed steps.' : '',
      ].join('\n\n'),
      captureExecution: async request => {
        contextLifecycle.checkContext(session);
        if (typeof capture !== 'function') throw new Error('actual execution capture required');
        const observed = await capture(request);
        return observedSnapshot(request, observed, 'retained-execution');
      },
    });
    const pause = error => {
      result.approved = false; result.action = 'paused'; result.reason = error.message;
      result.state.approval = null; result.state.technicalPause = { reason: error.message };
    };
    let integrityValid = true;
    try {
      contextLifecycle.checkContext(session);
      if (result.action !== 'paused') contextLifecycle.promoteMemory(session, result.state);
    } catch (error) { integrityValid = false; pause(error); }
    let tail;
    try { tail = journal.read().at(-1); } catch (error) { integrityValid = false; pause(error); }
    const checkpointState = { version: 2, phase: 'execution', runId, interactionMode, requirements, plan,
      directory, artifactRoot: session.artifactRoot, dialogue: result.state,
      artifactDigest: result.state.artifactDigest, pendingDecision: result.state.pendingDecision,
      journalIdentity: tail ? { sequence: tail.sequence, hash: tail.hash } : null, recall: session.recall };
    journal.close();
    try {
      if (integrityValid) checkpointState.executionArtifacts = contextLifecycle.manifest({ directory, runId,
        contextDigest: result.state.snapshot.digest, registeredPaths: session.ownedFiles.keys() });
    } catch (error) { pause(error); }
    return { ...result, snapshot: result.state.snapshot, checkpointState, recall: session.recall };
  } finally { journal.close(); }
}
