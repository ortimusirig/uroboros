// Local Claude review transport fixture. Never launches a paid CLI.
if (process.argv.includes('--version')) {
  process.stdout.write('fake-claude 1.0\n');
} else {
  const clean = process.argv[2] === 'clean';
  const report = clean ? 'Reviewed TASK.md and CHANGES.diff. No findings.'
    : '## F1\nSeverity: suggestion\nCategory: correctness\nDescription: There is a bug on line 4.\n';
  process.stdout.write(JSON.stringify({ type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: report }] } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: JSON.stringify({ version: 1, report, tests: [] }),
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  }) + '\n');
}
