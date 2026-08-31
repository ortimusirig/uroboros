import { readEnv } from './env-compat.js';

export const DEFAULT_GATE_TIMEOUT_MS = 60 * 60 * 1000;

const MAX_TIMEOUT_MS = 2_147_483_647;

export function parseTimeoutMs(raw, name) {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`${name} must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return value;
}

function fromEnv(env, suffix, fallback) {
  const name = `URO_${suffix}`;
  const raw = readEnv(env, suffix);
  if (raw === undefined) return fallback;
  return parseTimeoutMs(raw, name);
}

function resolveStageTimeout(env, overrides, stage, suffix, fallback) {
  const option = `${stage}Timeout`;
  const explicit = overrides?.[option];
  if (explicit !== undefined) return parseTimeoutMs(explicit, `--${stage}-timeout`);
  return fromEnv(env, suffix, fallback);
}

export function resolveStageTimeouts(env = process.env, overrides = {}) {
  const verifier = resolveStageTimeout(
    env, overrides, 'verifier', 'VERIFIER_TIMEOUT_MS', undefined,
  );
  return {
    executor: resolveStageTimeout(
      env, overrides, 'executor', 'EXECUTOR_TIMEOUT_MS', undefined,
    ),
    verifier,
    arbiter: resolveStageTimeout(
      env, overrides, 'arbiter', 'ARBITER_TIMEOUT_MS', verifier,
    ),
    gate: resolveStageTimeout(env, overrides, 'gate', 'GATE_TIMEOUT_MS', DEFAULT_GATE_TIMEOUT_MS),
  };
}
