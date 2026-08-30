import { createEvent } from './events.js';
import { readEnv } from './env-compat.js';
import { parseTimeoutMs } from './timeouts.js';

export const DEFAULT_STALL_THRESHOLD_MS = 5 * 60 * 1000;
export const DEFAULT_PROGRESS_THRESHOLD_MS = 5 * 60 * 1000;
export const DEFAULT_STALL_POLICY = 'report';
export const DEFAULT_STALL_RESTARTS = 1;

const MAX_TIMER_MS = 2_147_483_647;
const POLICIES = new Set(['report', 'restart']);
const SUPERVISION_EVENT_TYPES = new Set(['stalled', 'extended']);

function integerFromEnv(env, suffix, fallback, minimum, maximum) {
  const name = `URO_${suffix}`;
  const raw = readEnv(env, suffix);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function resolveStallConfig(env = process.env) {
  const policy = readEnv(env, 'STALL_POLICY') ?? DEFAULT_STALL_POLICY;
  if (!POLICIES.has(policy)) {
    throw new Error('URO_STALL_POLICY must be either report or restart');
  }
  return {
    ...resolveExecutorThresholds(env),
    policy,
    restartLimit: integerFromEnv(env, 'STALL_RESTARTS',
      DEFAULT_STALL_RESTARTS, 0, 3),
  };
}

function timeoutFromEnv(env, suffix, fallback) {
  const name = `URO_${suffix}`;
  const raw = readEnv(env, suffix);
  return raw === undefined ? fallback : parseTimeoutMs(raw, name);
}

export function resolveExecutorThresholds(env = process.env) {
  return {
    thresholdMs: timeoutFromEnv(env, 'STALL_THRESHOLD_MS', DEFAULT_STALL_THRESHOLD_MS),
    progressThresholdMs: timeoutFromEnv(
      env, 'PROGRESS_THRESHOLD_MS', DEFAULT_PROGRESS_THRESHOLD_MS,
    ),
  };
}

function clockValue(now) {
  const value = now();
  return value instanceof Date ? value.getTime() : value;
}

export function createGapWatchdog({
  reporter,
  runId,
  thresholdMs,
  onStall,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof reporter !== 'function') {
    throw new TypeError('a reporter is required to create a gap watchdog');
  }
  if (!Number.isSafeInteger(thresholdMs) || thresholdMs < 1 || thresholdMs > MAX_TIMER_MS) {
    throw new TypeError('thresholdMs must be a positive safe timer integer');
  }

  const states = new Map();
  const stalls = [];
  let disposed = false;

  const deliver = (event) => {
    try {
      const result = reporter(event);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // A broken sink cannot disable supervision or decide the run outcome.
    }
  };

  const arm = (stage, state, delayMs = thresholdMs) => {
    const generation = ++state.generation;
    state.timer = setTimer(() => {
      if (disposed || states.get(stage) !== state || state.generation !== generation) return;
      const gapMs = Math.max(0, clockValue(now) - state.lastSeenAt);
      if (gapMs < thresholdMs) {
        arm(stage, state, thresholdMs - gapMs);
        return;
      }
      state.timer = null;
      const stalled = createEvent({
        runId,
        stage,
        type: 'stalled',
        fields: {
          gapMs,
          thresholdMs,
          lastEvent: state.lastEvent,
          setting: 'URO_STALL_THRESHOLD_MS',
        },
        now: () => new Date(clockValue(now)),
      });
      stalls.push(stalled);
      deliver(stalled);
      try {
        const result = onStall?.(stalled);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* supervision callbacks are contained */ }
    }, delayMs);
  };

  const observedReporter = (event) => {
    deliver(event);
    if (disposed || !event || event.runId !== runId
      || SUPERVISION_EVENT_TYPES.has(event.type)) return;
    const stage = event.stage;
    const previous = states.get(stage);
    if (previous && previous.timer !== null) clearTimer(previous.timer);
    if (event.type === 'finish') {
      states.delete(stage);
      return;
    }
    const state = previous ?? { timer: null, generation: 0, hasEvidence: false };
    state.lastEvent = event;
    state.lastSeenAt = clockValue(now);
    state.timer = null;
    states.set(stage, state);
    arm(stage, state);
  };

  return {
    reporter: observedReporter,
    stalls,
    touch(stage) {
      if (disposed) return;
      const state = states.get(stage);
      if (!state) return;
      if (state.timer !== null) clearTimer(state.timer);
      state.lastSeenAt = clockValue(now);
      state.hasEvidence = true;
      state.timer = null;
      arm(stage, state);
    },
    status(stage) {
      const state = states.get(stage);
      if (!state) return null;
      return {
        hasEvidence: state.hasEvidence,
        gapMs: Math.max(0, clockValue(now) - state.lastSeenAt),
        lastEvent: state.lastEvent,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of states.values()) {
        if (state.timer !== null) clearTimer(state.timer);
      }
      states.clear();
    },
  };
}

export function createProgressWatchdog({
  reporter,
  runId,
  thresholdMs,
  stage = 'executor',
  pass,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof reporter !== 'function') {
    throw new TypeError('a reporter is required to create a progress watchdog');
  }
  if (!Number.isSafeInteger(thresholdMs) || thresholdMs < 1 || thresholdMs > MAX_TIMER_MS) {
    throw new TypeError('thresholdMs must be a positive safe timer integer');
  }

  let state = null;
  let disposed = false;

  const deliver = (event) => {
    try {
      const result = reporter(event);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Progress reporting is informational and cannot affect execution.
    }
  };

  const arm = (delayMs = thresholdMs) => {
    const current = state;
    const generation = ++current.generation;
    current.timer = setTimer(() => {
      if (disposed || state !== current || current.generation !== generation) return;
      const gapMs = Math.max(0, clockValue(now) - current.lastProgressAt);
      if (gapMs < thresholdMs) {
        arm(thresholdMs - gapMs);
        return;
      }
      current.timer = null;
      deliver(createEvent({
        runId,
        stage,
        type: 'stalled',
        fields: {
          tier: 'progress',
          gapMs,
          thresholdMs,
          lastEvent: current.lastEvent,
          setting: 'URO_PROGRESS_THRESHOLD_MS',
          ...(pass === undefined ? {} : { pass }),
        },
        now: () => new Date(clockValue(now)),
      }));
    }, delayMs);
  };

  const reset = (event) => {
    if (state?.timer !== null && state?.timer !== undefined) clearTimer(state.timer);
    state = {
      timer: null,
      generation: (state?.generation ?? 0) + 1,
      lastProgressAt: clockValue(now),
      lastEvent: event,
    };
    arm();
  };

  return {
    observe(event) {
      if (disposed || !event || event.runId !== runId || event.stage !== stage) return;
      if (event.type === 'finish') {
        if (state?.timer !== null && state?.timer !== undefined) clearTimer(state.timer);
        state = null;
        return;
      }
      if (event.type === 'start' || event.type === 'file_change'
        || event.type === 'item_completed') reset(event);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (state?.timer !== null && state?.timer !== undefined) clearTimer(state.timer);
      state = null;
    },
  };
}
