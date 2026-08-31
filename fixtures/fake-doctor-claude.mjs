import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.URO_FAKE_DOCTOR_INVOCATIONS) {
  appendFileSync(process.env.URO_FAKE_DOCTOR_INVOCATIONS,
    `${JSON.stringify({ cli: 'claude', args })}\n`);
}

if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.URO_FAKE_CLAUDE_SIGNED_IN === 'no') {
    process.stderr.write('Not logged in\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('Logged in\n');
  }
} else {
  process.stderr.write(`unexpected fake Claude arguments: ${args.join(' ')}\n`);
  process.exitCode = 2;
}
