import { spawnCapture } from './spawn.js';
import { reportEvent } from './events.js';
import { resolveStageTimeouts } from './timeouts.js';

export const GATE_TAIL_LIMIT = 4000;

const JAVASCRIPT_TEST_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);

function executableName(bin) {
  return String(bin).replaceAll('\\', '/').split('/').at(-1).toLowerCase()
    .replace(/[.](?:exe|cmd|bat)$/, '');
}

function testFamily(path) {
  const match = /([.][^.\\/]+)$/.exec(path.toLowerCase());
  if (match && JAVASCRIPT_TEST_EXTENSIONS.has(match[1])) return 'javascript';
  if (match?.[1] === '.py') return 'python';
  if (match?.[1] === '.rb') return 'ruby';
  if (match?.[1] === '.php') return 'php';
  return 'unsupported';
}

function supportsFamily(command, family) {
  const bin = executableName(command.bin);
  const args = Array.isArray(command.args) ? command.args.map(String) : [];
  if (family === 'javascript') {
    if (bin === 'node' && args.includes('--test')) return true;
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin)
      && args.some((arg) => arg === 'test' || arg === 'vitest' || arg === 'jest')) return true;
    return ['vitest', 'jest', 'mocha', 'ava'].includes(bin);
  }
  if (family === 'python') {
    if (['pytest', 'py.test'].includes(bin)) return true;
    return ['python', 'python3', 'py'].includes(bin)
      && args.some((arg, index) => arg === 'pytest' && args[index - 1] === '-m');
  }
  if (family === 'ruby') return bin === 'rspec'
    || (bin === 'bundle' && args.includes('rspec'));
  if (family === 'php') return ['phpunit'].includes(bin)
    || (bin === 'php' && args.some((arg) => /phpunit(?:[.]phar)?$/i.test(arg)));
  return false;
}

function reviewerArgs(command, files) {
  const args = [...command.args];
  const bin = executableName(command.bin);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin) && !args.includes('--')) args.push('--');
  return [...args, ...files];
}

export function buildReviewerTestCommands(commands, testFiles) {
  const uniqueFiles = [...new Set((testFiles ?? []).map(String))].sort();
  const groups = new Map();
  const unsupported = [];
  for (const testFile of uniqueFiles) {
    const family = testFamily(testFile);
    const commandIndex = commands.findIndex((command) => supportsFamily(command, family));
    if (commandIndex === -1) unsupported.push(testFile);
    else {
      const group = groups.get(commandIndex) ?? { files: [], family };
      group.files.push(testFile);
      groups.set(commandIndex, group);
    }
  }

  const reviewerCommands = [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([commandIndex, { files, family }]) => ({
      bin: commands[commandIndex].bin,
      args: reviewerArgs(commands[commandIndex], files),
      harness: 'uro-review-tests',
    }));
  if (unsupported.length > 0) {
    const message = `No operator gate command can run reviewer tests: ${unsupported.join(', ')}`;
    reviewerCommands.push({
      bin: process.execPath,
      args: ['-e', `process.stderr.write(${JSON.stringify(message)});process.exit(1)`],
      harness: 'uro-review-tests',
    });
  }
  return reviewerCommands;
}

export function parseTestCount(stdout, stderr = '') {
  const text = `${stdout}\n${stderr}`;
  const patterns = [
    /(?:^|\n)\s*(?:#|ℹ)\s*tests\s+(\d+)\s*(?:\r?$|\n)/gim,
    /(?:^|\n)\s*Tests:\s*[^\n]*?\b(\d+)\s+total\b/gim,
    /(?:^|\n)\s*Tests\s+(\d+)\s+(?:passed|failed)\b/gim,
    /(?:^|\n)[^\n]*?\b(\d+)\s+passed(?:,|\s|$)/gim,
    /(?:^|\n)\s*test result:.*?\b(\d+)\s+passed\b/gim,
  ];
  for (const pattern of patterns) {
    let last = null;
    for (const match of text.matchAll(pattern)) last = Number(match[1]);
    if (Number.isSafeInteger(last)) return last;
  }
  return null;
}

function outputTail(stdout, stderr) {
  const stdoutLabel = '[stdout]\n';
  const stderrLabel = '\n[stderr]\n';
  const contentLimit = GATE_TAIL_LIMIT - stdoutLabel.length - stderrLabel.length;
  let stdoutLimit = Math.min(stdout.length, Math.floor(contentLimit / 2));
  let stderrLimit = Math.min(stderr.length, Math.floor(contentLimit / 2));
  let remaining = contentLimit - stdoutLimit - stderrLimit;

  const extraStdout = Math.min(remaining, stdout.length - stdoutLimit);
  stdoutLimit += extraStdout;
  remaining -= extraStdout;
  stderrLimit += Math.min(remaining, stderr.length - stderrLimit);

  // `s.slice(-0)` is `s.slice(0)` — the WHOLE string, not the empty tail the arithmetic
  // intends. Unreachable while GATE_TAIL_LIMIT is 4000, but it would turn a shrunk limit
  // into an unbounded report, so take the tail through a guard rather than by luck.
  const tail = (s, n) => (n > 0 ? s.slice(-n) : '');
  return `${stdoutLabel}${tail(stdout, stdoutLimit)}${stderrLabel}${tail(stderr, stderrLimit)}`;
}

export async function runGate({
  commands,
  cwd,
  timeoutMs = resolveStageTimeouts().gate,
  reporter,
  runId,
  attempt,
  captureTestCount = commands.some((command) => command.harness === 'ccc-test-count-floor'),
}) {
  const results = [];
  let testCount = 0;
  let observedTestCount = false;
  reportEvent(reporter, runId, 'gate', 'start', { attempt });
  for (const cmd of commands) {
    let commandEnv;
    if (cmd.harness === 'ccc-test-count-floor') {
      commandEnv = { ...process.env };
      if (observedTestCount) commandEnv.URO_OBSERVED_TEST_COUNT = String(testCount);
      else delete commandEnv.URO_OBSERVED_TEST_COUNT;
    }
    const r = await spawnCapture(cmd.bin, cmd.args, {
      cwd,
      timeoutMs,
      ...(commandEnv === undefined ? {} : { env: commandEnv }),
    });
    if (captureTestCount && cmd.harness !== 'ccc-test-count-floor') {
      const observed = parseTestCount(r.stdout, r.stderr);
      if (observed !== null) {
        testCount += observed;
        observedTestCount = true;
      }
    }
    const result = {
      bin: cmd.bin,
      args: cmd.args,
      ...(cmd.harness === undefined ? {} : { harness: cmd.harness }),
      code: r.code,
    };
    reportEvent(reporter, runId, 'gate', 'gate_command', {
      ...result, timedOut: r.timedOut, attempt,
    });
    if (r.code !== 0) {
      results.push({
        ...result,
        ...(r.timedOut ? { timedOut: true, timeoutMs: r.timeoutMs } : {}),
        outputTail: outputTail(r.stdout, r.stderr),
      });
      reportEvent(reporter, runId, 'gate', 'finish', {
        verdict: 'failed', code: r.code, attempt,
      });
      return {
        passed: false,
        results,
        ...(observedTestCount ? { testCount } : {}),
      };
    }
    results.push(result);
  }
  reportEvent(reporter, runId, 'gate', 'finish', { verdict: 'passed', attempt });
  return {
    passed: true,
    results,
    ...(observedTestCount ? { testCount } : {}),
  };
}
