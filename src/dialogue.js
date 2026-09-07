import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { decisionAuthority } from './decision-policy.js';
import { validateSharedContext } from './shared-context.js';
import { validateClaims, validateEvidence } from './context-evidence.js';

const ACTIONS = new Set(['propose', 'ask', 'answer', 'inspect', 'challenge', 'rebut', 'withdraw', 'revise', 'verify', 'approve', 'decide', 'replan', 'stop']);
const OPEN = new Set(['open', 'awaiting-answer', 'awaiting-verification', 'disputed']);
const DISPOSITIONS = new Set(['accepted', 'rejected', 'corrected', 'withdrawn', 'deferred']);
const substantive = claim => ['fact', 'inference'].includes(claim.kind);
const sameIdentity = (item, state) => item.artifactDigest === state.artifactDigest && item.contextDigest === state.snapshot.digest;
const string = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} required`); };
function identifier(value, label) {
  string(value, label);
  if (['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error(`reserved ${label} identifier`);
}
function inside(root, file) {
  const rel = relative(root, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function checkedEvidence(state, item) {
  // Enforce the two authorities independently before the low-level combined-root validator.
  const sources = state.scope.sourceRoots.map(root => realpathSync.native(root));
  const captures = state.scope.evidenceRoots.map(root => realpathSync.native(root));
  if (!existsSync(item.capturedPath ?? '') || !captures.some(root => inside(root, realpathSync.native(item.capturedPath)))) throw new Error('evidence captured path outside trusted scope');
  if (item.kind === 'code') {
    const validSource = sources.some(root => {
      const candidate = resolve(root, item.locator.path);
      if (!inside(root, candidate) || !existsSync(candidate)) return false;
      const file = realpathSync.native(candidate);
      return inside(root, file) && statSync(file).isFile()
        && createHash('sha256').update(readFileSync(file)).digest('hex') === item.sourceDigest;
    });
    if (!validSource) throw new Error('evidence source stale or outside source scope');
  }
  const result = validateEvidence({ evidence: item, projectId: state.projectId, roots: [...sources, ...captures] });
  if (!result.valid) throw new Error(result.reason);
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.schemaVersion !== 1
    || !ACTIONS.has(envelope.action)) throw new Error('invalid dialogue envelope action or schema');
  for (const key of ['artifactDigest', 'contextDigest', 'content']) string(envelope[key], `envelope ${key}`);
  for (const key of ['claims', 'issues', 'evidence', 'verifications']) if (!Array.isArray(envelope[key])) throw new Error(`envelope ${key} must be an array`);
  if (envelope.replyTo !== null && typeof envelope.replyTo !== 'string') throw new Error('envelope reply target required');
  if (envelope.next !== null) {
    if (!envelope.next || !['claude', 'codex'].includes(envelope.next.seat) || !ACTIONS.has(envelope.next.action)) throw new Error('invalid dialogue next action');
    string(envelope.next.reason, 'next reason');
  }
  return envelope;
}

export function createDialogueState({ runId, projectId, phase, interactionMode = 'manual', snapshot, artifactDigest,
  limits = {}, continuation, scope = { sourceRoots: [], evidenceRoots: [] } }) {
  validateSharedContext({ snapshot, projectId });
  if (snapshot.runId !== runId || snapshot.phase !== phase || !artifactDigest) throw new Error('dialogue identity mismatch');
  const authority = decisionAuthority({ phase, interactionMode });
  const reviewer = phase === 'planning' ? 'codex' : 'claude';
  for (const key of ['rounds', 'proposalCycles', 'corrections', 'challenges']) {
    if (limits[key] !== undefined && (!Number.isInteger(limits[key]) || limits[key] < 0)) throw new Error(`invalid explicit ${key} limit`);
  }
  const canonicalScope = Object.fromEntries(['sourceRoots', 'evidenceRoots'].map(key => {
    if (!Array.isArray(scope[key])) throw new Error('trusted scope roots required');
    return [key, scope[key].map(root => realpathSync.native(root))];
  }));
  if (continuation) {
    if (continuation.schemaVersion !== 2 || continuation.runId !== runId || continuation.projectId !== projectId
      || continuation.phase !== phase || continuation.interactionMode !== interactionMode
      || continuation.artifactDigest !== artifactDigest || continuation.snapshot.digest !== snapshot.digest
      || JSON.stringify(continuation.scope) !== JSON.stringify(canonicalScope)) throw new Error('stale dialogue continuation identity or scope');
    return structuredClone(continuation);
  }
  return structuredClone({ schemaVersion: 2, runId, projectId, phase, interactionMode, authority, reviewer,
    author: reviewer === 'codex' ? 'claude' : 'codex', snapshot, artifactDigest, scope: canonicalScope,
    messages: [], issues: {}, claims: {}, evidence: structuredClone(snapshot.evidence), inspectionReceipts: {}, operations: {}, verifications: [],
    approval: null, next: { seat: reviewer, action: 'verify', reason: 'Review current artifact' }, proposalCycles: 0,
    correctionCycles: 0, challengeCycles: 0, historicalEvidenceIds: [], limits, resources: {}, pendingDecision: null, technicalPause: null, pendingOperation: null,
    pendingArtifact: null, pendingInspection: null, memoryProposals: [] });
}
export function parseDialogueEnvelope({ response }) {
  if (response && typeof response === 'object' && response.dialogue) return structuredClone(validateEnvelope(response.dialogue));
  const text = typeof response === 'string' ? response : response?.content;
  const blocks = typeof text === 'string' ? [...text.matchAll(/<UROBOROS_DIALOGUE>([\s\S]*?)<\/UROBOROS_DIALOGUE>/g)] : [];
  if (blocks.length !== 1 || (text.match(/<\/?UROBOROS_DIALOGUE>/g) ?? []).length !== 2) throw new Error('exactly one complete dialogue envelope block required');
  let envelope;
  try { envelope = JSON.parse(blocks[0][1]); } catch { throw new Error('malformed dialogue envelope JSON'); }
  return structuredClone(validateEnvelope(envelope));
}

function approvalProblem(state) {
  if (state.technicalPause || state.pendingDecision || state.pendingArtifact) return 'dialogue has a pending decision, pause or unapplied revision';
  if (state.snapshot.completeness?.complete !== true) return 'required context incomplete';
  if (Object.values(state.issues).some(issue => issue.blocking && OPEN.has(issue.status))) return 'open blocking issue or dispute';
  const premises = Object.values(state.claims).filter(item => item.status !== 'retired' && substantive(item) && sameIdentity(item, state));
  if (!premises.length) return 'approval requires evidenced factual premises';
  for (const claim of premises) {
    const assessments = state.verifications.filter(v => v.claimId === claim.id && sameIdentity(v, state));
    if (assessments.some(v => v.result === 'contradicts' || v.result === 'insufficient')) return `claim ${claim.id} has contradictory or insufficient verification`;
    if (!assessments.some(v => v.seat === state.reviewer && v.result === 'supports')) return `claim ${claim.id} requires reviewer support verification`;
    for (const id of claim.evidenceIds) checkedEvidence(state, state.evidence.find(e => e.id === id));
  }
  return null;
}

export function canApproveDialogue({ state, seat }) {
  try {
    if (seat !== state.reviewer || state.approval?.seat !== seat) return { approved: false, reason: 'current reviewer approval required' };
    if (!sameIdentity(state.approval, state)) return { approved: false, reason: 'stale approval identity' };
    validateSharedContext({ snapshot: state.snapshot, projectId: state.projectId });
    const reason = approvalProblem(state);
    return reason ? { approved: false, reason } : { approved: true };
  } catch (error) { return { approved: false, reason: error.message }; }
}

export function applyDialogueEnvelope({ state, envelope, seat, evidence = [], verifications = [] }) {
  validateEnvelope(envelope);
  if (!['claude', 'codex'].includes(seat)) throw new Error('invalid dialogue seat');
  if ((envelope.sender !== undefined && envelope.sender !== seat) || (envelope.seat !== undefined && envelope.seat !== seat)) throw new Error('sender seat impersonation');
  if (envelope.phase !== undefined && envelope.phase !== state.phase) throw new Error('phase impersonation');
  if (!sameIdentity(envelope, state)) throw new Error('stale dialogue identity');
  validateSharedContext({ snapshot: state.snapshot, projectId: state.projectId });
  if (envelope.replyTo !== null && !state.messages.some(m => m.id === envelope.replyTo)) throw new Error('unknown reply target');
  if (['propose', 'revise'].includes(envelope.action) && seat !== state.author) throw new Error('only designated author may propose or revise');
  if (['approve', 'decide', 'replan', 'stop'].includes(envelope.action) && seat !== state.reviewer) throw new Error('wrong reviewer authority');
  const next = structuredClone(state);
  const identity = { artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest };
  const messageId = `${state.runId}:${state.phase}:message-${state.messages.length + 1}`;
  for (const item of [...evidence, ...envelope.evidence]) {
    const registered = state.evidence.find(e => e.id === (typeof item === 'string' ? item : item?.id));
    if (!registered || (typeof item !== 'string' && JSON.stringify(item) !== JSON.stringify(registered))) throw new Error('evidence not in trusted registry');
    checkedEvidence(state, registered);
  }
  const seenClaims = new Set();
  for (const claim of envelope.claims) {
    identifier(claim.id, 'claim id'); string(claim.text, 'claim text');
    if (!['fact', 'inference', 'hypothesis', 'question', 'preference'].includes(claim.kind) || !Array.isArray(claim.evidenceIds)) throw new Error('invalid claim kind or evidence');
    if (seenClaims.has(claim.id)) throw new Error('duplicate claim id');
    seenClaims.add(claim.id);
    const old = next.claims[claim.id];
    if (old?.status === 'retired') throw new Error('retired claim cannot be reused as a live premise; use a new supported claim');
    if (old && (old.kind !== claim.kind || old.text !== claim.text || JSON.stringify(old.evidenceIds) !== JSON.stringify(claim.evidenceIds))) throw new Error('claim identity conflict; use a new claim id');
    for (const id of claim.evidenceIds) {
      const item = next.evidence.find(e => e.id === id);
      if (!item) throw new Error('unknown claim evidence');
      checkedEvidence(next, item);
    }
    next.claims[claim.id] = { id: claim.id, kind: claim.kind, text: claim.text, evidenceIds: claim.evidenceIds,
      sender: old?.sender ?? seat, messageId: old?.messageId ?? messageId, status: 'active', ...identity };
  }
  const resolved = [];
  for (const verification of [...envelope.verifications, ...verifications]) {
    const claim = next.claims[verification.claimId];
    if (!claim) throw new Error('unknown verification claim reference');
    if (claim.status === 'retired') throw new Error('retired claim cannot be reused as a verification premise');
    if (!sameIdentity(claim, state)) throw new Error('stale verification claim');
    if (!['supports', 'contradicts', 'insufficient'].includes(verification.result)) throw new Error('invalid verification result');
    string(verification.reason, 'verification reason');
    if (!Array.isArray(verification.inspectionReceiptIds) || !verification.inspectionReceiptIds.length) throw new Error('verification requires registered receipt ids');
    const receipts = verification.inspectionReceiptIds.map(id => {
      const receipt = next.inspectionReceipts[id], operation = receipt && next.operations[receipt.operationId];
      if (!receipt || receipt.id !== id || receipt.seat !== seat || !operation || operation.status !== 'completed'
        || operation.seat !== seat || !operation.receiptIds?.includes(id)
        || !receipt.evidenceIds.every(eid => operation.evidenceIds?.includes(eid))) throw new Error('inspection receipt missing authenticated completed operation binding');
      return receipt;
    });
    for (const id of verification.evidenceIds ?? []) {
      const item = next.evidence.find(e => e.id === id);
      if (!item) throw new Error('unknown verification evidence');
      checkedEvidence(next, item);
    }
    const record = { claimId: verification.claimId, evidenceIds: verification.evidenceIds,
      inspectionReceiptIds: verification.inspectionReceiptIds, result: verification.result, reason: verification.reason,
      seat, messageId, ...identity };
    resolved.push({ ...record, inspectionReceipts: receipts });
    next.verifications = next.verifications.filter(v => !(v.claimId === record.claimId && v.seat === seat && sameIdentity(v, state)));
    next.verifications.push(record);
  }
  const checked = validateClaims({ claims: [...new Map([...envelope.claims, ...resolved.map(v => next.claims[v.claimId])].map(c => [c.id, c])).values()],
    evidence: next.evidence, projectId: state.projectId, roots: [...state.scope.sourceRoots, ...state.scope.evidenceRoots], verifications: resolved, seat });
  if (!checked.valid) throw new Error(checked.errors.join('; '));
  const seenIssues = new Set();
  for (const update of envelope.issues) {
    identifier(update.id, 'issue id');
    if (seenIssues.has(update.id)) throw new Error('duplicate issue id');
    seenIssues.add(update.id);
    const old = next.issues[update.id];
    if (!old) { string(update.title, 'issue title'); if (typeof update.blocking !== 'boolean') throw new Error('issue blocking flag required'); }
    for (const id of update.claimIds ?? []) if (!Object.hasOwn(next.claims, id) || next.claims[id].status === 'retired') throw new Error('unknown or retired issue claim reference');
    if (!OPEN.has(update.status) && !['resolved', 'withdrawn'].includes(update.status)) throw new Error('invented issue disposition or status');
    if (['resolved', 'withdrawn'].includes(update.status)) {
      if (!old) throw new Error('cannot close unknown issue');
      const disposition = update.disposition;
      if (!disposition || !DISPOSITIONS.has(disposition.kind)) throw new Error('explicit authorized disposition required');
      string(disposition.reason, 'disposition reason');
      const withdrawal = ['withdraw', 'approve', 'decide'].includes(envelope.action) && old.openedBy === seat && disposition.kind === 'withdrawn';
      if (!withdrawal && (seat !== state.reviewer || !['verify', 'decide', 'approve'].includes(envelope.action))) throw new Error('wrong issue disposition authority');
      if (!withdrawal) {
        if (!Array.isArray(disposition.claimIds) || !disposition.claimIds.length) throw new Error('disposition requires evidenced claims');
        for (const id of disposition.claimIds) {
          if (!Object.hasOwn(next.claims, id) || next.claims[id].status === 'retired' || !substantive(next.claims[id])
            || !next.verifications.some(v => v.claimId === id && v.seat === seat && v.result === 'supports' && sameIdentity(v, state))) throw new Error('unsupported or retired disposition claim');
        }
      }
      if (!withdrawal && old.status === 'disputed' && state.authority === 'human') {
        next.pendingDecision = { authority: 'human', messageId, issues: envelope.issues, reason: envelope.content, ...identity };
        continue;
      }
      next.issues[update.id] = { ...old, status: update.status,
        disposition: { kind: disposition.kind, reason: disposition.reason, claimIds: disposition.claimIds ?? [], by: seat, messageId, ...identity } };
    } else {
      next.issues[update.id] = { ...old, id: update.id, title: old?.title ?? update.title, status: old?.status === 'disputed' ? 'disputed' : update.status,
        blocking: old?.blocking ?? update.blocking, claimIds: update.claimIds ?? old?.claimIds ?? [], openedBy: old?.openedBy ?? seat };
      next.approval = null;
    }
  }
  // Retire only claims explicitly linked to an applicable disposition. Keep their text,
  // contrary assessments and original messages; retirement is not verification.
  for (const update of envelope.issues) {
    const old = state.issues[update.id], issue = next.issues[update.id];
    if (!old || issue.disposition?.messageId !== messageId || !['rejected', 'withdrawn'].includes(issue.disposition.kind)) continue;
    for (const id of old.claimIds ?? []) {
      const claim = next.claims[id];
      if (!claim || claim.status === 'retired') continue;
      const applicable = issue.disposition.kind === 'withdrawn' ? claim.sender === seat
        : seat === state.reviewer && next.verifications.some(v => v.claimId === id && v.result === 'contradicts' && sameIdentity(v, state));
      const stillUsed = Object.values(next.issues).some(other =>
        (OPEN.has(other.status) && other.blocking && other.claimIds?.includes(id))
        || other.disposition?.claimIds?.includes(id))
        || (envelope.action === 'approve' && envelope.claims.some(premise => premise.id === id));
      if (applicable && !stillUsed) {
        claim.status = 'retired';
        claim.retirement = { issueId: issue.id, kind: issue.disposition.kind, seat, messageId, reason: issue.disposition.reason, ...identity };
      }
    }
  }
  for (const proposal of envelope.memoryProposals ?? []) {
    string(proposal.id, 'memory proposal id'); string(proposal.content, 'memory proposal content'); string(proposal.kind, 'memory proposal kind');
    if (next.memoryProposals.some(p => p.id === proposal.id)) throw new Error('duplicate memory proposal id');
    if (!Array.isArray(proposal.claimIds) || !proposal.claimIds.length || proposal.claimIds.some(id => !Object.hasOwn(next.claims, id))) throw new Error('unknown memory proposal claim reference');
    if (proposal.claimIds.some(id => next.claims[id].status === 'retired')) throw new Error('retired claim cannot be a notebook premise');
    if (proposal.issueId !== undefined && !Object.hasOwn(next.issues, proposal.issueId)) throw new Error('unknown memory proposal issue reference');
    if (proposal.tags !== undefined && (!Array.isArray(proposal.tags) || proposal.tags.some(tag => typeof tag !== 'string'))) throw new Error('invalid memory proposal tags');
    next.memoryProposals.push({ id: proposal.id, content: proposal.content, kind: proposal.kind, claimIds: proposal.claimIds,
      ...(proposal.issueId !== undefined ? { issueId: proposal.issueId } : {}), tags: proposal.tags ?? [], status: 'proposed',
      provenance: { seat, messageId, runId: state.runId, projectId: state.projectId, phase: state.phase, ...identity } });
  }
  if (['propose', 'revise'].includes(envelope.action)) {
    const ceiling = next.limits.rounds ?? next.limits.proposalCycles;
    if (ceiling !== undefined && next.proposalCycles >= ceiling) throw new Error('explicit proposal-cycle limit reached');
    if (envelope.action === 'revise' && next.limits.corrections !== undefined && next.correctionCycles >= next.limits.corrections) throw new Error('explicit correction-cycle limit reached');
    next.proposalCycles++;
    if (envelope.action === 'revise') next.correctionCycles++;
    next.pendingArtifact = { messageId, seat, action: envelope.action, providerOperationId: state.pendingOperation?.operationId ?? null, ...identity };
    next.approval = null;
  }
  if (envelope.action === 'challenge') {
    if (next.limits.challenges !== undefined && next.challengeCycles >= next.limits.challenges) throw new Error('explicit challenge limit reached');
    next.challengeCycles++;
  }
  if (envelope.action === 'inspect') next.pendingInspection = { messageId, seat, requests: envelope.requests };
  if (envelope.action === 'decide' && state.authority === 'human' && Object.values(next.issues).some(i => i.status === 'disputed')) {
    next.pendingDecision ??= { authority: 'human', messageId, reason: envelope.content, ...identity };
  }
  if (envelope.action === 'approve') {
    const problem = approvalProblem(next);
    if (problem) throw new Error(problem);
    next.approval = { seat, messageId, ...identity };
  }
  if (['stop', 'replan'].includes(envelope.action)) { next.approval = null; next.terminalAction = envelope.action; next.stopReason = envelope.content; }
  next.next = envelope.next ?? { seat: seat === 'claude' ? 'codex' : 'claude', action: envelope.action === 'ask' ? 'answer' : 'verify', reason: 'Assess counterpart response' };
  next.messages.push({ ...envelope, id: messageId, sender: seat, phase: state.phase,
    operationId: state.pendingOperation?.operationId ?? null, sequence: state.messages.length + 1 });
  return next;
}
