import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSharedContext } from '../../src/shared-context.js';
import { captureEvidence, createInspectionReceipt } from '../../src/context-evidence.js';
import { createDialogueState } from '../../src/dialogue.js';

export function fixture(t, options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'uro-dialogue-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'), directory = join(base, 'evidence');
  mkdirSync(root); mkdirSync(directory);
  writeFileSync(join(root, 'source.js'), 'export const enabled = true;\n');
  const evidence = captureEvidence({ projectId: 'p1', root, directory, evidence: {
    id: 'E1', kind: 'requirement', projectId: 'p1', claimIds: ['C1'],
    locator: { briefingId: 'B1' }, text: 'Keep the feature enabled.', sourceIdentity: 'brief-1',
  } });
  const snapshot = createSharedContext({ projectId: 'p1', runId: 'r1', unitId: 'u1', phase: options.phase ?? 'planning',
    sourceRevision: 'base', entries: [], evidence: [evidence] });
  const state = createDialogueState({ runId: 'r1', projectId: 'p1', phase: options.phase ?? 'planning',
    interactionMode: 'autonomous', snapshot, artifactDigest: 'a1', scope: { sourceRoots: [root], evidenceRoots: [directory] }, ...options });
  return { base, root, directory, evidence, snapshot, state };
}

export const claim = { id: 'C1', kind: 'fact', text: 'The briefing requires the feature enabled.', evidenceIds: ['E1'] };

export function envelope(state, action, overrides = {}) {
  return { schemaVersion: 1, action, artifactDigest: state.artifactDigest, contextDigest: state.snapshot.digest,
    replyTo: null, content: 'Discuss the feature.', claims: [], issues: [], evidence: [], verifications: [], next: null, ...overrides };
}

// Represents an observed harness operation, never a receipt body in model output.
export function observe(state, seat = 'codex', evidence = state.evidence, operationId = 'read-1') {
  const receipt = createInspectionReceipt({ operationId, seat, evidence, inspected: true, result: 'read' });
  state.operations[operationId] = { status: 'completed', seat, effect: 'inspect', evidenceIds: evidence.map(e => e.id), receiptIds: [receipt.id] };
  state.inspectionReceipts[receipt.id] = receipt;
  return receipt;
}

export function support(receipt, overrides = {}) {
  return { claimId: 'C1', evidenceIds: ['E1'], inspectionReceiptIds: [receipt.id], result: 'supports', reason: 'The captured briefing says this.', ...overrides };
}
