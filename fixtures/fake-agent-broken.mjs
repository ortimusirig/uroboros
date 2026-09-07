if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  process.stdout.write('✓ Logged in as test@example.com\n');
} else {
  process.stderr.write('fake Claude failed before producing a verifier stream\n');
  process.exitCode = 1;
}
