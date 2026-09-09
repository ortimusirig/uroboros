import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDialogueProjection, renderDialogueHtml, renderDialogueReport } from '../src/dialogue-report.js';

function fixture() {
  return {
    phase: 'planning',
    authority: 'codex',
    interactionMode: 'autonomous',
    approval: { seat: 'codex', messageId: 'M6', artifactDigest: 'artifact-d1', contextDigest: 'context-d1' },
    reason: 'Waiting for source inspection',
    next: { seat: 'claude', action: 'inspect', reason: 'Inspect the current parser source' },
    snapshot: {
      digest: 'context-d1',
      completeness: { complete: false, reasons: ['required source unavailable'] },
      entries: [{ id: 'req-1', kind: 'requirement', status: 'required', content: 'Keep v1 readable' }],
      recalled: [{ id: 'memory-version-2', logicalId: 'memory-1', status: 'verified', attribution: 'claude' }],
      recallSelection: { query: 'compatibility', selectedVersionIds: ['memory-version-2'] },
    },
    evidence: [
      { id: 'E-code', kind: 'code', locator: { path: 'src/parser.js', line: 17 }, sourceDigest: 'source-17' },
      { id: 'E-web', kind: 'external', locator: { url: 'https://example.test/spec' }, sourceDigest: 'web-1' },
      { id: 'E-missing', kind: 'command', status: 'missing', observed: false },
    ],
    messages: [
      { id: 'M1', sender: 'claude', phase: 'planning', action: 'ask', content: '<script>alert(1)</script> Why another service?',
        evidenceIds: ['E-code'], delivery: { status: 'delivered' } },
      { id: 'M2', sender: 'codex', phase: 'planning', action: 'answer', content: 'The current parser owns it.',
        claims: [{ id: 'C1', kind: 'fact', text: 'Parser owns the route', evidenceIds: ['E-code'] }] },
      { id: 'M3', sender: 'claude', phase: 'planning', action: 'rebut', content: 'I still dissent.', evidenceIds: ['E-web'], historical: true },
      { id: 'M4', sender: 'codex', phase: 'planning', action: 'challenge', content: 'token=known-secret-value', evidenceIds: ['E-missing'] },
      { id: 'M5', sender: 'claude', phase: 'planning', action: 'verify', content: 'I inspected it.',
        verifications: [{ claimId: 'C1', evidenceIds: ['E-code'], inspectionReceiptIds: ['R1'], result: 'insufficient', reason: 'The symbol is ambiguous' }] },
    ],
    claims: {
      C1: { id: 'C1', kind: 'fact', text: 'Parser owns the route', evidenceIds: ['E-code'], status: 'active' },
      C2: { id: 'C2', kind: 'hypothesis', text: 'A second parser may exist', evidenceIds: [], status: 'active' },
    },
    verifications: [{ claimId: 'C1', evidenceIds: ['E-code'], inspectionReceiptIds: ['R1'], result: 'insufficient', reason: 'The symbol is ambiguous', seat: 'claude' }],
    inspectionReceipts: { R1: { id: 'R1', seat: 'claude', evidenceIds: ['E-code'], observed: true, result: 'read' } },
    issues: { I1: { id: 'I1', title: 'Parser ownership', status: 'resolved', blocking: true,
      disposition: { kind: 'rejected', by: 'codex', reason: 'Source contradicts the finding', claimIds: ['C1'] } } },
    resources: { providerLaunches: 4, repairLaunches: 0, failedLaunches: 1,
      knownUsage: { inputTokens: 12, outputTokens: 5 }, usageUnknown: true },
    phaseResources: { providerLaunches: 1, knownUsage: { inputTokens: 2, outputTokens: 1 }, usageUnknown: false },
    phaseChain: [{ phase: 'execution', runId: 'child-1', action: 'replan',
      resources: { providerLaunches: 3, knownUsage: { inputTokens: 10, outputTokens: 4 }, usageUnknown: true } }],
    queueResources: { providerLaunches: 7, launchesUnknown: true, usageUnknown: true,
      knownUsage: { inputTokens: 20, outputTokens: 8 } },
    password: 'must-never-render',
    credential: { bearer: 'must-never-render-either' },
  };
}

test('dialogue report projects current context, history, evidence states, decisions, and resource scopes', () => {
  const markdown = renderDialogueReport(fixture());
  for (const expected of [
    'Shared context: context-d1', 'Phase: planning; authority: codex', 'Approved: yes',
    'Approval: codex / message M6', 'Next action: claude / inspect — Inspect the current parser source',
    'required source unavailable', 'memory-version-2', 'claude / ask', 'codex / answer',
    'claude / rebut', 'I still dissent.', 'E-code', 'src/parser.js:17',
    'https://example.test/spec', 'E-missing', 'missing / not observed',
    'delivered', 'R1', 'E-code', 'read', 'insufficient', 'rejected',
    'C2', 'hypothesis', 'missing / unknown',
    'Cumulative run resources', 'known subtotal: input 12, output 5', 'usage unknown: yes',
    'Current phase delta', 'Per-phase history', 'Queue cumulative', 'launches unknown: yes',
  ]) assert.match(markdown, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(markdown, /must-never-render|known-secret-value/);
  assert.match(markdown, /token=\[REDACTED\]/);
});

test('dialogue HTML escapes model text, permits only safe source hrefs, and separates inspection from assessment', () => {
  const html = renderDialogueHtml(fixture());
  assert.doesNotMatch(html, /<script>|must-never-render|known-secret-value/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/example[.]test\/spec"/);
  assert.doesNotMatch(html, /href="src\/parser[.]js/);
  assert.match(html, /Delivery.*delivered/s);
  assert.match(html, /Inspection receipt.*R1.*read/s);
  assert.match(html, /Assessment.*insufficient/s);

  const unsafe = renderDialogueHtml({ ...fixture(), evidence: [{ id: 'bad', kind: 'external', locator: { url: 'javascript:alert(1)' } }] });
  assert.doesNotMatch(unsafe, /href="javascript:/);
  assert.match(unsafe, /javascript:alert\(1\)/);
});

test('normalized dialogue is a fresh deep allowlist and stays stable when normalized again', () => {
  const source = fixture();
  source.approval.privateCredential = 'approval-secret';
  source.next.privateOptions = { token: 'next-secret' };
  source.snapshot.privateOptions = { token: 'snapshot-secret' };
  source.snapshot.entries[0].privateCredential = 'entry-secret';
  source.snapshot.recalled[0].provenance = { seat: 'claude', privateCredential: 'recall-secret' };
  source.messages[0].credential = 'message-secret';
  source.messages[0].delivery.privateCredential = 'delivery-secret';
  source.messages[1].claims[0].privateCredential = 'claim-secret';
  source.messages[4].verifications[0].privateCredential = 'verification-secret';
  source.evidence[0].privateCredential = 'evidence-secret';
  source.evidence[0].locator.privateCredential = 'locator-secret';
  source.issues.I1.privateCredential = 'issue-secret';
  source.issues.I1.disposition.privateCredential = 'disposition-secret';
  source.inspectionReceipts.R1.privateCredential = 'receipt-secret';
  source.resources.privateCredential = 'resources-secret';
  source.phaseChain[0].privateCredential = 'phase-secret';
  source.pendingDecision = { reason: 'Need a ruling', privateCredential: 'decision-secret' };
  source.technicalPause = { reason: 'Need reconciliation', privateCredential: 'pause-secret' };
  source.recall = { status: 'fallback', reason: 'search unavailable', privateCredential: 'search-secret' };

  const projection = normalizeDialogueProjection(source);
  assert.notEqual(projection.snapshot, source.snapshot);
  assert.notEqual(projection.messages[0], source.messages[0]);
  assert.notEqual(projection.resources, source.resources);
  assert.equal(JSON.stringify(projection).includes('secret'), false,
    'unknown/private nested producer fields must not survive in the display carrier');
  assert.deepEqual(Object.keys(projection.snapshot).sort(), ['completeness', 'digest', 'entries', 'recalled']);
  assert.deepEqual(Object.keys(projection.messages[0]).sort(),
    ['action', 'content', 'delivery', 'evidenceIds', 'phase', 'sender']);
  assert.deepEqual(Object.keys(projection.evidence[0]).sort(), ['id', 'kind', 'locator', 'sourceDigest']);
  assert.deepEqual(Object.keys(projection.resources).sort(),
    ['failedLaunches', 'knownUsage', 'providerLaunches', 'repairLaunches', 'usageUnknown']);
  assert.deepEqual(normalizeDialogueProjection(projection), projection,
    'dashboard-to-render normalization must preserve the complete allowlisted view');
});

test('URL userinfo is absent from Markdown and HTML for string and object locators', () => {
  for (const locator of [
    'https://alice:fake-secret@example.test/spec',
    { url: 'https://alice:fake-secret@example.test/spec' },
  ]) {
    const input = { ...fixture(), evidence: [{ id: 'userinfo', kind: 'external', locator }] };
    const markdown = renderDialogueReport(input);
    const html = renderDialogueHtml(input);
    for (const rendered of [markdown, html]) {
      assert.doesNotMatch(rendered, /alice|fake-secret/);
      assert.match(rendered, /https:\/\/example[.]test\/spec/);
    }
    assert.doesNotMatch(html, /href="https:\/\/alice:/);
  }
});
