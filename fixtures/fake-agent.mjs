// argv[2] === 'clean' emits NO_BLOCKERS, anything else emits an ISSUES review.
// Emits the real cursor-agent --output-format stream-json shape: a nested
// assistant message (message.content is an array of {type:"text"} parts)
// followed by a final result event.
const mode = process.argv[2] ?? 'dirty';

// argv[2] === 'quota-death' reproduces the observed Cursor failure: one
// assistant chunk reaches stdout, then the CLI aborts on usage exhaustion and
// exits non-zero without ever emitting a result. Stream activity is present;
// a derivable verdict is not.
if (mode === 'quota-death') {
  process.stdout.write(`${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the remaining critical sections' }] },
  })}\n`);
  process.stderr.write("ActionRequiredError: Increase limits for faster responses You're out of usage.\n");
  process.exit(1);
}

// argv[2] === 'verdict-then-fail' is the narrowness control for the above: a
// seat that DID render a verdict and then exited non-zero must keep its
// verdict, because every marker check runs before termination is consulted.
if (mode === 'verdict-then-fail') {
  process.stdout.write(`${JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'There is a bug on line 4.\n\nISSUES',
  })}\n`);
  process.exit(1);
}

const verdict = mode === 'clean' ? 'NO_BLOCKERS' : 'ISSUES';
const review = mode === 'clean'
  ? `No blocking problems found.\n\n${verdict}`
  : `There is a bug on line 4.\n\n${verdict}`;
const plan = mode === 'long-plan'
  ? `${'x'.repeat(9000)}\n\nISSUES`
  : `Retained review details.\n\n${verdict}`;
process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: review }] } }) + '\n');
process.stdout.write(JSON.stringify({
  type: 'tool_call', subtype: 'completed',
  tool_call: { createPlanToolCall: { args: {
    name: 'Fake review plan', overview: 'Fake overview', plan,
  } } },
}) + '\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: review,
  usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 },
}) + '\n');
