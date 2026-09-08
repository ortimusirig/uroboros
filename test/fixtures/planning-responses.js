// New-protocol fake-provider constructors. They observe captured fixture bytes;
// no production response is inferred or downgraded through this test utility.
import { readFileSync } from 'node:fs';
import { createInspectionReceipt } from '../../src/context-evidence.js';

export function planningRequest(request) {
  const r = request.request ?? request;
  return { ...r, state: r.state ?? request.dialogueState, operationId: r.operationId ?? request.operationId,
    input: r.input ?? request.plan ?? request.prompt };
}
export function planningEnvelope(request, action, extra = {}) {
  const r = planningRequest(request);
  return { schemaVersion: 1, action, artifactDigest: r.state.artifactDigest, contextDigest: r.state.snapshot.digest,
    replyTo: null, content: 'Fixture response.', claims: [], issues: [], evidence: [], verifications: [], next: null, ...extra };
}
export function planningApproval(request, content = 'The captured briefing supports this proposal.') {
  const r = planningRequest(request), evidence = r.state.evidence.find(e => e.kind === 'requirement');
  readFileSync(evidence.capturedPath);
  const receipt = createInspectionReceipt({ operationId: r.operationId, seat: 'codex', evidence: [evidence], inspected: true, result: 'read' });
  return { dialogue: planningEnvelope(r, 'approve', { content,
    claims: [{ id: 'briefing-requirement', kind: 'fact', text: evidence.text, evidenceIds: [evidence.id] }],
    verifications: [{ claimId: 'briefing-requirement', evidenceIds: [evidence.id], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'The captured briefing contains this exact text.' }],
  }), observations: { evidence: [], receipts: [receipt] } };
}

// Explicit migration of old *test scripts*, at the fake provider boundary only.
// Individual protocol-rejection tests use runPlan directly without this helper.
export function scriptedPlanningResponse(request, value, seat) {
  if (value?.dialogue || value?.unavailable || value?.launchFailed || value?.timedOut || (value?.exitCode !== undefined && value.exitCode !== 0)) return value;
  const r = planningRequest(request);
  if (!r.state) return value; // Explicit historical-reader fixtures have no new state.
  const text = typeof value === 'string' ? value : value?.answer ?? value?.lastMessage ?? value?.content ?? '';
  const result = typeof value === 'string' ? { answer: value, content: value } : { ...value };
  const content = value?.agentMessages?.length ? value.agentMessages.join('\n\n') : text || 'Fixture response.';
  if (seat === 'claude') return { ...result, dialogue: planningEnvelope(r, ['propose', 'revise'].includes(r.action) ? r.action : 'propose', { content }) };
  if (/SELECTED_CANDIDATE/.test(text) || value?.selectedCandidateId) return { ...result, dialogue: planningEnvelope(r, 'verify', { content }) };
  if (/DECISION\s*:/i.test(text)) {
    const matches = [...text.matchAll(/^\s*DECISION\s*:\s*([^\n\r]*)/gim)];
    if (matches.length !== 1 || !['approve', 'stop', 'revise'].includes(matches[0][1].trim())) return result;
    if (matches[0][1].trim() === 'stop') return { ...result, dialogue: planningEnvelope(r, 'stop', { content }) };
    if (matches[0][1].trim() === 'approve') return { ...result, ...planningApproval(r, content) };
  }
  if (value?.agree === true || /AGREE:\s*yes/i.test(text)) return { ...result, ...planningApproval(r, content) };
  if (value?.agree === false || /AGREE:\s*no/i.test(text)) {
    if (r.state.proposalCycles < 2) return { ...result, dialogue: planningEnvelope(r, 'ask', { content,
      next: { seat: 'claude', action: 'revise', reason: content } }) };
    if (r.state.interactionMode === 'manual') return { ...result, dialogue: planningEnvelope(r, 'decide', { content,
      issues: [{ id: 'S1', title: 'Fixture unresolved dispute', blocking: true, status: 'disputed', claimIds: [] }] }) };
    return { ...result, dialogue: planningEnvelope(r, 'ask', { content,
      next: { seat: 'codex', action: 'decide', reason: content } }) };
  }
  return result;
}
export function scriptedPlanningAdapters(adapters) {
  return Object.fromEntries(Object.entries(adapters).map(([key, call]) => {
    const seat = ['author', 'runArbiter', 'draft'].includes(key) ? 'claude' : ['reviewer', 'runExecutor', 'codexReview'].includes(key) ? 'codex' : null;
    return [key, seat ? async r => scriptedPlanningResponse(r, await call(r), seat) : call];
  }));
}
export function scriptedFreshPlanningAdapters(adapters = {}) {
  return Object.fromEntries(Object.entries(adapters).map(([key, call]) => {
    const seat = key === 'draftPlanCandidate' ? 'claude' : ['reviewPlanCandidate', 'selectPlanCandidate'].includes(key) ? 'codex' : null;
    return [key, seat ? async r => scriptedPlanningResponse(r, await call(r), seat) : call];
  }));
}
