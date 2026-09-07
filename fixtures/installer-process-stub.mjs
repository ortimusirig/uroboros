// Run the real installer without recursively launching its full self-test.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.spawnSync = (bin, args) => {
  if (bin === process.execPath && args.length === 1 && args[0] === '--test') {
    return { status: 0, stdout: '# pass 1\n# fail 0\n', stderr: '' };
  }
  if (['where', 'which'].includes(bin) && args.length === 1) {
    return { status: ['git', 'codex', 'claude'].includes(args[0]) ? 0 : 1, stdout: '', stderr: '' };
  }
  throw new Error('Unexpected installer subprocess boundary');
};
syncBuiltinESMExports();
