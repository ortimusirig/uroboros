// Local Claude review transport fixture. Never launches a paid CLI.
if (process.argv.includes('--version')) {
  process.stdout.write('fake-claude 1.0\n');
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const clean = process.argv[2] === 'clean';
  const report = clean ? 'Reviewed TASK.md and CHANGES.diff. No findings.'
    : '## F1\nSeverity: suggestion\nCategory: correctness\nDescription: There is a bug on line 4.\n';
  let terminal = JSON.stringify({ version: 1, conclusion: 'clean', report, tests: [] });
  const start = input.lastIndexOf('\n{\n  "artifactDigest":');
  if (start >= 0 && !process.argv.includes('legacy')) {
    const state = JSON.parse(input.slice(start + 1, input.indexOf('\n}', start) + 2));
    const grounding = input.indexOf('Shared grounding snapshot (content identity only; evidence still requires inspection):\n');
    const snapshotStart = input.indexOf('{', grounding);
    const snapshot = JSON.parse(input.slice(snapshotStart, input.indexOf('\n}', snapshotStart) + 2));
    const receipts = Object.values(state.inspectionReceipts).filter(r => r.seat === 'claude');
    const envelope = { schemaVersion: 1, action: receipts.length ? 'approve' : 'inspect', artifactDigest: state.artifactDigest,
      contextDigest: snapshot.digest, replyTo: null, content: 'Inspected the fixture implementation and saved requirement.', claims: [], issues: [], evidence: [], verifications: [], next: null };
    if (!receipts.length) {
      envelope.requests = [{ evidenceId: 'requirement-briefing' }, { path: 'a.py', line: 1, claimIds: ['native-output'] }];
      terminal = '';
    } else {
      const code = state.evidence.find(e => e.kind === 'code');
      envelope.claims = [{ id: 'briefing-requirement', kind: 'fact', text: 'The saved briefing is present.', evidenceIds: ['requirement-briefing'] },
        { id: 'native-output', kind: 'fact', text: 'a.py contains the fixture implementation.', evidenceIds: [code.id] }];
      envelope.verifications = envelope.claims.map(claim => ({ claimId: claim.id, evidenceIds: claim.evidenceIds,
        inspectionReceiptIds: receipts.filter(r => r.evidenceIds.includes(claim.evidenceIds[0])).map(r => r.id),
        result: 'supports', reason: 'Read the current captured source.' }));
    }
    terminal += `\n<UROBOROS_DIALOGUE>${JSON.stringify(envelope)}</UROBOROS_DIALOGUE>`;
  }
  process.stdout.write(JSON.stringify({ type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: report }] } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: terminal,
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  }) + '\n');
}
