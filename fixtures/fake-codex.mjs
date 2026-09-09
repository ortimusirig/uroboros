import { writeFileSync } from 'node:fs';

if (process.argv[2] === 'plugin' && process.argv[3] === 'list') {
  process.stdout.write('superpowers@openai-curated  installed, enabled  6.3.0  C:/fake/superpowers\n');
} else if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  process.stdout.write('Logged in using ChatGPT\n');
} else if (process.argv[2] === 'die-quietly') {
  // Reproduces the observed executor death: a little progress on stdout, then a
  // non-zero exit whose only account of the cause is on stderr. Codex logs every
  // failing tool command there too, so the real cause arrives LAST, behind more
  // noise than any capture limit will hold.
  process.stdout.write(`${JSON.stringify({ type: 'thread.started' })}\n`);
  for (let i = 0; i < 400; i += 1) {
    process.stderr.write(`ERROR codex_core::tools::router: noisy tool listing line ${i}\n`);
  }
  process.stderr.write('codex: upstream connection reset while streaming\n');
  process.exit(1);
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const start = input.lastIndexOf('\n{\n  "artifactDigest":');
  let terminal = 'implemented the thing';
  let native = false;
  let nativeWrites = false;
  if (start >= 0 && !process.argv.includes('legacy')) {
    native = true;
    const state = JSON.parse(input.slice(start + 1, input.indexOf('\n}', start) + 2));
    const header = [
      'Shared grounding snapshot delivery projection (original snapshot digest below; projected bytes differ; evidence still requires inspection):\n',
      'Shared grounding snapshot (content identity only; evidence still requires inspection):\n',
    ].find(value => input.includes(value));
    if (!header) throw new Error('missing supported shared grounding snapshot header');
    const grounding = input.indexOf(header);
    const snapshotStart = input.indexOf('{', grounding);
    const snapshot = JSON.parse(input.slice(snapshotStart, input.indexOf('\n}', snapshotStart) + 2));
    nativeWrites = ['propose', 'revise'].includes(state.next.action);
    if (nativeWrites) writeFileSync('a.py', '# actual native fixture write\n');
    terminal = `<UROBOROS_DIALOGUE>${JSON.stringify({ schemaVersion: 1, action: state.next.action,
      artifactDigest: state.artifactDigest, contextDigest: snapshot.digest, replyTo: null, content: 'Completed the requested fixture work.',
      claims: [], issues: [], evidence: [], verifications: [], next: null })}</UROBOROS_DIALOGUE>`;
  }
  // Emits newline-delimited JSON events shaped like the REAL `codex exec --json` stream.
  const events = [
    { type: 'thread.started' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'a.py', kind: 'add' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'b.py', kind: 'add' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: terminal } },
    { type: 'turn.completed', ...(native ? { usage: { input_tokens: 12, output_tokens: 4 } } : {}) },
  ];
  for (const e of events) {
    if (native && e.item?.type === 'file_change' && (!nativeWrites || e.item.id === 'i2')) continue;
    process.stdout.write(JSON.stringify(e) + '\n');
  }
}
