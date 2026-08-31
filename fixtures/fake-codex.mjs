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
  // Emits newline-delimited JSON events shaped like the REAL `codex exec --json` stream.
  const events = [
    { type: 'thread.started' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'a.py', kind: 'add' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'b.py', kind: 'add' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'implemented the thing' } },
    { type: 'turn.completed' },
  ];
  for (const e of events) process.stdout.write(JSON.stringify(e) + '\n');
}
