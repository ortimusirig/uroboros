import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { spawnCapture } from './spawn.js';
import { reportEvent } from './events.js';
import { annotateUsageConsistency, normalizeCursorUsage } from './usage.js';
import { resolveStageTimeouts } from './timeouts.js';
import {
  inspectSuperpowersDirectory,
  resolveSuperpowersDir,
} from './superpowers.js';
import { inspectWorktreeActivity } from './liveness-evidence.js';
import {
  createProgressWatchdog,
  resolveExecutorThresholds,
} from './stall-watchdog.js';

export const DEFAULT_VERIFIER_MODEL = 'cursor-grok-4.5-high';

// Caps on retained review evidence. Candidate text is bounded before the verdict
// rules see it, so the exact judged strings can always be retained in run facts.
export const FINDINGS_LIMIT = 4000;
export const PLAN_LIMIT = 8000;

const FORBIDDEN = ['--force', '--yolo', '-f', '--approve-mcps'];

export const VERIFIER_PLUGIN_DIR = fileURLToPath(new URL('../cursor-plugin', import.meta.url));

export function assertNoForbiddenFlags(args) {
  for (const f of FORBIDDEN) {
    if (args.includes(f)) throw new Error(`forbidden verifier flag: ${f}`);
  }
}

export const DEFAULT_PROMPT = '/uro-verify Read CHANGES.diff and judge the change for correctness and blocking bugs; make the final line exactly NO_BLOCKERS or exactly ISSUES.';
export const INTENT_PROMPT = '/uro-verify Read TASK.md and CHANGES.diff and judge whether the diff fully implements every TASK.md requirement and whether new or changed assertions detect broken behavior; make the final line exactly NO_BLOCKERS or exactly ISSUES.';

export function assertUsablePrompt(prompt) {
  if (prompt.includes('"')) throw new Error('verifier prompt must not contain a double quote');
  if (/[\r\n]/.test(prompt)) throw new Error('verifier prompt must be a single line');
  if (prompt.trim() === '') throw new Error('verifier prompt must not be empty');
}

export function buildCursorArgs({
  model = DEFAULT_VERIFIER_MODEL,
  prompt = DEFAULT_PROMPT,
  env = process.env,
  home = homedir(),
  superpowersDir,
} = {}) {
  assertUsablePrompt(prompt);
  const resolvedSuperpowersDir = superpowersDir === undefined
    ? resolveSuperpowersDir({ seat: 'cursor', env, home })
    : superpowersDir;
  if (resolvedSuperpowersDir !== null) {
    const inspected = inspectSuperpowersDirectory({
      path: resolvedSuperpowersDir,
      seat: 'cursor',
    });
    if (!inspected.ok) {
      throw new Error(`Cursor superpowers plugin directory is unusable: ${inspected.reason}`);
    }
  }
  // --trust clears Cursor's "Workspace Trust Required" gate for READING the checkout; without
  // it the agent exits 1 with no output and every review is UNVERIFIED. It is
  // NOT one of the forbidden flags (--force/--yolo/-f/--approve-mcps auto-APPROVE actions);
  // --mode plan keeps the agent read-only regardless. Verified live (exit 0, NO_BLOCKERS).
  const args = [
    '-p', prompt, '--output-format', 'stream-json', '--mode', 'plan', '--trust',
    '--plugin-dir', VERIFIER_PLUGIN_DIR,
    ...(resolvedSuperpowersDir === null
      ? []
      : ['--plugin-dir', resolvedSuperpowersDir]),
    '--model', model,
  ];
  assertNoForbiddenFlags(args);
  return args;
}

export function extractPlanArtifact(streamText) {
  let artifact = null;
  for (const line of streamText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let event;
    try { event = JSON.parse(s); } catch { continue; }
    if (event.type !== 'tool_call') continue;
    const args = event.tool_call?.createPlanToolCall?.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    artifact = {
      name: typeof args.name === 'string' ? args.name : '',
      overview: typeof args.overview === 'string' ? args.overview : '',
      plan: typeof args.plan === 'string' ? args.plan : '',
    };
  }
  return artifact;
}

// The prompt asks the verifier to "briefly list the problems", so an ISSUES verdict
// carries reasoning worth keeping. parseVerdict answers only "may I treat this as
// clean?"; this returns that answer AND the text it was derived from.
function stripLeadingVerdictNoise(line) {
  let candidate = line.trimStart();
  let previous;
  do {
    previous = candidate;
    candidate = candidate
      .replace(/^#{1,6}\s*/, '')
      .replace(/^(?:[-+*]|\d+[.)]|•)\s+/, '')
      .replace(/^[*_`]+\s*/, '')
      .replace(/^(?:final\s+)?verdict\s*:\s*/i, '')
      .trimStart();
  } while (candidate !== previous);
  return candidate;
}

function finalLineVerdict(text) {
  const finalLine = text.split(/\r?\n/).findLast((line) => line.trim() !== '');
  if (finalLine === undefined) return null;

  let candidate = stripLeadingVerdictNoise(finalLine).trimEnd();
  let previous;
  do {
    previous = candidate;
    candidate = candidate
      .replace(/(?:[*_`]+|[.,!?;:…]+|#+)\s*$/, '')
      .trimEnd();
  } while (candidate !== previous);

  if (candidate === 'ISSUES') return 'ISSUES';
  if (candidate === 'NO_BLOCKERS') return 'NO_BLOCKERS';
  return null;
}

function planVerdict(text) {
  const verdicts = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(NO_BLOCKERS|ISSUES)(?:[*`]+)?(?=$|[\s,.!?;:…—])/
      .exec(stripLeadingVerdictNoise(line));
    if (match) verdicts.add(match[1]);
  }
  if (verdicts.has('ISSUES')) return 'ISSUES';
  if (verdicts.has('NO_BLOCKERS')) return 'NO_BLOCKERS';
  return null;
}

function composePlanArtifact(artifact) {
  if (!artifact) return '';
  const parts = [];
  if (artifact.name.trim()) parts.push(`# ${artifact.name.trim()}`);
  if (artifact.overview.trim()) parts.push(artifact.overview.trim());
  if (artifact.plan.trim()) parts.push(artifact.plan.trim());
  return parts.join('\n\n');
}

function retainVerdictText(text, limit) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= limit) return { text: value, truncated: false };
  // Both final-line rules depend on the end of the response. Retain the tail so
  // bounding evidence does not normally discard the requested final verdict.
  return { text: value.slice(-limit), truncated: true };
}

function collectVerdictEvidence(streamText) {
  let resultText = '';
  let resultSeen = false;
  let resultUsable = false;
  let lastAssistant = '';
  let assistantSeen = false;
  for (const line of streamText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let item;
    try { item = JSON.parse(s); } catch { continue; }
    if (item.type === 'assistant' && item.message && Array.isArray(item.message.content)) {
      for (const part of item.message.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          assistantSeen = true;
          lastAssistant = part.text;
        }
      }
    } else if (item.type === 'result') {
      resultSeen = true;
      resultUsable = !item.is_error && typeof item.result === 'string';
      resultText = resultUsable ? item.result : '';
    }
  }

  const artifact = extractPlanArtifact(streamText);
  // Deliberate choice: keep the existing useful name + overview + plan artifact,
  // but compose and bound it exactly once and judge that same retained string.
  // This makes every displayed plan byte-identical to the plan verdict input.
  const result = retainVerdictText(resultText, FINDINGS_LIMIT);
  const assistant = retainVerdictText(lastAssistant, FINDINGS_LIMIT);
  const plan = retainVerdictText(composePlanArtifact(artifact), PLAN_LIMIT);
  return {
    version: 1,
    candidates: {
      result: { present: resultSeen, usable: resultUsable, ...result },
      assistant: {
        present: assistantSeen,
        eligible: !resultSeen || resultUsable,
        ...assistant,
      },
      plan: { present: artifact !== null, ...plan },
    },
    inputTruncated: result.truncated || assistant.truncated || plan.truncated,
  };
}

// Re-run source precedence over retained evidence without consulting a vendor
// stream. This is intentionally the same unchanged finalLineVerdict/planVerdict
// decision path used by parseVerdictDetail.
export function deriveVerdictFromEvidence(evidence) {
  const candidates = evidence?.candidates ?? {};
  const result = candidates.result ?? {};
  const assistant = candidates.assistant ?? {};
  const plan = candidates.plan ?? {};

  const resultVerdict = result.present && result.usable
    ? finalLineVerdict(result.text ?? '')
    : null;
  if (resultVerdict) {
    return { verdict: resultVerdict, source: 'result',
      judgedText: result.text ?? '', judgedTextTruncated: result.truncated === true };
  }

  const assistantEligible = !result.present || result.usable;
  const assistantVerdict = assistantEligible
    ? finalLineVerdict(assistant.text ?? '')
    : null;
  if (assistantVerdict) {
    return { verdict: assistantVerdict, source: 'assistant',
      judgedText: assistant.text ?? '', judgedTextTruncated: assistant.truncated === true };
  }

  const artifactVerdict = planVerdict(plan.text ?? '');
  if (artifactVerdict) {
    return { verdict: artifactVerdict, source: 'plan',
      judgedText: plan.text ?? '', judgedTextTruncated: plan.truncated === true };
  }
  if (evidence?.termination) {
    return { verdict: 'UNVERIFIED', source: 'none',
      judgedText: plan.text ?? '', judgedTextTruncated: plan.truncated === true };
  }
  const hasSubstantiveEvidence = [result.text, assistant.text, plan.text]
    .some((text) => typeof text === 'string' && text.trim() !== '');
  // With no winning marker, the plan candidate is the final text examined before
  // the fail-safe verdict. Retain it as the judged text for source=none. An empty
  // evidence set means the review produced nothing readable, not that it found an issue.
  return { verdict: hasSubstantiveEvidence ? 'ISSUES' : 'UNVERIFIED', source: 'none',
    judgedText: plan.text ?? '', judgedTextTruncated: plan.truncated === true };
}

export function checkVerdictConsistency(verdict, verdictSource, evidence) {
  if (!evidence) return null;
  const derived = deriveVerdictFromEvidence(evidence);
  const verdictMatches = derived.verdict === verdict;
  const sourceMatches = verdictSource === undefined || verdictSource === null
    || derived.source === verdictSource;
  const retainedSourceMatches = evidence.source === undefined || evidence.source === derived.source;
  const retainedTextMatches = evidence.judgedText === undefined
    || evidence.judgedText === derived.judgedText;
  const retainedTruncationMatches = evidence.judgedTextTruncated === undefined
    || evidence.judgedTextTruncated === derived.judgedTextTruncated;
  const status = verdictMatches && sourceMatches && retainedSourceMatches
    && retainedTextMatches && retainedTruncationMatches
    ? 'consistent'
    : 'disagreement';
  return {
    status,
    recordedVerdict: verdict,
    recordedSource: verdictSource ?? null,
    rederivedVerdict: derived.verdict,
    rederivedSource: derived.source,
    retainedSourceMatches,
    retainedTextMatches,
    retainedTruncationMatches,
    inputTruncated: evidence.inputTruncated === true,
    ...(status === 'disagreement'
      ? { message: 'Recorded verifier decision does not match retained verdict evidence.' }
      : {}),
  };
}

export function annotateVerifierConsistency(result) {
  if (!result?.verdictEvidence) return result;
  return {
    ...result,
    verdictConsistency: checkVerdictConsistency(
      result.verdict,
      result.verdictSource,
      result.verdictEvidence,
    ),
  };
}

export function parseVerdictDetail(streamText) {
  const baseEvidence = collectVerdictEvidence(streamText);
  const derived = deriveVerdictFromEvidence(baseEvidence);
  const evidence = {
    ...baseEvidence,
    source: derived.source,
    judgedText: derived.judgedText,
    judgedTextTruncated: derived.judgedTextTruncated,
  };
  const { result, assistant, plan } = evidence.candidates;
  // Preserve the legacy findings selection independently of the explicit judged
  // text. For plan verdicts, findings remain the result/assistant preamble.
  const text = derived.source === 'result'
    ? result.text
    : derived.source === 'assistant'
      ? assistant.text
      : result.present ? result.text : assistant.text;
  return {
    verdict: derived.verdict,
    text,
    source: derived.source,
    planText: plan.text,
    evidence,
  };
}

export function parseVerdict(streamText) {
  return parseVerdictDetail(streamText).verdict;
}

export function hasVerdictEvidence(streamText) {
  for (const line of streamText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let item;
    try { item = JSON.parse(s); } catch { continue; }
    if (item.type === 'result' || item.type === 'assistant') return true;
  }
  return false;
}

function extractResultUsage(streamText) {
  let rawUsage;
  for (const line of streamText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let event;
    try { event = JSON.parse(s); } catch { continue; }
    if (event.type === 'result') rawUsage = event.usage;
  }
  return normalizeCursorUsage(rawUsage);
}

function createVerifierStreamObserver(onEvent) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  const observeLine = (line) => {
    const source = line.trim();
    if (source === '') return;
    try { onEvent(JSON.parse(source)); } catch { /* partial/non-JSON output is still liveness */ }
  };
  const consumeCompleteLines = () => {
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      observeLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
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

export async function runVerifier({
  cwd,
  bin = 'agent',
  prompt = DEFAULT_PROMPT,
  extraArgv = [],
  model = DEFAULT_VERIFIER_MODEL,
  timeoutMs,
  reporter,
  runId,
  pass,
  env = process.env,
  home = homedir(),
  superpowersDir,
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
}) {
  const resolvedTimeoutMs = timeoutMs === undefined
    ? resolveStageTimeouts(env).verifier
    : timeoutMs;
  const thresholds = resolveExecutorThresholds(env);
  const resolvedLivenessThresholdMs = livenessThresholdMs ?? thresholds.thresholdMs;
  const resolvedProgressThresholdMs = progressThresholdMs ?? thresholds.progressThresholdMs;
  const args = [...extraArgv, ...buildCursorArgs({
    prompt, model, env, home, superpowersDir,
  })];
  const launchEnv = { ...process.env, ...env };
  assertNoForbiddenFlags(args);
  const nowMs = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };
  const startedAt = nowMs();
  let lastByteAt = null;
  let lastAgentMessage = '';
  let lastObservedEvent = { runId, stage: 'verify', type: 'start', pass };
  const lastEvents = [{ ...lastObservedEvent, ts: new Date(startedAt).toISOString() }];
  const rememberEvent = (event) => {
    lastEvents.push({ ...event, ts: new Date(nowMs()).toISOString() });
    if (lastEvents.length > 10) lastEvents.shift();
  };
  const progress = typeof reporter === 'function'
    ? createProgressWatchdog({
      reporter, runId, stage: 'verify', pass, thresholdMs: resolvedProgressThresholdMs,
      now, setTimer, clearTimer,
    })
    : null;
  progress?.observe(lastObservedEvent);
  reportEvent(reporter, runId, 'verify', 'start', { bin, args, model, pass });
  const observer = createVerifierStreamObserver((event) => {
    lastObservedEvent = {
      runId,
      stage: 'verify',
      type: typeof event?.type === 'string' ? event.type : 'stream',
      pass,
      ...(typeof event?.subtype === 'string' ? { subtype: event.subtype } : {}),
    };
    rememberEvent(lastObservedEvent);
    if (event?.type === 'result' && typeof event.result === 'string') {
      lastAgentMessage = event.result;
    } else if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
      lastAgentMessage = event.message.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    }
    if (event?.type === 'item.completed') {
      progress?.observe({ ...lastObservedEvent, type: 'item_completed' });
    }
  });
  let r;
  try {
    r = await spawnCapture(bin, args, {
      cwd,
      env: launchEnv,
      timeoutMs: resolvedTimeoutMs,
      timeoutSetting: 'URO_VERIFIER_TIMEOUT_MS',
      signal,
      beforeKill,
      spawnProcess,
      killProcessTree,
      now,
      setTimer,
      clearTimer,
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
        },
        onDecision: onLivenessDecision,
        getLiveness: () => ({
          gapMs: nowMs() - (lastByteAt ?? startedAt),
          lastEvent: lastObservedEvent,
          lastEvents: [...lastEvents],
          lastAgentMessage,
          seat: 'verifier',
          pass,
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
  const detail = parseVerdictDetail(r.stdout);
  const evidenceWithTermination = r.timedOut
    ? { ...detail.evidence, termination: r.timeoutReason ?? { kind: 'deadline' } }
    : detail.evidence;
  const derived = deriveVerdictFromEvidence(evidenceWithTermination);
  const evidence = {
    ...evidenceWithTermination,
    source: derived.source,
    judgedText: derived.judgedText,
    judgedTextTruncated: derived.judgedTextTruncated,
  };
  const { text, planText } = detail;
  const { verdict, source } = derived;
  const exitCode = r.code;
  const launchFailed = r.timedOut || (exitCode !== 0 && !hasVerdictEvidence(r.stdout));
  const usage = extractResultUsage(r.stdout);
  // A verdict without its reasoning is not actionable: report the findings on the
  // path where the verifier actually ran, mirroring how stderr is kept when it did not.
  const unannotatedResult = launchFailed
    ? { verdict, exitCode, launchFailed, timedOut: r.timedOut, timeoutMs: r.timeoutMs,
        ...(r.timeoutReason ? { timeoutReason: r.timeoutReason } : {}),
        stderr: r.stderr.slice(0, 500), verdictSource: source,
        verdictEvidence: evidence, usage }
    : {
        verdict,
        exitCode,
        launchFailed,
        timedOut: r.timedOut,
        timeoutMs: r.timeoutMs,
        ...(r.timeoutReason ? { timeoutReason: r.timeoutReason } : {}),
        findings: text.trim().slice(0, FINDINGS_LIMIT),
        verdictSource: source,
        plan: evidence.candidates.plan.present ? planText : null,
        verdictEvidence: evidence,
        usage,
      };
  const result = annotateVerifierConsistency(annotateUsageConsistency(unannotatedResult));
  progress?.observe({ runId, stage: 'verify', type: 'finish', pass, code: exitCode });
  progress?.dispose();
  reportEvent(reporter, runId, 'verify', 'finish', {
    code: exitCode,
    verdict,
    source,
    tokens: usage,
    timedOut: r.timedOut,
    pass,
    verdictConsistency: result.verdictConsistency?.status ?? null,
    usageConsistency: result.usageConsistency.status,
  });
  return result;
}
