import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { commandExists, spawnCapture } from './spawn.js';
import { assertSafeScratchRoot } from './isolation.js';
import { resolveTask } from './task.js';
import {
  applySuperpowersRequirement,
  verifySuperpowersSeats,
} from './superpowers.js';

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const VERIFIER_PROBE_ARGS = Object.freeze(['--version']);

export async function probeVerifierLiveness({
  bin = 'agent',
  spawn = spawnCapture,
  timeoutMs = 10_000,
} = {}) {
  const args = [...VERIFIER_PROBE_ARGS];
  const tried = [bin, ...args].join(' ');
  let result;
  try {
    result = await spawn(bin, args, { timeoutMs });
  } catch (error) {
    return {
      ok: false,
      reason: `verifier liveness probe failed for ${bin}: tried "${tried}"; `
        + `could not launch: ${error?.message ?? String(error)}`,
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      reason: `verifier liveness probe failed for ${bin}: tried "${tried}"; `
        + `timed out after ${timeoutMs} ms`,
    };
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 500);
    return {
      ok: false,
      reason: `verifier liveness probe failed for ${bin}: tried "${tried}"; `
        + `exited ${result.code}${detail ? `: ${detail}` : ''}`,
    };
  }
  return { ok: true, reason: null };
}

export async function preflight({
  task,
  tasks,
  target,
  gate,
  scratchRoot,
  correctsRunId,
  bins = { git: 'git', codex: 'codex', agent: 'agent' },
  probeVerifier = probeVerifierLiveness,
  skipVerifierProbe = false,
  checkCommand = commandExists,
  verifySuperpowers = verifySuperpowersSeats,
  env = process.env,
  home = homedir(),
}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!existsSync(target)) return fail(`target does not exist: ${target}`);
  if (!existsSync(gate)) return fail(`gate config not found: ${gate}`);
  try { JSON.parse(readFileSync(gate, 'utf8')); } catch (e) { return fail(`gate config is not valid JSON: ${e.message}`); }
  const taskInputs = tasks ?? (task === undefined ? [] : [task]);
  for (const taskInput of taskInputs) {
    try { resolveTask(taskInput); } catch (e) { return fail(e.message); }
  }
  try { assertSafeScratchRoot(scratchRoot); } catch (e) { return fail(e.message); }
  if (correctsRunId !== undefined) {
    const root = resolve(scratchRoot);
    const runDirectory = resolve(root, correctsRunId);
    const isDirectChild = runDirectory !== root && dirname(runDirectory) === root;
    if (!isDirectChild
      || (!isDirectory(join(root, correctsRunId))
        && !isDirectory(join(root, correctsRunId, 'w')))) {
      return fail(`corrected run not found under scratch root: ${correctsRunId}`);
    }
  }
  for (const [name, bin] of Object.entries(bins)) {
    if (!(await checkCommand(bin))) return fail(`required binary not found: ${name} (${bin})`);
  }
  if (!skipVerifierProbe) {
    let probe;
    try {
      probe = await probeVerifier({ bin: bins.agent });
    } catch (error) {
      return fail(`verifier liveness probe failed for ${bins.agent}: tried `
        + `"${bins.agent} ${VERIFIER_PROBE_ARGS.join(' ')}"; `
        + `${error?.message ?? String(error)}`);
    }
    if (!probe?.ok) {
      return fail(probe?.reason ?? `verifier liveness probe failed for ${bins.agent}: tried `
        + `"${bins.agent} ${VERIFIER_PROBE_ARGS.join(' ')}"`);
    }
  }
  let verification;
  try {
    verification = await verifySuperpowers({ env, home, codexBin: bins.codex });
  } catch (error) {
    return fail(`superpowers preflight failed: ${error?.message ?? String(error)}`);
  }
  const requirement = applySuperpowersRequirement(verification, env);
  if (!requirement.ok) return fail(`superpowers preflight failed: ${requirement.reason}`);
  return {
    ok: true,
    reason: null,
    superpowers: {
      required: true,
      bypassed: requirement.bypassed,
      seats: requirement.verification.seats,
    },
  };
}
