export function validateFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return { accepted: [], rejected: [] };
  }

  const accepted = [];
  const rejected = [];

  for (const finding of findings) {
    const destination = typeof finding?.description === 'string'
      && finding.description.trim() !== ''
      ? accepted
      : rejected;
    destination.push(finding?.id);
  }

  return { accepted, rejected };
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
