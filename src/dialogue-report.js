import { decodeRecordedText } from './execution-record.js';
import { readWorkflowBinding, summarizeWorkflowBinding } from './workflow-profiles.js';

// A display projection has deliberately lost raw authentication material. Keep its
// validated summary privately for the in-process dashboard -> HTML path; serialized
// or caller-supplied summaries are never accepted as captured bindings.
const projectedWorkflows = new WeakMap();
const reservedWorkflowEntry = entry => entry?.id === 'uroboros-workflow-binding' || entry?.kind === 'workflow-binding';

function workflowProjection(input, snapshot, checkpoint, phase) {
  const prior = projectedWorkflows.get(input);
  if (prior) return prior.phase === phase && prior.snapshot === JSON.stringify(snapshot) && checkpoint.workflow === undefined
    ? structuredClone(prior.workflow) : { mode: 'invalid', profiles: [] };
  try {
    const binding = readWorkflowBinding({ snapshot: snapshot ?? {}, expected: checkpoint.workflow, allowLegacy: true });
    return summarizeWorkflowBinding({ binding, phase: ['planning', 'execution', 'acceptance'].includes(phase) ? phase : undefined });
  } catch {
    return { mode: 'invalid', profiles: [] };
  }
}

/** Formats only the curated summary produced by the report projection. */
export function renderWorkflowSummary(workflow) {
  const lines = [`Workflow: ${scalar(workflow?.mode, 'unavailable')}${workflow?.digest ? `; digest ${scalar(workflow.digest)}` : ''}`];
  for (const profile of workflow?.profiles ?? []) lines.push(`- ${scalar(profile.id)} / adapter revision ${scalar(profile.adapterRevision)} / upstream ${scalar(profile.upstreamCommit)} / sections: ${(profile.sections ?? []).map(screenText).join(', ')}`);
  lines.push('Guidance delivery does not demonstrate comprehension or quality; approval still requires evidence and reviewer judgment.');
  return lines.join('\n');
}

function screenText(value) {
  let text = String(value ?? '');
  text = text.replace(
    /((?:^|[^A-Za-z0-9_$])\$?(?:"|')?(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)(?:"|')?\s*\]?\s*[=:]\s*)(?:(['"])(.*?)\2|([^,;}\r\n]+))/gi,
    '$1[REDACTED]',
  );
  text = text.replace(/(\bbearer\s+)[A-Za-z0-9._~+/-]{8,}={0,2}(?![A-Za-z0-9._~+/-])/gi, '$1[REDACTED]');
  return text.replace(/\b(?:sk-|gh[opusr][_-]|github_pat[_-])[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

function scalar(value, fallback = 'not recorded') {
  return value === undefined || value === null || value === '' ? fallback : screenText(value);
}

function messageContent(message) {
  if (message?.recordedContent) return screenText(decodeRecordedText(message.recordedContent).text);
  return screenText(message?.content ?? '');
}

function locatorText(locator) {
  const raw = typeof locator === 'string' ? locator
    : locator && typeof locator === 'object' ? (typeof locator.path === 'string' ? locator.path : locator.url) : null;
  let displayed = raw;
  if (typeof raw === 'string') {
    try {
      const parsed = new URL(raw);
      if (['https:', 'http:'].includes(parsed.protocol)) {
        parsed.username = '';
        parsed.password = '';
        displayed = parsed.href;
      }
    } catch { /* local paths and opaque references remain plain screened text */ }
  }
  const line = locator && typeof locator === 'object' && Number.isSafeInteger(locator.line) ? `:${locator.line}` : '';
  return `${scalar(displayed)}${line}`;
}

function evidenceState(evidence) {
  if (evidence?.status === 'missing' || evidence?.missing === true) return 'missing / not observed';
  if (evidence?.observed === false) return 'not observed';
  return evidence?.status ? screenText(evidence.status) : 'recorded';
}

function valuesOf(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? Object.values(value) : [];
}

function textFields(value, fields) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const field of fields) {
    if (value[field] !== undefined && value[field] !== null) result[field] = screenText(value[field]);
  }
  return result;
}

function booleanField(result, value, field) {
  if (typeof value?.[field] === 'boolean') result[field] = value[field];
}

function numberField(result, value, field) {
  if (Number.isFinite(value?.[field])) result[field] = value[field];
}

function normalizeLocator(locator) {
  if (typeof locator === 'string') return locatorText(locator);
  if (!locator || typeof locator !== 'object') return null;
  const result = {};
  if (typeof locator.path === 'string') result.path = screenText(locator.path);
  if (typeof locator.url === 'string') result.url = locatorText(locator.url);
  if (Number.isSafeInteger(locator.line)) result.line = locator.line;
  return result;
}

function normalizeClaim(claim) {
  const result = textFields(claim, ['id', 'kind', 'status', 'text']) ?? {};
  if (Array.isArray(claim?.evidenceIds)) result.evidenceIds = claim.evidenceIds.map(screenText);
  return result;
}

function normalizeVerification(verification) {
  const result = textFields(verification, ['result', 'claimId', 'seat', 'reason']) ?? {};
  if (Array.isArray(verification?.evidenceIds)) result.evidenceIds = verification.evidenceIds.map(screenText);
  if (Array.isArray(verification?.inspectionReceiptIds)) {
    result.inspectionReceiptIds = verification.inspectionReceiptIds.map(screenText);
  }
  return result;
}

function normalizeDisposition(disposition, issueId) {
  const result = textFields(disposition, ['issueId', 'kind', 'disposition', 'status', 'by', 'decidedBy', 'reason']) ?? {};
  if (result.issueId === undefined && issueId !== undefined) result.issueId = screenText(issueId);
  if (Array.isArray(disposition?.claimIds)) result.claimIds = disposition.claimIds.map(screenText);
  return result;
}

function normalizeIssue(issue) {
  const result = textFields(issue, ['id', 'status', 'title']) ?? {};
  booleanField(result, issue, 'blocking');
  return result;
}

function normalizeMessage(message) {
  const result = textFields(message, ['sender', 'speaker', 'provider', 'action', 'role', 'phase']) ?? {};
  if (message?.recordedContent || message?.content !== undefined) result.content = messageContent(message);
  booleanField(result, message, 'historical');
  if (message?.delivery && typeof message.delivery === 'object') {
    result.delivery = textFields(message.delivery, ['status']);
  } else if (message?.delivery !== undefined && message.delivery !== null) {
    result.delivery = screenText(message.delivery);
  }
  const references = Array.isArray(message?.evidenceIds) ? message.evidenceIds
    : Array.isArray(message?.evidence) ? message.evidence : null;
  if (references) result.evidenceIds = references.map(reference => screenText(
    typeof reference === 'string' ? reference : reference?.id,
  ));
  if (Array.isArray(message?.claims)) result.claims = message.claims.map(normalizeClaim);
  if (Array.isArray(message?.verifications)) result.verifications = message.verifications.map(normalizeVerification);
  return result;
}

function normalizeEvidence(evidence) {
  const result = textFields(evidence, ['id', 'kind', 'status', 'sourceDigest']) ?? {};
  booleanField(result, evidence, 'missing');
  booleanField(result, evidence, 'observed');
  if (evidence?.locator !== undefined) result.locator = normalizeLocator(evidence.locator);
  return result;
}

function normalizeReceipt(receipt) {
  const result = textFields(receipt, ['id', 'seat', 'evidenceId', 'result']) ?? {};
  booleanField(result, receipt, 'observed');
  if (Array.isArray(receipt?.evidenceIds)) result.evidenceIds = receipt.evidenceIds.map(screenText);
  return result;
}

function normalizeResources(resources) {
  if (!resources || typeof resources !== 'object') return null;
  const result = {};
  for (const field of ['providerLaunches', 'repairLaunches', 'failedLaunches']) numberField(result, resources, field);
  for (const field of ['usageUnknown', 'launchesUnknown']) booleanField(result, resources, field);
  if (resources.knownUsage && typeof resources.knownUsage === 'object') {
    result.knownUsage = {};
    for (const field of ['inputTokens', 'outputTokens']) numberField(result.knownUsage, resources.knownUsage, field);
  }
  return result;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const result = textFields(snapshot, ['digest']) ?? {};
  if (snapshot.completeness && typeof snapshot.completeness === 'object') {
    result.completeness = {};
    booleanField(result.completeness, snapshot.completeness, 'complete');
    if (Array.isArray(snapshot.completeness.reasons)) {
      result.completeness.reasons = snapshot.completeness.reasons.map(screenText);
    }
  }
  result.entries = Array.isArray(snapshot.entries)
    ? snapshot.entries.map(entry => {
      if (reservedWorkflowEntry(entry)) return { ...(textFields(entry, ['id', 'kind', 'status']) ?? {}),
        content: 'Captured workflow binding; see the curated workflow summary.' };
      // Known harness carriers may contain entire nested snapshots/bindings. Their
      // opaque capture is retained on disk, not repeated in the display manifest.
      if (['queueParent', 'retained-phase', 'planning-handoff'].includes(entry?.kind)) {
        return { ...(textFields(entry, ['id', 'kind', 'status', 'reference']) ?? {}),
          content: 'Captured parent context; inspect the retained snapshot for details.' };
      }
      return textFields(entry, ['id', 'kind', 'status', 'content', 'reference']) ?? {};
    }) : [];
  result.recalled = Array.isArray(snapshot.recalled) ? snapshot.recalled.map(item => {
    const recalled = textFields(item, ['versionId', 'id', 'logicalId', 'entryId', 'status', 'attribution']) ?? {};
    if (item?.provenance && typeof item.provenance === 'object') {
      recalled.provenance = textFields(item.provenance, ['seat']);
    }
    return recalled;
  }) : [];
  return result;
}

function resourceLine(label, resources) {
  if (!resources || typeof resources !== 'object') return null;
  const known = resources.knownUsage ?? {};
  const values = [
    `${label}: provider launches ${Number.isFinite(resources.providerLaunches) ? resources.providerLaunches : 'not recorded'}`,
    `known subtotal: input ${Number.isFinite(known.inputTokens) ? known.inputTokens : 'not recorded'}, output ${Number.isFinite(known.outputTokens) ? known.outputTokens : 'not recorded'}`,
    `usage unknown: ${resources.usageUnknown === true ? 'yes' : resources.usageUnknown === false ? 'no' : 'not recorded'}`,
  ];
  if (resources.launchesUnknown !== undefined) values.push(`launches unknown: ${resources.launchesUnknown === true ? 'yes' : 'no'}`);
  if (Number.isFinite(resources.repairLaunches)) values.push(`repair launches ${resources.repairLaunches}`);
  if (Number.isFinite(resources.failedLaunches)) values.push(`failed launches ${resources.failedLaunches}`);
  return values.join('; ');
}

/** Normalize only public display fields; never return a raw checkpoint or options object. */
export function normalizeDialogueProjection(input = {}) {
  const dialogue = input.dialogue && typeof input.dialogue === 'object' ? input.dialogue : input;
  const checkpoint = input.checkpointState && typeof input.checkpointState === 'object' ? input.checkpointState : {};
  const rawSnapshot = dialogue.snapshot ?? input.snapshot ?? null;
  const rawApproval = Object.hasOwn(input, 'approval') ? input.approval : dialogue.approval ?? null;
  const rawNext = input.next ?? dialogue.next ?? null;
  const rawIssues = valuesOf(dialogue.issues);
  const issues = rawIssues.map(normalizeIssue);
  const rawReceipts = valuesOf(dialogue.inspectionReceipts).length
    ? valuesOf(dialogue.inspectionReceipts) : valuesOf(dialogue.receipts);
  const phase = scalar(input.phase ?? dialogue.phase ?? checkpoint.phase ?? null, null);
  const result = {
    phase,
    workflow: workflowProjection(input, rawSnapshot, checkpoint, phase),
    authority: scalar(input.authority ?? dialogue.authority ?? null, null),
    interactionMode: scalar(input.interactionMode ?? dialogue.interactionMode ?? null, null),
    approved: input.approved ?? dialogue.approved ?? (rawApproval ? true : null),
    approval: textFields(rawApproval, ['seat', 'decidedBy', 'messageId', 'artifactDigest', 'contextDigest', 'basis', 'reason']),
    reason: scalar(input.reason ?? dialogue.reason ?? checkpoint.reason ?? null, null),
    next: textFields(rawNext, ['seat', 'action', 'reason']),
    nextAction: scalar(input.nextAction ?? dialogue.nextAction ?? rawNext?.action ?? checkpoint.action ?? null, null),
    snapshot: normalizeSnapshot(rawSnapshot),
    messages: (Array.isArray(dialogue.messages) ? dialogue.messages
      : Array.isArray(input.messages) ? input.messages : []).map(normalizeMessage),
    evidence: (Array.isArray(dialogue.evidence) ? dialogue.evidence
      : Array.isArray(input.evidence) ? input.evidence : []).map(normalizeEvidence),
    claims: valuesOf(dialogue.claims).map(normalizeClaim),
    verifications: valuesOf(dialogue.verifications).map(normalizeVerification),
    issues,
    dispositions: [...valuesOf(dialogue.dispositions).map(item => normalizeDisposition(item)),
      ...rawIssues.filter(issue => issue?.disposition).map(issue => normalizeDisposition(issue.disposition, issue.id))],
    inspectionReceipts: rawReceipts.map(normalizeReceipt),
    resources: normalizeResources(input.resources ?? checkpoint.resources ?? dialogue.resources ?? null),
    phaseResources: normalizeResources(checkpoint.phaseResources ?? input.phaseResources ?? null),
    phaseChain: Array.isArray(checkpoint.phaseChain) ? checkpoint.phaseChain
      .map(phase => ({ ...(textFields(phase, ['phase', 'runId', 'action']) ?? {}), resources: normalizeResources(phase.resources) }))
      : Array.isArray(input.phaseChain) ? input.phaseChain
        .map(phase => ({ ...(textFields(phase, ['phase', 'runId', 'action']) ?? {}), resources: normalizeResources(phase.resources) })) : [],
    queueResources: normalizeResources(input.queueResult?.resources ?? input.queueResources ?? null),
    pendingDecision: textFields(dialogue.pendingDecision, ['reason', 'question']),
    technicalPause: textFields(dialogue.technicalPause ?? checkpoint.technicalPause, ['reason']),
    recall: textFields(input.recall ?? checkpoint.recall, ['status', 'detail', 'reason']),
  };
  projectedWorkflows.set(result, { phase, snapshot: JSON.stringify(result.snapshot), workflow: structuredClone(result.workflow) });
  return result;
}

export function renderDialogueReport(input) {
  const state = normalizeDialogueProjection(input);
  const lines = [
    `Shared context: ${scalar(state.snapshot?.digest)}`,
    `Phase: ${scalar(state.phase)}; authority: ${scalar(state.authority)}; mode: ${scalar(state.interactionMode)}`,
    `Approved: ${state.approved === true ? 'yes' : state.approved === false ? 'no' : 'not recorded'}`,
    renderWorkflowSummary(state.workflow),
  ];
  if (state.approval) lines.push(`Approval: ${scalar(state.approval.seat ?? state.approval.decidedBy)} / message ${scalar(state.approval.messageId)} / artifact ${scalar(state.approval.artifactDigest)} / context ${scalar(state.approval.contextDigest)}`);
  lines.push(`Next action: ${state.next?.seat ? `${scalar(state.next.seat)} / ` : ''}${scalar(state.nextAction)}${state.next?.reason ? ` — ${scalar(state.next.reason)}` : ''}`);
  if (state.reason) lines.push(`Status reason: ${scalar(state.reason)}`);
  if (state.snapshot?.completeness?.complete === false) {
    lines.push(`Context incomplete: ${(state.snapshot.completeness.reasons ?? []).map(screenText).join('; ') || 'reason not recorded'}`);
  }
  const entries = Array.isArray(state.snapshot?.entries) ? state.snapshot.entries : [];
  if (entries.length) {
    lines.push('', 'Context manifest:');
    for (const entry of entries) lines.push(`- ${scalar(entry.id)} / ${scalar(entry.kind)} / ${scalar(entry.status)} — ${scalar(entry.content ?? entry.reference)}`);
  }
  const recalled = Array.isArray(state.snapshot?.recalled) ? state.snapshot.recalled : [];
  if (recalled.length) {
    lines.push('', 'Recall manifest:');
    for (const item of recalled) lines.push(`- ${scalar(item.versionId ?? item.id)} / logical ${scalar(item.logicalId ?? item.entryId)} / ${scalar(item.status)} / attribution ${scalar(item.attribution ?? item.provenance?.seat)}`);
  }
  if (state.recall?.status === 'fallback') lines.push(`Recall warning: fallback — ${scalar(state.recall.detail ?? state.recall.reason)}`);

  if (state.messages.length) {
    lines.push('', 'Dialogue history:');
    for (const message of state.messages) {
      lines.push(`- ${scalar(message.sender ?? message.speaker ?? message.provider)} / ${scalar(message.action ?? message.role)}${message.historical ? ' / historical' : ''}`);
      lines.push(`  ${messageContent(message) || '(empty message)'}`);
      if (message.delivery) lines.push(`  Delivery: ${scalar(message.delivery.status ?? message.delivery)}`);
      const refs = message.evidenceIds ?? message.evidence;
      if (Array.isArray(refs) && refs.length) lines.push(`  Evidence refs: ${refs.map(ref => scalar(typeof ref === 'string' ? ref : ref.id)).join(', ')}`);
      for (const claim of message.claims ?? []) {
        lines.push(`  Claim ${scalar(claim.id)} [${scalar(claim.kind)}]: ${scalar(claim.text)}; evidence: ${(claim.evidenceIds ?? []).map(scalar).join(', ') || 'missing / unknown'}`);
      }
      for (const verification of message.verifications ?? []) {
        lines.push(`  Assessment: ${scalar(verification.result)} for ${scalar(verification.claimId)}; evidence ${verification.evidenceIds?.map(scalar).join(', ') || 'missing / unknown'}; inspection receipts ${verification.inspectionReceiptIds?.map(scalar).join(', ') || 'none'}; ${scalar(verification.reason)}`);
      }
    }
  }

  if (state.evidence.length) {
    lines.push('', 'Evidence:');
    for (const evidence of state.evidence) {
      const locator = locatorText(evidence.locator);
      const href = safeExternalHref(evidence.locator);
      const displayedLocator = href ? `[${locator}](${href})` : `\`${locator.replaceAll('`', '\\`')}\``;
      lines.push(`- ${scalar(evidence.id)} / ${scalar(evidence.kind)} / ${evidenceState(evidence)} — ${displayedLocator}${evidence.sourceDigest ? ` @ ${scalar(evidence.sourceDigest)}` : ''}`);
    }
  }
  if (state.claims.length) {
    lines.push('', 'Claims:');
    for (const claim of state.claims) lines.push(`- ${scalar(claim.id)} [${scalar(claim.kind)} / ${scalar(claim.status)}]: ${scalar(claim.text)}; evidence: ${(claim.evidenceIds ?? []).map(scalar).join(', ') || 'missing / unknown'}`);
  }
  if (state.verifications.length) {
    lines.push('', 'Assessments:');
    for (const verification of state.verifications) lines.push(`- Assessment: ${scalar(verification.result)} for ${scalar(verification.claimId)} by ${scalar(verification.seat)}; evidence ${verification.evidenceIds?.map(scalar).join(', ') || 'missing / unknown'}; inspection receipts ${verification.inspectionReceiptIds?.map(scalar).join(', ') || 'none'}; ${scalar(verification.reason)}`);
  }
  if (state.inspectionReceipts.length) {
    lines.push('', 'Inspection receipts:');
    for (const receipt of state.inspectionReceipts) lines.push(`- Inspection receipt ${scalar(receipt.id)}: ${scalar(receipt.seat)} / evidence ${(receipt.evidenceIds ?? [receipt.evidenceId]).filter(Boolean).map(scalar).join(', ') || 'missing / unknown'} / ${receipt.observed === true ? 'observed' : receipt.observed === false ? 'not observed' : 'observation not recorded'} / ${scalar(receipt.result)}`);
  }
  if (state.issues.length) {
    lines.push('', 'Issues and dispositions:');
    for (const issue of state.issues) lines.push(`- ${scalar(issue.id)} [${scalar(issue.status)}${issue.blocking ? ', blocking' : ''}] ${scalar(issue.title)}`);
    for (const disposition of state.dispositions) lines.push(`- ${scalar(disposition.issueId)}: ${scalar(disposition.kind ?? disposition.disposition ?? disposition.status)} by ${scalar(disposition.by ?? disposition.decidedBy)} — ${scalar(disposition.reason)}; claims ${(disposition.claimIds ?? []).map(scalar).join(', ') || 'none'}`);
  }
  if (state.pendingDecision) lines.push(`Human decision pending: ${scalar(state.pendingDecision.reason ?? state.pendingDecision.question)}`);
  if (state.technicalPause) lines.push(`Technical pause: ${scalar(state.technicalPause.reason ?? state.reason)}; empty human-question list is intentional.`);

  const resourceLines = [
    resourceLine('Cumulative run resources', state.resources),
    resourceLine('Current phase delta', state.phaseResources),
  ].filter(Boolean);
  if (state.phaseChain.length) {
    resourceLines.push('Per-phase history:');
    for (const phase of state.phaseChain) resourceLines.push(`- ${scalar(phase.phase)} / ${scalar(phase.runId)} / ${scalar(phase.action)}; ${resourceLine('phase delta', phase.resources) ?? 'resources not recorded'}`);
  }
  const queueLine = resourceLine('Queue cumulative', state.queueResources);
  if (queueLine) resourceLines.push(queueLine);
  if (resourceLines.length) lines.push('', 'Resources:', ...resourceLines);
  return lines.join('\n');
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function safeExternalHref(locator) {
  const raw = typeof locator === 'string' ? locator : locator?.url;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    return screenText(parsed.href) === parsed.href ? parsed.href : null;
  } catch { return null; }
}

export function renderDialogueHtml(input) {
  const state = normalizeDialogueProjection(input);
  const links = state.evidence.map(evidence => {
    const href = safeExternalHref(evidence.locator);
    const label = `${scalar(evidence.id)}: ${locatorText(evidence.locator)}`;
    return href ? `<li><a href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(label)}</a></li>`
      : `<li><code>${escapeHtml(label)}</code></li>`;
  }).join('');
  return `<section class="dialogue-report"><pre>${escapeHtml(renderDialogueReport(state))}</pre>`
    + (links ? `<ul class="dialogue-sources">${links}</ul>` : '') + '</section>';
}
