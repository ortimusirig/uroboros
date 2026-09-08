import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { applyDialogueEnvelope, canApproveDialogue, parseDialogueEnvelope, createDialogueState } from './dialogue.js';
import { renderSharedContext, validateSharedContext, extendSharedContext } from './shared-context.js';
import { captureEvidence, createInspectionReceipt, validateEvidence } from './context-evidence.js';

const mutations = new Set(['propose', 'revise']);
const actions = new Set(['propose', 'ask', 'answer', 'inspect', 'challenge', 'rebut', 'withdraw', 'revise', 'verify', 'approve', 'decide', 'replan', 'stop']);
const SCHEMA = `Return one <UROBOROS_DIALOGUE>JSON</UROBOROS_DIALOGUE> block (or adapter dialogue object).
Schema: {schemaVersion:1,action,artifactDigest,contextDigest,replyTo:null|messageId,content,
claims:[{id,kind:fact|inference|hypothesis|question|preference,text,evidenceIds:[]}],
issues:[{id,title,status:open|awaiting-answer|awaiting-verification|disputed|resolved|withdrawn,blocking,claimIds:[],kind?:technical|product|permission,needsHuman?:boolean,
disposition:{kind:accepted|rejected|corrected|withdrawn|deferred,reason,claimIds:[]}}],evidence:[],
verifications:[{claimId,evidenceIds:[],inspectionReceiptIds:[],result:supports|contradicts|insufficient,reason}],
next:null|{seat:claude|codex,action,reason},requests:[{evidenceId}|{path,line,claimIds:[]}],
memoryProposals:[{id,content,kind,claimIds:[],issueId?,tags:[]}]}
Actions: propose, ask, answer, inspect, challenge, rebut, withdraw, revise, verify, approve, decide, replan, stop.
Echo the saved input artifactDigest and contextDigest, including for propose/revise. Only explicit author
propose/revise applies artifacts. Facts need linked captured evidence. Receipt IDs must come from observed
harness operations; receipt acknowledgment is separate from semantic verification. Approve only a clean,
current artifact with evidenced premises and explicit dispositions for blocking issues. Questions do not
consume a proposal cycle. The reviewer judges progress and may stop or request further dialogue.
The decide action settles issues but never implies artifact sign-off. An approve envelope may contain
all authorized issue dispositions and current-artifact approval together, in this same response.
Use needsHuman:true only on an open blocking product/permission ask requiring a genuinely missing user decision.
A product question answerable from existing user evidence remains coworker clarification. Labels never grant permission.`;

function inside(root, file) {
  const rel = relative(root, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function sourcePath(state, path) {
  if (typeof path !== 'string' || !path) throw new Error('inspection source path required');
  for (const root of state.scope.sourceRoots) {
    const canonical = realpathSync.native(root), candidate = resolve(canonical, path);
    if (!inside(canonical, candidate) || !existsSync(candidate)) continue;
    const file = realpathSync.native(candidate);
    if (inside(canonical, file) && statSync(file).isFile()) return { root: canonical, file };
  }
  throw new Error('inspection source outside trusted scope or missing');
}
function validateObservedEvidence(state, evidence) {
  const captures = state.scope.evidenceRoots.map(root => realpathSync.native(root));
  if (!existsSync(evidence.capturedPath ?? '') || !captures.some(root => inside(root, realpathSync.native(evidence.capturedPath)))) throw new Error('observed evidence capture outside trusted scope');
  if (evidence.kind === 'code') {
    const { file } = sourcePath(state, evidence.locator.path);
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== evidence.sourceDigest) throw new Error('observed evidence source digest stale');
  }
  const result = validateEvidence({ evidence, projectId: state.projectId, roots: [...state.scope.sourceRoots, ...captures] });
  if (!result.valid) throw new Error(result.reason);
}
export function registerObservations(state, operation, observations) {
  const evidence = observations?.evidence ?? [], receipts = observations?.receipts ?? [];
  if (!Array.isArray(evidence) || !Array.isArray(receipts)) throw new Error('invalid observed evidence registry');
  for (const item of evidence) {
    validateObservedEvidence(state, item);
    const old = state.evidence.find(e => e.id === item.id);
    if (old && JSON.stringify(old) !== JSON.stringify(item)) throw new Error('observed evidence identity conflict');
    if (!old) state.evidence.push(structuredClone(item));
  }
  const evidenceIds = [...new Set([...evidence.map(e => e.id), ...receipts.flatMap(r => r.evidenceIds ?? [])])];
  for (const receipt of receipts) {
    if (receipt.operationId !== operation.operationId || receipt.seat !== operation.seat || !receipt.observed
      || !Array.isArray(receipt.evidenceIds) || !receipt.evidenceIds.length) throw new Error('observed receipt operation or seat mismatch');
    const rebuilt = createInspectionReceipt({ operationId: receipt.operationId, seat: receipt.seat, evidence: receipt.evidenceIds, inspected: receipt.inspected, result: receipt.result });
    if (JSON.stringify(rebuilt) !== JSON.stringify(receipt)) throw new Error('observed receipt identity mismatch');
    for (const id of receipt.evidenceIds) {
      const item = state.evidence.find(e => e.id === id);
      if (!item) throw new Error('receipt references unknown observed evidence');
      validateObservedEvidence(state, item);
    }
    const old = state.inspectionReceipts[receipt.id];
    if (old && JSON.stringify(old) !== JSON.stringify(receipt)) throw new Error('receipt registry identity conflict');
    state.inspectionReceipts[receipt.id] = structuredClone(receipt);
  }
  state.operations[operation.operationId] = { status: 'completed', seat: operation.seat, effect: operation.effect,
    evidenceIds, receiptIds: receipts.map(r => r.id) };
}

export function installMaterialEvidence(state) {
  const additions = state.evidence.filter(item => !state.snapshot.evidence.some(old => old.id === item.id));
  if (!additions.length) return;
  const hadApproval = state.approval !== null;
  state.snapshot = extendSharedContext({ snapshot: state.snapshot, evidence: additions });
  state.approval = null;
  if (hadApproval) state.next = { seat: state.reviewer, action: 'verify', reason: 'Assess the extended material context before approval' };
}

async function defaultInspect({ requests, seat, operationId, state }) {
  const evidence = [];
  for (const request of requests) {
    let item = request.evidenceId && state.evidence.find(e => e.id === request.evidenceId);
    if (!item) {
      const { root } = sourcePath(state, request.path);
      const directory = state.scope.evidenceRoots[0];
      if (!directory) throw new Error('inspection capture root required');
      item = captureEvidence({ projectId: state.projectId, root, directory, evidence: {
        id: `evidence-${operationId}-${evidence.length + 1}`, kind: 'code', projectId: state.projectId,
        claimIds: request.claimIds ?? [], locator: { path: request.path, line: request.line, symbol: request.symbol },
        sourceIdentity: state.snapshot.sourceRevision,
      } });
    }
    validateObservedEvidence(state, item);
    readFileSync(item.capturedPath);
    evidence.push(item);
  }
  return { evidence, receipts: [createInspectionReceipt({ operationId, seat, evidence, inspected: true, result: 'read' })] };
}

export async function runIssueDialogue({ state: initial, journal, seats, renderInput, inspect = defaultInspect, revise, captureExecution,
  selectChecks, runChecks, selectMerge, runMerge,
  persist, budget, reporter }) {
  let state = structuredClone(initial);
  const resources = () => { try { return journal.account(); } catch { return state.resources; } };
  const result = (approved, action, reason) => ({ state, approved, action, reason, messages: state.messages,
    rounds: state.proposalCycles, resources: resources() });
  const save = async () => {
    state.resources = journal.account();
    journal.append({ type: 'state', state });
    if (typeof persist !== 'function') throw new Error('required dialogue persistence callback missing');
    await persist({ state: structuredClone(state) });
  };
  const pause = async (reason) => {
    state.approval = null;
    state.technicalPause = { reason, operationId: state.pendingOperation?.operationId ?? null };
    try { await save(); } catch { /* Return visible unapproved state even when the durable store is unavailable. */ }
    if (typeof reporter === 'function') { try { reporter({ type: 'dialogue-paused', reason }); } catch {} }
    return result(false, 'paused', reason);
  };
  const launchAllowed = async (nextAction) => {
    if (mutations.has(nextAction.action)) {
      const repairing = (state.artifactRepair?.cycle === state.proposalCycles && state.artifactRepair?.action === nextAction.action)
        || (state.phase === 'execution' && captureExecution && state.executionCycle?.open
          && state.executionCycle.action === nextAction.action && state.executionCycle.cycle === state.proposalCycles);
      const rounds = state.limits.rounds ?? state.limits.proposalCycles;
      if (!repairing && rounds !== undefined && state.proposalCycles >= rounds) return { allowed: false, reason: 'explicit proposal-cycle limit reached' };
      if (!repairing && nextAction.action === 'revise' && state.limits.corrections !== undefined && state.correctionCycles >= state.limits.corrections) return { allowed: false, reason: 'explicit correction-cycle limit reached' };
    }
    if (nextAction.action === 'challenge' && state.limits.challenges !== undefined && state.challengeCycles >= state.limits.challenges) return { allowed: false, reason: 'explicit challenge limit reached' };
    return budget ? await budget({ state: structuredClone(state), account: journal.account(), nextAction }) : { allowed: true };
  };
  const prepare = async ({ seat, action, effect, input, ...extra }) => {
    const pending = { operationId: `${state.runId}:${state.phase}:${randomUUID()}`, seat, action, effect, ...extra };
    state.pendingOperation = pending;
    await save();
    journal.prepare({ ...pending, input, contextDigest: state.snapshot.digest, artifactDigest: state.artifactDigest,
      evidenceIds: state.evidence.map(e => e.id), unreadMessageIds: state.messages.filter(m => m.sender !== seat).map(m => m.id) });
    return pending;
  };
  const savedOperation = (pending) => {
    const operation = journal.operation(pending.operationId);
    if (!operation || operation.status !== 'completed') throw new Error('unknown or uncertain pending operation; automatic replay refused');
    if (operation.seat !== pending.seat || operation.effect !== pending.effect || operation.action !== pending.action
      || operation.artifactDigest !== state.artifactDigest || operation.contextDigest !== state.snapshot.digest) throw new Error('pending operation identity mismatch');
    return operation;
  };
  const installArtifact = async (operation, output) => {
    if (!output || typeof output.artifactDigest !== 'string' || !output.artifactDigest) throw new Error('artifact application did not return actual identity');
    validateSharedContext({ snapshot: output.snapshot, projectId: state.projectId });
    if (output.snapshot.runId !== state.runId || output.snapshot.phase !== state.phase
      || (output.snapshot.digest !== state.snapshot.digest && output.snapshot.parentDigest !== state.snapshot.digest)) throw new Error('artifact application context identity mismatch');
    if (output.artifactRepair) {
      if (output.artifactDigest !== state.artifactDigest || output.snapshot.digest !== state.snapshot.digest
        || typeof output.artifactRepair.reason !== 'string' || !output.artifactRepair.reason.trim()
        || !Number.isSafeInteger(state.limits.artifactRepairs)) throw new Error('invalid known no-application repair outcome');
      state.artifactRepairs = (state.artifactRepairs ?? 0) + 1;
      state.artifactRepair = { reason: output.artifactRepair.reason, operationId: operation.operationId,
        providerOperationId: state.pendingArtifact.providerOperationId, cycle: state.proposalCycles, action: operation.action };
      state.pendingArtifact = null; state.pendingOperation = null; state.approval = null;
      state.operations[operation.operationId] = { status: 'completed', seat: operation.seat, effect: 'apply', evidenceIds: [], receiptIds: [], applied: false };
      state.next = { seat: state.author, action: operation.action, reason: output.artifactRepair.reason };
      if (state.artifactRepairs > state.limits.artifactRepairs) state.technicalPause = { reason: 'proposal-irreparable' };
      await save();
      return;
    }
    if (output.artifactDigest !== state.artifactDigest || output.snapshot.digest !== state.snapshot.digest) {
      state.historicalEvidenceIds = [...new Set([...state.historicalEvidenceIds, ...state.evidence.filter(e => e.kind === 'code' || e.kind === 'command').map(e => e.id)])];
    }
    for (const item of output.snapshot.evidence) {
      const old = state.evidence.find(e => e.id === item.id);
      if (old && JSON.stringify(old) !== JSON.stringify(item)) throw new Error('applied snapshot evidence identity conflict');
      if (!old) { validateObservedEvidence(state, item); state.evidence.push(structuredClone(item)); }
    }
    state.artifactDigest = output.artifactDigest;
    state.snapshot = structuredClone(output.snapshot);
    state.approval = null;
    state.pendingArtifact = null;
    state.pendingOperation = null;
    state.artifactRepair = null;
    state.operations[operation.operationId] = { status: 'completed', seat: operation.seat, effect: 'apply', evidenceIds: [], receiptIds: [] };
    state.next = operation.effect === 'capture-execution' && state.pendingExecutionCapture?.returnedAction === 'ask'
      ? state.pendingExecutionCapture.next : { seat: state.reviewer, action: 'verify', reason: 'Review applied artifact' };
    if (operation.effect === 'capture-execution') {
      state.executionCycle.completedOperationIds ??= [];
      if (!state.executionCycle.completedOperationIds.includes(state.pendingExecutionCapture.providerOperationId)) {
        state.executionCycle.completedOperationIds.push(state.pendingExecutionCapture.providerOperationId);
      }
      if (state.pendingExecutionCapture.returnedAction !== 'ask') state.executionCycle.open = false;
      state.operations[operation.operationId].effect = 'capture-execution';
      state.operations[operation.operationId].providerOperationId = state.pendingExecutionCapture.providerOperationId;
      state.pendingExecutionCapture = null;
    }
    installMaterialEvidence(state);
    if (operation.effect === 'capture-execution' && state.pendingDecision) {
      state.pendingDecision.questionIdentity ??= { artifactDigest: state.pendingDecision.artifactDigest,
        contextDigest: state.pendingDecision.contextDigest };
      state.pendingDecision.artifactDigest = state.artifactDigest;
      state.pendingDecision.contextDigest = state.snapshot.digest;
    }
    if (operation.effect === 'execution-checks') {
      state.operations[operation.operationId].effect = 'execution-checks';
      state.executionChecks = { operationId: operation.operationId, checkSetIdentity: operation.selection.identity,
        inputArtifactDigest: operation.artifactDigest, artifactDigest: state.artifactDigest,
        contextDigest: state.snapshot.digest };
    }
    if (operation.effect === 'merge-sequence') {
      const progress = output.mergeProgress;
      if (!progress || typeof progress.complete !== 'boolean' || !Number.isSafeInteger(progress.nextParentIndex)
        || typeof progress.task !== 'string') throw new Error('invalid completed merge progress');
      state.mergeProgress = { ...structuredClone(progress), operationId: operation.operationId,
        artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest };
      state.executionTask = progress.task;
      state.operations[operation.operationId].effect = 'merge-sequence';
      state.operations[operation.operationId].selection = structuredClone(operation.selection);
      state.executionChecks = null;
      if (progress.reason) state.technicalPause = { reason: progress.reason, operationId: operation.operationId };
      else if (progress.conflict || !state.executionCycle) {
        // Ordered parent work continues the allocated cycle; it is not reviewer correction.
        if (state.executionCycle) state.executionCycle.open = true;
        state.next = { seat: state.author, action: state.executionCycle?.action ?? 'propose', reason: 'Complete the current ordered merge task' };
      }
    }
    await save();
  };
  try {
    state = createDialogueState({ ...state, continuation: state });
    // The durable state is authoritative on resume; a separately edited sidecar cannot replace it.
    const durable = journal.read().filter(e => e.type === 'state').at(-1)?.state;
    if (durable && JSON.stringify(durable) !== JSON.stringify(state)) {
      state = structuredClone(durable);
      return result(false, 'paused', 'dialogue state differs from verified journal; resume durable state');
    }
    if (state.technicalPause) return result(false, 'paused', state.technicalPause.reason);
    while (true) {
      if (state.technicalPause) return result(false, 'paused', state.technicalPause.reason);
      if (state.pendingExecutionCapture) {
        const retained = state.pendingExecutionCapture;
        const provider = journal.operation(retained.providerOperationId);
        if (state.phase !== 'execution' || typeof captureExecution !== 'function'
          || provider?.status !== 'completed' || provider.seat !== state.author || !mutations.has(provider.action)
          || provider.executionCycle?.id !== state.executionCycle?.id
          || provider.artifactDigest !== state.artifactDigest || provider.contextDigest !== state.snapshot.digest) {
          throw new Error('retained execution capture lacks authorized completed input');
        }
        let capture = state.pendingOperation;
        if (capture) {
          if (capture.effect !== 'capture-execution') throw new Error('unexpected pending execution capture operation');
          const completed = savedOperation(capture);
          await installArtifact(completed, completed.result);
        } else {
          capture = await prepare({ seat: state.author, action: provider.action, effect: 'capture-execution',
            input: JSON.stringify({ providerOperationId: provider.operationId, returnedAction: retained.returnedAction }),
            providerOperationId: provider.operationId });
          const output = await captureExecution({ state: structuredClone(state), seat: state.author,
            operationId: capture.operationId, providerOperationId: provider.operationId,
            response: structuredClone(provider.result), envelope: parseDialogueEnvelope({ response: provider.result }) });
          journal.complete({ operationId: capture.operationId, result: output, usage: null, delivery: null });
          await installArtifact(capture, output);
        }
        continue;
      }
      if (state.pendingDecision) { await save(); return result(false, 'needs-decision', state.pendingDecision.reason); }
      if (state.terminalAction) { await save(); return result(false, state.terminalAction, state.stopReason); }
      if (state.phase === 'execution' && (!state.pendingOperation || state.pendingOperation.effect === 'merge-sequence')) {
        const selection = state.pendingOperation?.selection
          ?? (typeof selectMerge === 'function' ? await selectMerge({ state: structuredClone(state) }) : null);
        if (selection) {
          if (!selection.identity || typeof runMerge !== 'function') throw new Error('invalid harness merge selection');
          const pending = state.pendingOperation ?? await prepare({ seat: 'harness', action: 'merge', effect: 'merge-sequence',
            input: JSON.stringify(selection), selection: structuredClone(selection) });
          let operation = journal.operation(pending.operationId);
          if (operation?.status !== 'completed') {
            if (!operation || operation.status === 'uncertain' || initial.pendingOperation?.operationId === pending.operationId) throw new Error('unknown or uncertain merge sequence; automatic replay refused');
            const output = await runMerge({ state: structuredClone(state), operationId: pending.operationId, selection: structuredClone(selection) });
            journal.complete({ operationId: pending.operationId, result: output, usage: null, delivery: null });
          }
          operation = savedOperation(pending);
          await installArtifact(operation, operation.result);
          continue;
        }
      }
      // Harness commands are a distinct effect, never part of replayable file capture
      // or provider delivery. A yielded cycle has not reached its check boundary.
      if (state.phase === 'execution' && !state.executionCycle?.open && state.executionCycle
        && (!state.pendingOperation || state.pendingOperation.effect === 'execution-checks')) {
        const selection = state.pendingOperation?.selection
          ?? (typeof selectChecks === 'function' ? await selectChecks({ state: structuredClone(state) }) : null);
        if (selection) {
          if (typeof selection.identity !== 'string' || !selection.identity || typeof runChecks !== 'function') throw new Error('invalid harness execution check selection');
          const current = state.executionChecks;
          if (state.pendingOperation || current?.artifactDigest !== state.artifactDigest || current?.checkSetIdentity !== selection.identity) {
            const pending = state.pendingOperation ?? await prepare({ seat: 'harness', action: 'verify', effect: 'execution-checks',
              input: JSON.stringify(selection), selection: structuredClone(selection) });
            let operation = journal.operation(pending.operationId);
            if (operation.status !== 'completed') {
              if (operation.status === 'uncertain' || initial.pendingOperation?.operationId === pending.operationId) throw new Error('unknown or uncertain execution checks; automatic replay refused');
              const output = await runChecks({ state: structuredClone(state), operationId: pending.operationId,
                selection: structuredClone(selection) });
              journal.complete({ operationId: pending.operationId, result: output, usage: null, delivery: null });
              operation = savedOperation(pending);
            } else operation = savedOperation(pending);
            await installArtifact(operation, operation.result);
            continue;
          }
        }
      }
      if (!state.pendingOperation && (!state.mergeProgress || state.mergeProgress.complete) && !mutations.has(state.next?.action)
        && canApproveDialogue({ state, seat: state.reviewer }).approved) { await save(); return result(true, 'complete', 'Current artifact approved'); }
      let pending = state.pendingOperation, operation;
      if (pending?.effect === 'apply') {
        operation = savedOperation(pending);
        await installArtifact(operation, operation.result);
        continue;
      }
      if (pending?.effect === 'inspect') {
        operation = savedOperation(pending);
        registerObservations(state, operation, operation.result);
        installMaterialEvidence(state);
        state.pendingOperation = null;
        state.pendingInspection = null;
        state.next = { seat: operation.seat, action: 'verify', reason: 'Assess inspected evidence' };
        await save();
        continue;
      }
      if (!pending && state.pendingArtifact) {
        const provider = journal.operation(state.pendingArtifact.providerOperationId);
        if (!provider || provider.status !== 'completed' || !['provider', 'repair'].includes(provider.effect)
          || provider.seat !== state.author || provider.artifactDigest !== state.artifactDigest
          || provider.contextDigest !== state.snapshot.digest) throw new Error('pending artifact missing completed provider input identity');
        const envelope = parseDialogueEnvelope({ response: provider.result });
        if (!mutations.has(envelope.action) || envelope.action !== state.pendingArtifact.action) throw new Error('pending artifact action identity mismatch');
        if (typeof revise !== 'function') throw new Error('artifact application callback required');
        const application = await prepare({ seat: provider.seat, action: envelope.action, effect: 'apply',
          input: JSON.stringify({ providerOperationId: provider.operationId, response: provider.result, envelope }), providerOperationId: provider.operationId });
        const output = await revise({ state: structuredClone(state), seat: provider.seat, operationId: application.operationId,
          response: structuredClone(provider.result), envelope: structuredClone(envelope) });
        journal.complete({ operationId: application.operationId, result: output, usage: null, delivery: null });
        await installArtifact(application, output);
        continue;
      }
      if (!pending && state.pendingInspection) {
        const { requests, seat } = state.pendingInspection;
        if (!Array.isArray(requests) || !requests.length) throw new Error('explicit inspection requests required');
        for (const request of requests) {
          if (request.evidenceId) {
            const item = state.evidence.find(e => e.id === request.evidenceId);
            if (!item) throw new Error('inspection request references unknown evidence');
            validateObservedEvidence(state, item);
          } else sourcePath(state, request.path);
        }
        const inspection = await prepare({ seat, action: 'inspect', effect: 'inspect', input: JSON.stringify(requests) });
        const observed = await inspect({ requests: structuredClone(requests), seat, operationId: inspection.operationId, state: structuredClone(state) });
        journal.complete({ operationId: inspection.operationId, result: observed, usage: null, delivery: null });
        registerObservations(state, inspection, observed);
        installMaterialEvidence(state);
        state.pendingOperation = null;
        state.pendingInspection = null;
        state.next = { seat, action: 'verify', reason: 'Assess inspected evidence' };
        await save();
        continue;
      }
      if (pending) operation = savedOperation(pending);
      else {
        const next = state.next;
        if (!next || !['claude', 'codex'].includes(next.seat) || !actions.has(next.action)) throw new Error('invalid next dialogue action');
        if (mutations.has(next.action) && next.seat !== state.author) throw new Error('only designated author can apply artifacts');
        const allowed = await launchAllowed(next);
        if (allowed?.allowed !== true) return await pause(allowed?.reason ?? 'dialogue budget exhausted');
        if (typeof seats?.[next.seat] !== 'function') return await pause(`missing transport for seat ${next.seat}`);
        const execution = state.phase === 'execution' && typeof captureExecution === 'function'
          && next.seat === state.author && mutations.has(next.action);
        if (execution && !state.executionCycle?.open) {
          state.proposalCycles++;
          if (next.action === 'revise') state.correctionCycles++;
          state.executionCycle = { id: `${state.runId}:execution-cycle:${randomUUID()}`, cycle: state.proposalCycles,
            action: next.action, open: true, completedOperationIds: [] };
        }
        if (execution && state.executionCycle.action !== next.action) throw new Error('remaining execution must continue its allocated action');
        const capturedEvidence = state.evidence.map(item => {
          const historical = state.historicalEvidenceIds.includes(item.id);
          if (!historical) validateObservedEvidence(state, item);
          else {
            // Journal-verified metadata and exact capture bytes remain readable as history.
            // The reducer still requires current source validation before using these as premises.
            const roots = state.scope.evidenceRoots.map(root => realpathSync.native(root));
            if (!roots.some(root => inside(root, realpathSync.native(item.capturedPath)))) throw new Error('historical evidence capture outside trusted scope');
            if (createHash('sha256').update(readFileSync(item.capturedPath)).digest('hex') !== item.sourceDigest) throw new Error('historical evidence capture digest mismatch');
          }
          return { id: item.id, sourceDigest: item.sourceDigest, historical, content: readFileSync(item.capturedPath, 'utf8') };
        });
        const input = [renderInput ? await renderInput({ state: structuredClone(state), seat: next.seat, action: next.action }) : '',
          renderSharedContext({ snapshot: state.snapshot }), SCHEMA,
          JSON.stringify({ artifactDigest: state.artifactDigest, phase: state.phase, interactionMode: state.interactionMode,
            author: state.author, reviewer: state.reviewer, disputeAuthority: state.authority, limits: state.limits,
            proposalCycles: state.proposalCycles, correctionCycles: state.correctionCycles, challengeCycles: state.challengeCycles,
            next, issues: state.issues, messages: state.messages,
            claims: state.claims, evidence: state.evidence, capturedEvidence, inspectionReceipts: state.inspectionReceipts, memoryProposals: state.memoryProposals }, null, 2),
          state.formatRepair ? `FORMAT REPAIR ONLY. Preserve the prior substance and return the required envelope. Previous response:\n${JSON.stringify(state.formatRepair.response)}` : '',
          state.artifactRepair ? `ARTIFACT FORMAT REPAIR in the same proposal cycle: ${state.artifactRepair.reason}\nPrevious saved response:\n${JSON.stringify(journal.operation(state.artifactRepair.providerOperationId)?.result)}` : '',
        ].join('\n\n');
        pending = await prepare({ seat: next.seat, action: next.action, effect: state.formatRepair ? 'repair' : 'provider', input,
          ...(execution ? { executionCycle: structuredClone(state.executionCycle) } : {}) });
        let response;
        try { response = await seats[pending.seat]({ input, action: state.formatRepair ? 'repair' : next.action,
          state: structuredClone(state), operationId: pending.operationId }); }
        catch (error) { response = { error: error.message, content: '', usage: null, delivery: null }; }
        journal.complete({ operationId: pending.operationId, result: response, usage: response?.usage ?? null, delivery: response?.delivery ?? null });
        operation = savedOperation(pending);
      }
      if (operation.result?.error) return await pause(`provider failed: ${operation.result.error}`);
      registerObservations(state, operation, operation.result?.observations);
      let envelope;
      try { envelope = parseDialogueEnvelope({ response: operation.result }); }
      catch (error) {
        if (state.phase === 'execution' && operation.executionCycle && operation.seat === state.author
          && mutations.has(operation.action)) return await pause(`unreadable execution outcome; retained writes require reconciliation: ${error.message}`);
        if (operation.effect === 'repair' || state.formatRepair) return await pause(`unreadable dialogue after one format repair: ${error.message}`);
        state.formatRepair = { operationId: operation.operationId, response: operation.result };
        state.pendingOperation = null;
        await save();
        continue;
      }
      if (mutations.has(envelope.action) && envelope.action !== operation.action) throw new Error('unsolicited artifact application outside explicit proposal/revision operation');
      if (state.phase === 'execution' && state.executionCycle?.open && envelope.action === 'approve') throw new Error('unfinished execution cycle cannot be approved');
      if (state.mergeProgress && !state.mergeProgress.complete && envelope.action === 'approve') throw new Error('pending merge cannot be approved');
      // Reducer checks the saved INPUT identities, before the local artifact callback can change them.
      let reductionState = state;
      const execution = state.phase === 'execution' && captureExecution && operation.seat === state.author
        && mutations.has(operation.action) && operation.executionCycle?.id === state.executionCycle?.id;
      if (execution && !['ask', operation.action].includes(envelope.action)) throw new Error('execution outcome must complete its requested action or ask at safe yield');
      if (execution && mutations.has(envelope.action)) {
        reductionState = structuredClone(state);
        reductionState.proposalCycles--;
        if (envelope.action === 'revise') reductionState.correctionCycles--;
      }
      if (state.artifactRepair && mutations.has(envelope.action)) {
        if (state.artifactRepair.action !== envelope.action || state.artifactRepair.cycle !== state.proposalCycles
          || operation.seat !== state.author) throw new Error('artifact repair cycle binding mismatch');
        reductionState = structuredClone(state);
        reductionState.proposalCycles--;
        if (envelope.action === 'revise') reductionState.correctionCycles--;
      }
      state = applyDialogueEnvelope({ state: reductionState, envelope, seat: operation.seat });
      if (state.mergeHumanReview?.status === 'pending' && operation.seat === state.reviewer
        && ['verify', 'decide', 'stop', 'replan'].includes(envelope.action)
        && state.mergeHumanReview.contextDigest === envelope.contextDigest) {
        state.mergeHumanReview = { ...state.mergeHumanReview, status: 'reviewed', reviewerOperationId: operation.operationId };
      }
      if (execution) {
        state.pendingArtifact = null;
        state.pendingExecutionCapture = { providerOperationId: operation.operationId, returnedAction: envelope.action,
          next: structuredClone(state.next), executionCycleId: state.executionCycle.id };
      } else if (!state.pendingArtifact) installMaterialEvidence(state);
      state.formatRepair = null;
      state.pendingOperation = null;
      await save();
    }
  } catch (error) { return await pause(error.message); }
}
