import { createDialogueState } from './dialogue.js';
import { runIssueDialogue, registerObservations } from './dialogue-dispatch.js';
import { openPlanningContext, contextLifecycle } from './planning-dialogue.js';
import { extendSharedContext } from './shared-context.js';
import { runProtectedOperation, captureReviewSnapshot, restoreReviewSnapshot } from './review-protection.js';
import { detectReview } from './review.js';
import { buildLivenessJudgePrompt, DEFAULT_LIVENESS_JUDGE_TIMEOUT_MS } from './liveness-judge.js';
import { resolve } from 'node:path';

/** Phase adapter; the native dispatcher is the sole dialogue/effect controller. */
export async function runExecutionDialogue({ state, journal, snapshot, artifactDigest, directory, target,
  requirements, plan = requirements, task = plan, runId, artifactRoot, interactionMode = 'manual', context = {}, limits = {},
  execute, review, completeReview, discuss, inspect, capture, selectChecks, runChecks, selectMerge, runMerge,
  judgeLiveness, selectPreservation, preserveExecutorWork, livenessJudgeTimeoutMs = DEFAULT_LIVENESS_JUDGE_TIMEOUT_MS,
  budget, reporter, env, searchIndex, retained, reviewInstructions = '', session: suppliedSession }) {
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
    artifactRoot, interactionMode, context: { ...context, approvedPlan: plan, executionTask: task }, retained, phase: 'execution', tier: 'execution', env, searchIndex });
  journal ??= session.journal;
  snapshot ??= session.snapshot;
  state ??= { ...createDialogueState({ runId, projectId: snapshot.projectId, phase: 'execution', interactionMode,
    snapshot, artifactDigest, limits, scope: { sourceRoots: [target], evidenceRoots: [session.evidenceDirectory] } }), executionTask: task };
  if (!state.messages.length && !state.pendingOperation) state.next = { seat: 'codex', action: 'propose', reason: 'Implement the approved plan' };
  if (retained) {
    retained.validate();
    const prior = retained.context.execution;
    for (const field of ['proposalCycles', 'correctionCycles', 'challengeCycles']) state[field] = prior[field];
    state.priorExecution = structuredClone(prior);
    if (prior.mergeProgress) state.mergeProgress = structuredClone(prior.mergeProgress);
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
  const providerObservations = [];
  const callSeat = seat => async request => {
    retained?.validate();
    contextLifecycle.checkContext(session);
    const writing = seat === 'codex' && ['propose', 'revise'].includes(request.action);
    const call = writing ? execute : seat === 'claude' ? review : discuss;
    if (typeof call !== 'function') throw new Error(`missing ${writing ? 'execution' : seat + ' discussion'} transport`);
    let accepting = true, failure = null, preservation = null, interrupted = false, judgeSequence = 0;
    const judges = new Map(), cancellations = new Set(), settlements = new Set();
    const ensureRecording = () => { contextLifecycle.checkContext(session); journal.read(); if (failure) throw failure; };
    const append = event => {
      try { ensureRecording(); return journal.append({ ...event, providerOperationId: request.operationId }); }
      catch (error) { failure = error; throw error; }
    };
    const prepare = (operationId, effect, purpose, input, extra = {}) => {
      ensureRecording();
      return journal.prepare({ operationId, effect, purpose, seat: effect === 'provider' ? 'codex' : 'harness',
        input, providerOperationId: request.operationId, contextDigest: request.state.snapshot.digest,
        artifactDigest: request.state.artifactDigest, evidenceIds: request.state.evidence.map(item => item.id),
        unreadMessageIds: request.state.messages.filter(item => item.sender !== 'codex').map(item => item.id), ...extra });
    };
    const supervision = writing ? {
      judgeLiveness: evidence => {
        if (!accepting) return Promise.resolve({ available: false, reason: 'writer supervision has closed' });
        const operationId = `${request.operationId}:liveness:${evidence.checkCount ?? ++judgeSequence}`;
        if (judges.has(operationId)) return judges.get(operationId);
        const work = (async () => {
          ensureRecording();
          const observed = { ...evidence, phase: { runId, phase: 'execution', providerOperationId: request.operationId,
            artifactDigest: request.state.artifactDigest, contextDigest: request.state.snapshot.digest,
            approvedPlan: plan, task: request.state.executionTask ?? plan, input: request.input } };
          const input = buildLivenessJudgePrompt(observed);
          const existing = journal.operation(operationId);
          if (existing) {
            if (existing.status !== 'completed') throw new Error('uncertain liveness provider; replay refused');
            return prepare(operationId, 'provider', 'liveness', input).result;
          }
          const allowed = budget ? await budget({ state: structuredClone(request.state), account: journal.account(),
            nextAction: { seat: 'codex', action: 'liveness' } }) : { allowed: true };
          if (!accepting) return { available: false, reason: 'writer supervision has closed' };
          if (allowed?.allowed !== true || typeof judgeLiveness !== 'function') {
            const result = { available: false, reason: allowed?.allowed !== true ? allowed.reason ?? 'liveness budget denied' : 'no liveness judge was available' };
            append({ type: 'liveness-denied', operationId, result });
            return result;
          }
          prepare(operationId, 'provider', 'liveness', input);
          const controller = new AbortController(); cancellations.add(controller);
          let timer, expired = false;
          const timeout = new Promise(resolve => { timer = setTimeout(() => {
            expired = true; controller.abort({ kind: 'liveness-judge-timeout' });
            resolve({ available: false, reason: 'liveness judge settlement uncertain at its existing timeout bound', uncertain: true });
          }, livenessJudgeTimeoutMs); });
          const actual = Promise.resolve().then(() => judgeLiveness(observed, { input, signal: controller.signal }))
            .catch(error => ({ available: false, reason: error.message, error: error.message, usage: null, delivery: null }));
          const settlement = (async () => { try {
            const result = await Promise.race([actual, timeout]);
            if (expired) {
              append({ type: 'liveness-uncertain', operationId, result });
              failure = new Error(result.reason);
            }
            else {
              providerObservations.push({ operationId, seat: 'codex', purpose: 'liveness', usage: result?.usage ?? null,
                delivery: result?.delivery ?? null, launch: result?.launch ?? null });
              ensureRecording();
              journal.complete({ operationId, result: result?.available === false ? { ...result, error: result.reason } : result,
                usage: result?.usage ?? null, delivery: result?.delivery ?? null });
            }
            return result;
          } finally { clearTimeout(timer); cancellations.delete(controller); }
          })().catch(error => { failure = error; throw error; });
          settlements.add(settlement);
          return settlement;
        })().catch(error => { failure = error; throw error; });
        judges.set(operationId, work);
        return work;
      },
      onLivenessDecisionRequired: async decision => {
        append({ type: 'liveness-decision', decision });
      },
      beforeKillRequired: reason => {
        interrupted = true;
        if (preservation) return preservation;
        preservation = (async () => {
          if (reason?.persistenceFailure) throw new Error(reason.persistenceFailure);
          ensureRecording();
          if (typeof selectPreservation !== 'function' || typeof preserveExecutorWork !== 'function') throw new Error('required partial-work preservation unavailable');
          const operationId = `${request.operationId}:preservation`;
          const existing = journal.operation(operationId);
          if (existing) {
            if (existing.status !== 'completed') throw new Error('uncertain preservation; replay refused');
            if (existing.providerOperationId !== request.operationId) throw new Error('preservation writer identity mismatch');
            return existing.result;
          }
          const selection = await selectPreservation({ ...request, reason });
          prepare(operationId, 'preserve-partial-work', 'preservation', JSON.stringify({ reason, selection }), { selection, reason });
          const result = await preserveExecutorWork({ ...request, reason, selection, operationId });
          ensureRecording();
          journal.complete({ operationId, result });
          return result;
        })().catch(error => { failure = error; throw error; });
        return preservation;
      },
    } : {};
    let observedResponse;
    const invoke = async () => {
      let response;
      try { response = await call({ ...request, ...supervision, seat, dialogueMode: true, plan: request.state.executionTask ?? plan, approvedPlan: plan, cwd: target,
        remainingWork: Boolean(retained || request.state.executionCycle?.open && request.state.executionCycle.completedOperationIds?.length) });
        observedResponse = response;
        providerObservations.push({ operationId: request.operationId, seat, usage: response?.usage ?? null,
          delivery: response?.delivery ?? null, launch: response?.launch ?? null });
      }
      finally {
        accepting = false;
        for (const controller of cancellations) controller.abort({ kind: 'writer-closed' });
        await Promise.allSettled(settlements);
        if (preservation) await Promise.allSettled([preservation]);
      }
      if (failure || interrupted || response?.timedOut || response?.aborted) {
        const reason = failure?.message ?? 'interrupted writer outcome is unknown; retained work requires reconciliation';
        try { append({ type: 'executor-interruption', outcome: 'unknown', reason }); } catch { /* The failed required record cannot be invented. */ }
        return { ...response, error: reason, writerOutcome: 'unknown' };
      }
      return response;
    };
    let protectedResult;
    try { protectedResult = await runProtectedOperation({ cwd: target, scope: writing ? 'inside' : 'outside',
      prefix: '__uro_review', stage: 'execution-dialogue', role: seat, runId, reporter,
      ...(writing ? { captureSnapshot: captureReviewSnapshot, restoreSnapshot: restoreReviewSnapshot } : {}),
      ...(writing ? { validateCritical: ({ changedPaths }) => {
        const allowed = resolve(directory) === resolve(target) ? ['__uro_dialogue/journal.jsonl', '__uro_dialogue/journal-tail.jsonl'] : [];
        if (changedPaths.some(path => !allowed.includes(path.replaceAll('\\', '/')))) throw new Error('unowned correctness-critical paths changed during provider access');
        contextLifecycle.checkContext(session);
        journal.read();
        return true;
      } } : {}),
      operation: !writing ? async () => (await runProtectedOperation({
        cwd: target, scope: 'inside', prefix: '__uro_review', stage: 'execution-dialogue', role: seat, runId, reporter,
        captureSnapshot: captureReviewSnapshot, restoreSnapshot: restoreReviewSnapshot, operation: invoke,
      })).result : invoke,
    }); } catch (error) {
      const observation = providerObservations.find(item => item.operationId === request.operationId);
      if (observation) observation.restoration = { status: 'failed-or-unverified', reason: error.message };
      return { ...observedResponse, error: error.message, protectionFailure: true };
    }
    const observation = providerObservations.find(item => item.operationId === request.operationId);
    if (observation) observation.restoration = { status: 'completed', paths: protectedResult.restoredPaths };
    if (writing && interrupted) {
      try { append({ type: 'executor-restoration', status: 'completed', paths: protectedResult.restoredPaths }); }
      catch (error) { protectedResult.result = { ...protectedResult.result, error: error.message }; }
    }
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
          artifactDigest: observed.artifactDigest, ...(request.selection ? { selection: request.selection } : {}),
          ...(observed.mergeProgress ? { mergeProgress: observed.mergeProgress } : {}) }),
        sourceIdentity: observed.artifactDigest, provenance: { origin: 'harness', operationId: request.operationId }, status: 'required' }],
      evidence: observed.evidence ?? [] });
    contextLifecycle.registerEvidenceFiles(session, snapshot.evidence);
    return { artifactDigest: observed.artifactDigest, snapshot,
      ...(observed.mergeProgress ? { mergeProgress: observed.mergeProgress } : {}) };
  };
  try {
    const uncertain = journal.read().find(event => event.type === 'prepare' && ['liveness', 'preservation'].includes(event.purpose)
      && journal.operation(event.operationId).status !== 'completed');
    const result = uncertain ? { state: { ...state, approval: null,
      technicalPause: { reason: `uncertain ${uncertain.purpose}; replay refused`, operationId: uncertain.operationId } },
      approved: false, action: 'paused', reason: `uncertain ${uncertain.purpose}; replay refused`, resources: journal.account(), messages: state.messages }
      : await runIssueDialogue({ state, journal, seats: { codex: callSeat('codex'), claude: callSeat('claude') },
      inspect, budget, reporter, persist,
      selectChecks,
      selectMerge,
      runMerge: typeof runMerge === 'function' ? async request => {
        contextLifecycle.checkContext(session);
        retained?.validate();
        const observed = await runMerge(request);
        contextLifecycle.checkContext(session);
        return observedSnapshot(request, observed, 'merge-sequence');
      } : undefined,
      runChecks: typeof runChecks === 'function' ? async request => {
        contextLifecycle.checkContext(session);
        const observed = await runChecks({ ...request, evidenceDirectory: session.evidenceDirectory });
        return observedSnapshot(request, observed, 'execution-checks');
      } : undefined,
      renderInput: ({ state, seat, action }) => [
        seat === 'claude' ? reviewInstructions : '',
        `Approved implementation plan and current execution task:\n${state.executionTask ?? plan}`, `Requested ${seat} action: ${action}.`,
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
    const checkpointState = { version: 2, phase: 'execution', runId, interactionMode, requirements, plan, task: result.state.executionTask ?? plan,
      directory, artifactRoot: session.artifactRoot, dialogue: result.state,
      artifactDigest: result.state.artifactDigest, pendingDecision: result.state.pendingDecision,
      journalIdentity: tail ? { sequence: tail.sequence, hash: tail.hash } : null, recall: session.recall };
    checkpointState.supervision = { observations: providerObservations };
    if (integrityValid) {
      const events = journal.read();
      checkpointState.supervision = {
        observations: providerObservations,
        operations: events.filter(event => event.type === 'prepare' && ['liveness', 'preservation'].includes(event.purpose)).map(event => journal.operation(event.operationId)),
        decisions: events.filter(event => event.type === 'liveness-decision'),
        denials: events.filter(event => event.type === 'liveness-denied'),
        uncertainty: events.filter(event => ['liveness-uncertain', 'executor-interruption'].includes(event.type)),
        restoration: events.filter(event => event.type === 'executor-restoration'),
      };
    }
    journal.close();
    try {
      if (integrityValid) checkpointState.executionArtifacts = contextLifecycle.manifest({ directory, runId,
        contextDigest: result.state.snapshot.digest, registeredPaths: session.ownedFiles.keys() });
    } catch (error) { pause(error); }
    return { ...result, snapshot: result.state.snapshot, checkpointState, recall: session.recall };
  } finally { journal.close(); }
}
