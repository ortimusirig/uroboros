import { decodeRecordedText } from './execution-record.js';

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
  if (typeof locator === 'string') return screenText(locator);
  if (!locator || typeof locator !== 'object') return 'not recorded';
  const path = typeof locator.path === 'string' ? locator.path : locator.url;
  return `${scalar(path)}${Number.isSafeInteger(locator.line) ? `:${locator.line}` : ''}`;
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
  const snapshot = dialogue.snapshot ?? input.snapshot ?? null;
  const approval = input.approval ?? dialogue.approval ?? null;
  const next = input.next ?? dialogue.next ?? null;
  const issues = valuesOf(dialogue.issues);
  return {
    phase: input.phase ?? dialogue.phase ?? checkpoint.phase ?? null,
    authority: input.authority ?? dialogue.authority ?? null,
    interactionMode: input.interactionMode ?? dialogue.interactionMode ?? null,
    approved: input.approved ?? dialogue.approved ?? (approval ? true : null),
    approval,
    reason: input.reason ?? dialogue.reason ?? checkpoint.reason ?? null,
    next: next && typeof next === 'object' ? next : null,
    nextAction: input.nextAction ?? dialogue.nextAction ?? next?.action ?? checkpoint.action ?? null,
    snapshot,
    messages: Array.isArray(dialogue.messages) ? dialogue.messages : Array.isArray(input.messages) ? input.messages : [],
    evidence: Array.isArray(dialogue.evidence) ? dialogue.evidence : Array.isArray(input.evidence) ? input.evidence : [],
    claims: valuesOf(dialogue.claims),
    verifications: valuesOf(dialogue.verifications),
    issues,
    dispositions: [...valuesOf(dialogue.dispositions), ...issues.filter(issue => issue?.disposition)
      .map(issue => ({ issueId: issue.id, ...issue.disposition }))],
    inspectionReceipts: valuesOf(dialogue.inspectionReceipts).length
      ? valuesOf(dialogue.inspectionReceipts) : valuesOf(dialogue.receipts),
    resources: input.resources ?? checkpoint.resources ?? dialogue.resources ?? null,
    phaseResources: checkpoint.phaseResources ?? input.phaseResources ?? null,
    phaseChain: Array.isArray(checkpoint.phaseChain) ? checkpoint.phaseChain
      : Array.isArray(input.phaseChain) ? input.phaseChain : [],
    queueResources: input.queueResult?.resources ?? input.queueResources ?? null,
    pendingDecision: dialogue.pendingDecision ?? null,
    technicalPause: dialogue.technicalPause ?? checkpoint.technicalPause ?? null,
    recall: input.recall ?? checkpoint.recall ?? null,
  };
}

export function renderDialogueReport(input) {
  const state = normalizeDialogueProjection(input);
  const lines = [
    `Shared context: ${scalar(state.snapshot?.digest)}`,
    `Phase: ${scalar(state.phase)}; authority: ${scalar(state.authority)}; mode: ${scalar(state.interactionMode)}`,
    `Approved: ${state.approved === true ? 'yes' : state.approved === false ? 'no' : 'not recorded'}`,
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
  if (typeof raw !== 'string' || screenText(raw) !== raw) return null;
  try {
    const parsed = new URL(raw);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null;
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
