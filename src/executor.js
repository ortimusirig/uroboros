import { spawnCapture } from './spawn.js';
import { reportEvent } from './events.js';
import { encodeRecordedText } from './execution-record.js';
import { annotateUsageConsistency, normalizeCodexUsage } from './usage.js';
import { resolveStageTimeouts } from './timeouts.js';
import { StringDecoder } from 'node:string_decoder';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEnv } from './env-compat.js';
import { inspectWorktreeActivity } from './liveness-evidence.js';
import {
  createProgressWatchdog,
  resolveExecutorThresholds,
} from './stall-watchdog.js';

export const DEFAULT_EXECUTOR_MODEL = 'gpt-5.6-sol';

export const DEFAULT_EXECUTOR_EFFORT = 'xhigh';
// Enough to carry a stack trace or an API error body; the failing path has no
// other record of the cause, so this is deliberately generous rather than a
// token-saving trim.
const EXECUTOR_STDERR_LIMIT = 4000;
export const EXECUTOR_PREAMBLE = `# Harness execution instructions

The plan below is approved. Implement it. Do not stop to request design approval, and do not wait for confirmation.

Producing no diff and no \`DECISION.md\` is a failed pass, not a success.

If a decision is genuinely required before proceeding, write \`DECISION.md\` in the working directory root using this block format, then stop:

## Q1
Kind: technical | product | authority
Question: <one line>
Options: <one line>
Recommendation: <one line>

\`Options:\` and \`Recommendation:\` are optional.

--- END HARNESS INSTRUCTIONS; BEGIN OPERATOR PLAN ---`;

// Sandbox mode is configurable because Codex's own Windows filesystem sandbox is not
// reliable everywhere. On this machine `workspace-write` fails every write with
//   helper_sid_resolve_failed: resolve SID for offline user CodexSandboxOffline failed
// so the executor produces no diff, the gate goes red on the first import, and the loop
// reports gate-failed forever. Reads and model replies still work, which makes the
// failure easy to misdiagnose: probe with a WRITE, not a greeting.
//
// The escape hatch is URO_CODEX_SANDBOX. Setting it to `danger-full-access` unblocks the
// executor, and the honest trade is worth stating plainly: it removes Codex's own
// confinement, so Codex is no longer restricted to the worktree. What still holds is the
// harness's isolation — a throwaway git worktree on a non-synced scratch disk, and a diff
// a human reads before anything merges. Codex's sandbox was a second belt on top of that,
// not the only one. Prefer fixing the SID resolution and leaving this unset.
const SANDBOX = readEnv(process.env, 'CODEX_SANDBOX') ?? 'workspace-write';

export function buildCodexArgs({
  cwd,
  model = DEFAULT_EXECUTOR_MODEL,
  effort = DEFAULT_EXECUTOR_EFFORT,
  sandbox = SANDBOX,
}) {
  // Codex discovers plugins from its own config under CODEX_HOME; it has no
  // --plugin-dir flag and exits 2 on one ("unexpected argument '--plugin-dir'").
  // That flag belongs to the Cursor CLI, and passing it here broke every run.
  // Superpowers reaches the executor through Codex's registry under CODEX_HOME.
  // There is deliberately no directory resolution or plugin argument in this seat.
  return [
    'exec', '--json',
    '-m', model,
    '-c', `model_reasoning_effort=${effort}`,
    '-c', 'mcp_servers={}',
    '-s', sandbox,
    '-C', cwd,
    '-',
  ];
}

export function parseCodexStream(streamText) {
  const seen = new Set();
  const changedFiles = [];
  const agentMessages = [];
  let lastMessage = '';
  // Null until a turn.completed line actually carries a usage field: nothing
  // was accounted yet, and that must never be reported as a fake zero.
  let usage = null;
  for (const line of streamText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.type === 'turn.completed' && Object.hasOwn(o, 'usage')) {
      usage = normalizeCodexUsage(o.usage);
      continue;
    }
    if (o.type !== 'item.completed' || !o.item) continue;
    const it = o.item;
    if (it.type === 'file_change' && Array.isArray(it.changes)) {
      for (const c of it.changes) {
        if (c && typeof c.path === 'string' && !seen.has(c.path)) { seen.add(c.path); changedFiles.push(c.path); }
      }
    } else if (it.type === 'agent_message' && typeof it.text === 'string') {
      agentMessages.push(it.text);
      lastMessage = it.text;
    }
  }
  return { changedFiles, lastMessage, agentMessages, usage };
}

function createIncrementalReporter({
  reporter, runId, attempt, onProgress, onAgentMessage,
}) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  const observeLine = (line) => {
    const source = line.trim();
    if (source === '') return;
    let event;
    try { event = JSON.parse(source); } catch { return; }
    if (event?.type !== 'item.completed' || !event.item) return;

    const item = event.item;
    let reported = false;
    const completed = (type, fields) => {
      reportEvent(reporter, runId, 'executor', type, fields);
      onProgress?.({ runId, stage: 'executor', type, ...fields });
    };
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      const seenFiles = new Set();
      for (const change of item.changes) {
        if (!change || typeof change.path !== 'string' || seenFiles.has(change.path)) continue;
        seenFiles.add(change.path);
        reported = true;
        completed('file_change', {
          file: change.path, attempt,
        });
      }
    }
    // Every completed item is observable activity. A file-change item already reports its
    // paths; all other items (and duplicate/empty file-change items) get one progress event.
    if (!reported) {
      const itemType = typeof item.type === 'string' ? item.type : 'unknown';
      const fields = { itemType, attempt };
      if (itemType === 'command_execution') {
        if (typeof item.command === 'string') fields.command = item.command;
        if (Number.isInteger(item.exit_code)) fields.exitCode = item.exit_code;
        const output = encodeRecordedText(item.aggregated_output);
        if (output.text !== '') {
          fields.output = output.text;
          fields.outputEncoding = output.encoding;
          if (output.truncated) fields.outputTruncated = true;
        }
      }
      if (itemType === 'error' && typeof item.message === 'string') {
        fields.errorMessage = item.message;
      }
      if (itemType === 'agent_message') {
        if (typeof item.text === 'string') onAgentMessage?.(item.text);
        const text = encodeRecordedText(item.text);
        if (text.text !== '') {
          fields.text = text.text;
          fields.textEncoding = text.encoding;
          if (text.truncated) fields.textTruncated = true;
        }
      }
      completed('item_completed', fields);
    }
  };

  const consumeCompleteLines = () => {
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      observeLine(line);
    }
  };

  return {
    onStdout(chunk) {
      pending += decoder.write(chunk);
      consumeCompleteLines();
    },
    finish() {
      pending += decoder.end();
      consumeCompleteLines();
      if (pending !== '') observeLine(pending);
      pending = '';
    },
  };
}

export async function runExecutor({
  plan,
  cwd,
  bin = 'codex',
  extraArgv = [],
  model = DEFAULT_EXECUTOR_MODEL,
  effort = DEFAULT_EXECUTOR_EFFORT,
  sandbox = SANDBOX,
  timeoutMs,
  reporter,
  runId,
  attempt,
  signal,
  beforeKill,
  onLiveness,
  livenessThresholdMs,
  progressThresholdMs,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  spawnProcess,
  killProcessTree,
  judgeLiveness,
  livenessJudgeTimeoutMs,
  getProcessTree,
  getWorktreeActivity,
  onLivenessDecision,
  env = process.env,
}) {
  const resolvedTimeoutMs = timeoutMs === undefined
    ? resolveStageTimeouts(env).executor
    : timeoutMs;
  const thresholds = resolveExecutorThresholds(env);
  const resolvedLivenessThresholdMs = livenessThresholdMs ?? thresholds.thresholdMs;
  const resolvedProgressThresholdMs = progressThresholdMs ?? thresholds.progressThresholdMs;
  const args = [...extraArgv, ...buildCodexArgs({ cwd, model, effort, sandbox })];
  const launchEnv = { ...process.env, ...env };
  // Codex's workspace-write sandbox confines writes to `cwd`. A tool the executor invokes
  // (observed in the field: pytest's default tmp under %TEMP%) otherwise writes outside that
  // root and every write fails with a sandbox ACL error. Give such tools a temp dir the
  // sandbox actually allows, and let it win over both the inherited process env and any
  // caller-supplied override above — those were never chosen with the sandbox root in mind.
  const executorTmp = join(cwd, '.uro-tmp');
  mkdirSync(executorTmp, { recursive: true });
  launchEnv.TMP = executorTmp;
  launchEnv.TEMP = executorTmp;
  launchEnv.TMPDIR = executorTmp;
  const nowMs = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };
  const startedAt = nowMs();
  let lastByteAt = null;
  let lastAgentMessage = '';
  let lastObservedEvent = {
    runId, stage: 'executor', type: 'start', bin, args, attempt,
  };
  const lastEvents = [{
    ...lastObservedEvent,
    ts: new Date(startedAt).toISOString(),
  }];
  const rememberEvent = (event) => {
    lastEvents.push({ ...event, ts: new Date(nowMs()).toISOString() });
    if (lastEvents.length > 10) lastEvents.shift();
  };
  const progress = typeof reporter === 'function'
    ? createProgressWatchdog({
      reporter, runId, thresholdMs: resolvedProgressThresholdMs, now, setTimer, clearTimer,
    })
    : null;
  progress?.observe(lastObservedEvent);
  reportEvent(reporter, runId, 'executor', 'start', { bin, args, attempt });
  // Every stdout byte proves liveness, while only a completed item proves progress.
  // Observation remains additive: spawnCapture still retains and returns every original byte.
  const observer = createIncrementalReporter({
    reporter,
    runId,
    attempt,
    onProgress: (event) => {
      lastObservedEvent = event;
      rememberEvent(event);
      progress?.observe(event);
    },
    onAgentMessage: (message) => { lastAgentMessage = message; },
  });
  let r;
  try {
    r = await spawnCapture(bin, args, {
      cwd,
      env: launchEnv,
      input: plan,
      timeoutMs: resolvedTimeoutMs,
      signal,
      beforeKill,
      timeoutSetting: 'URO_EXECUTOR_TIMEOUT_MS',
      now,
      setTimer,
      clearTimer,
      spawnProcess,
      killProcessTree,
      onStdout: (chunk) => {
        lastByteAt = nowMs();
        try { onLiveness?.(); } catch { /* observation cannot alter captured output */ }
        observer.onStdout(chunk);
      },
      livenessSupervision: {
        thresholdMs: resolvedLivenessThresholdMs,
        judge: judgeLiveness,
        ...(livenessJudgeTimeoutMs === undefined ? {} : {
          judgeTimeoutMs: livenessJudgeTimeoutMs,
        }),
        ...(getProcessTree === undefined ? {} : { getProcessTree }),
        getWorktreeActivity: getWorktreeActivity
          ?? (typeof judgeLiveness === 'function'
            ? (sinceMs) => inspectWorktreeActivity(cwd, sinceMs)
            : undefined),
        onEvent: (type, fields) => {
          reportEvent(reporter, runId, 'liveness', type, fields);
          if (type === 'working') {
            reportEvent(reporter, runId, 'executor', 'extended', {
              gapMs: fields.gapMs,
              extensionMs: fields.nextIntervalMs,
              nextIntervalMs: fields.nextIntervalMs,
              reasoning: fields.reasoning,
              lastEvent: fields.lastEvent,
              checkCount: fields.checkCount,
            });
          }
        },
        onDecision: onLivenessDecision,
        getLiveness: () => ({
          gapMs: nowMs() - (lastByteAt ?? startedAt),
          lastEvent: lastObservedEvent,
          lastEvents: [...lastEvents],
          lastAgentMessage,
          seat: 'executor',
        }),
        now,
        setTimer,
        clearTimer,
      },
    });
  } finally {
    if (!r) progress?.dispose();
  }
  observer.finish();
  const parsed = parseCodexStream(r.stdout);
  const result = annotateUsageConsistency({
    ...parsed,
    exitCode: r.code,
    timedOut: r.timedOut,
    // When the executor dies, its stderr is usually the only account of why.
    // Dropping it cost a queue unit a diagnosis: exit 1, no diff, no usage, and
    // nothing anywhere in the run facts saying what happened. Kept only on the
    // failing path, where stdout carries no explanation of its own.
    // Keep the TAIL, not the head. Codex logs every failing tool command to
    // stderr, so the head is exploratory noise — the first capture filled all
    // 4000 characters with a directory listing and truncated away the actual
    // cause. Whatever was written last is what the process died of.
    ...(r.code !== 0 && r.stderr?.trim() ? { stderr: r.stderr.slice(-EXECUTOR_STDERR_LIMIT) } : {}),
    ...(r.aborted ? { aborted: true } : {}),
    timeoutMs: r.timeoutMs,
    ...(r.timeoutReason ? { timeoutReason: r.timeoutReason } : {}),
  });
  progress?.observe({ runId, stage: 'executor', type: 'finish', code: r.code, attempt });
  progress?.dispose();
  reportEvent(reporter, runId, 'executor', 'finish', {
    code: r.code, ...(parsed.usage ? { tokens: parsed.usage } : {}), timedOut: r.timedOut, attempt,
    ...(r.timeoutReason ? { timeoutReason: r.timeoutReason } : {}),
    usageConsistency: result.usageConsistency.status,
  });
  return result;
}
