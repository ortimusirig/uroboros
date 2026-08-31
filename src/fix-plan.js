import { parseFindingJudgement } from './arbiter.js';
import { reportEvent } from './events.js';

export function validateFindings(findings, {
  arbiter,
  diff = '',
  plan = '',
  reporter,
  runId,
  debateRound,
} = {}) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return { accepted: [], rejected: [] };
  }

  const accepted = [];
  const rejected = [];

  const structurallyValid = findings.filter((finding) => (
    typeof finding?.description === 'string' && finding.description.trim() !== ''
  ));
  for (const finding of findings) {
    if (!structurallyValid.includes(finding)) rejected.push(finding?.id);
  }
  if (typeof arbiter !== 'function') {
    accepted.push(...structurallyValid.map((finding) => finding.id));
    return { accepted, rejected };
  }
  return (async () => {
    const judgements = [];
    for (const finding of structurallyValid) {
      let response;
      try {
        response = await arbiter({ type: 'finding', finding, diff, plan });
      } catch {
        response = null;
      }
      const judgement = parseFindingJudgement(response);
      judgements.push({ findingId: finding.id, ...judgement });
      if (judgement.verdict === 'invalid') {
        rejected.push(finding.id);
        reportEvent(reporter, runId, 'arbiter', 'overruled', {
          debateRound, findingId: finding.id, reason: judgement.reason,
        });
      } else {
        // Fail safe: an unavailable or unreadable arbiter preserves the objection.
        accepted.push(finding.id);
      }
    }
    return { accepted, rejected, judgements };
  })();
}

export function buildFixPlan({
  findings = [],
  accepted = [],
  rejected = [],
  originalTask = '',
} = {}) {
  if (!Array.isArray(accepted) || accepted.length === 0) return '';

  const acceptedIds = new Set(accepted);
  const rejectedIds = new Set(rejected);
  const acceptedFindings = findings.filter((finding) => acceptedIds.has(finding.id));
  const rejectedFindings = findings.filter((finding) => rejectedIds.has(finding.id));

  const lines = [
    '# Fix Plan',
    '',
    '## Original Task',
    '',
    String(originalTask),
    '',
    '## Validated Findings',
    '',
    ...acceptedFindings.map(
      (finding) => `- ${finding.id} (${finding.severity}): ${finding.description}`,
    ),
  ];

  if (rejectedFindings.length > 0) {
    lines.push(
      '',
      '## Rejected Findings',
      '',
      ...rejectedFindings.map(
        (finding) => `- ${finding.id} rejected (overruled): ${finding.description}`,
      ),
    );
  }

  const testFiles = acceptedFindings
    .map((finding) => finding.test)
    .filter((test) => typeof test === 'string' && test.trim() !== '');

  lines.push(
    '',
    "## Cursor's Tests",
    '',
    'Do NOT modify or delete files under __uro_review/.',
    '',
    ...(testFiles.length > 0
      ? testFiles.map((test) => `- ${test}`)
      : ['- No reviewer-supplied test files.']),
  );

  return `${lines.join('\n')}\n`;
}
