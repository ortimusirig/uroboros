import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { spawnCapture } from './spawn.js';
import { buildClaudeArgs, parseArbiterStream, runArbiter } from './arbiter.js';
import { materializeReviewBundle } from './review.js';
import { reportEvent } from './events.js';
import { addUsage, annotateUsageConsistency } from './usage.js';
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

export const DEFAULT_VERIFIER_MODEL = 'sonnet';

// Caps on retained review evidence. Candidate text is bounded before the verdict
// rules see it, so the exact judged strings can always be retained in run facts.
export const FINDINGS_LIMIT = 4000;
export const PLAN_LIMIT = 8000;

const FORBIDDEN = ['--force', '--yolo', '-f', '--approve-mcps'];

/**
 * Why a Cursor seat could not run, and what the caller can actually do about it.
 *
 * Two entirely different outages wear the same `ActionRequiredError` coat on the
 * wire, so the shared prefix must never be what decides — only the
 * DISCRIMINATING substring does. A CONFIG refusal is deterministic and
 * caller-fixable in one flag; a QUOTA exhaustion needs the account renewed and
 * no flag can buy it. Offering the wrong one of those two sends the caller down
 * a dead end, which is worse than saying nothing.
 *
 * Peer-observed verbatim texts, captured from real failures:
 *   "Named models unavailable Free plans can only use Auto"  -> config-refusal
 *   "You've hit your usage limit"                            -> quota-exhausted
 *   bare "ActionRequiredError"                               -> account-action
 *
 * Anything else returns null: an unrecognised crash is not diagnosed, and no
 * remedy is invented for it.
 *
 * This lives here rather than in the conversation engine because the knowledge
 * is cursor-agent's own error vocabulary — the same module that owns its argv
 * and its stream parsing — and because both the engine and `doctor` reach it
 * from here without a cycle (verifier.js imports nothing that reaches back).
 */
export function classifySeatOutage(message) {
  const text = String(message ?? '');
  if (/Named models unavailable|Free plans can only use Auto/i.test(text)) {
    return { kind: 'config-refusal', remedy: 'free Cursor plans accept only auto — rerun with --verifier-model auto' };
  }
  if (/usage limit|out of usage/i.test(text)) {
    return { kind: 'quota-exhausted', remedy: 'the Cursor account is out of usage — renew the plan or wait for the quota cycle' };
  }
  if (/ActionRequiredError/i.test(text)) {
    return { kind: 'account-action', remedy: 'the Cursor account needs attention — run loop doctor --deep' };
  }
  return null;
}

export const VERIFIER_PLUGIN_DIR = fileURLToPath(new URL('../cursor-plugin', import.meta.url));

export function assertNoForbiddenFlags(args) {
  for (const argument of args) {
    let option = argument;
    if (typeof argument === 'string' && argument.startsWith('--')) {
      [option] = argument.split('=', 1);
    } else if (typeof argument === 'string' && argument.startsWith('-f=')) {
      option = '-f';
    }
    if (FORBIDDEN.includes(option)) {
      throw new Error(`forbidden verifier flag: ${option}`);
    }
  }
}


export const DEFAULT_PROMPT = 'Read CHANGES.diff and judge the change for correctness and blocking bugs. Remain read-only. Explain your reasoning and make the final line exactly NO_BLOCKERS or exactly ISSUES.';
export const REVIEW_PROMPT = [
  '# Claude execution reviewer',
  'You are read-only. Read TASK.md, CHANGES.diff and the command evidence. Do not write files or run commands that modify the workspace.',
  'Review correctness and fulfillment of the original requirements. Codex implements and may rebut your findings. Answer its actual arguments; you are the execution reviewer and final execution authority in autonomous mode. Unresolved manual disputes belong to the human.',
  'Return one JSON artifact bundle: {"version":1,"report":"Markdown report","tests":[{"path":"tests/f1.test.js","content":"executable test source"}],"dispositions":[{"id":"F1","status":"resolved|withdrawn|upheld","reason":"answer to Codex and evidence"}]}. The harness writes the report and tests.',
  'For each finding use Markdown: ## F1, Severity: blocking|suggestion, Category: ..., Description: ..., Test: __uro_review/tests/f1.test.js, each on its own line. Blocking findings need a real executable test included in the bundle. A clean review still needs a substantive nonblank report.',
  'Explicitly dispose of EVERY previously open finding with reasons tied to the current diff and evidence. Omission does not close an issue. Keep IDs stable. Include any still-required prior test files. Do not change product intent to eliminate a finding.',
].join('\n\n');

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
  // Every assistant text part is retained, newline-joined — keeping only the
  // last part ate the head of multi-part reviews (the stance lived in an
  // early part; dogfood run 2). A consecutive exact-duplicate part is a
  // streamed resend of the same text, not new speech, and is not repeated.
  const assistantParts = [];
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
          if (assistantParts.at(-1) !== part.text) assistantParts.push(part.text);
        }
      }
    } else if (item.type === 'result') {
      resultSeen = true;
      resultUsable = !item.is_error && typeof item.result === 'string';
      resultText = resultUsable ? item.result : '';
    }
  }

  const lastAssistant = assistantParts.join('\n');
  const artifact = extractPlanArtifact(streamText);
  // Deliberate choice: keep the existing useful name + overview + plan artifact,
  // but compose and bound it exactly once and judge that same retained string.
  // This makes every displayed plan byte-identical to the plan verdict input.
  const composedPlan = composePlanArtifact(artifact);
  const result = retainVerdictText(resultText, FINDINGS_LIMIT);
  const assistant = retainVerdictText(lastAssistant, FINDINGS_LIMIT);
  const plan = retainVerdictText(composedPlan, PLAN_LIMIT);
  return {
    version: 1,
    // The verdict-consistency system judges the BOUNDED candidates above; the
    // raw strings exist for downstream parses (planning artifacts, seat
    // reviews) whose structured lines a slice would silently eat.
    raw: { result: resultText, assistant: lastAssistant, plan: composedPlan },
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

  if (evidence?.policy === 'claude-terminal') {
    const verdict = !evidence.termination && result.present && result.usable
      ? finalLineVerdict(result.text ?? '') : null;
    return { verdict: verdict ?? 'UNVERIFIED', source: verdict ? 'result' : 'none',
      judgedText: result.text ?? '', judgedTextTruncated: result.truncated === true };
  }

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
  // text — but from the RAW stream, never the bounded evidence copies: the
  // callers of text/planText parse structured lines (AGREE, S/Q items,
  // PLAN_MD/GATE_JSON tags) anywhere in the response, and a slice silently ate
  // them past the cap. The bounded candidates above stay the verdict input.
  const raw = baseEvidence.raw ?? { result: result.text, assistant: assistant.text, plan: plan.text };
  const text = derived.source === 'result'
    ? raw.result
    : derived.source === 'assistant'
      ? raw.assistant
      : result.present ? raw.result : raw.assistant;
  return {
    verdict: derived.verdict,
    text,
    source: derived.source,
    planText: raw.plan,
    evidence,
  };
}

export function parseVerdict(streamText) {
  return parseVerdictDetail(streamText).verdict;
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

export async function runReviewPass(options) {
  const { cwd, round = 1, diffDigest = '', prompt = REVIEW_PROMPT,
    extraArgv = [], env = process.env, timeoutMs = resolveStageTimeouts(env).verifier } = options;
  assertNoForbiddenFlags(extraArgv);
  if (extraArgv.length) throw new Error('Claude review does not accept extra command flags');
  const result = await runArbiter({ ...options, prompt, timeoutMs, stage: 'verify',
    role: 'execution-reviewer',
    onStdout: () => { try { options.onLiveness?.(); } catch {} },
  });
  if (result.launchFailed || !result.resultSeen || !result.resultUsable || !result.answer.trim()) {
    return { ...result, artifact: null, artifactFailed: true };
  }
  try {
    const artifact = await materializeReviewBundle({ cwd, bundle: result.answer, round, diffDigest });
    return { ...result, artifact, artifactFailed: false };
  } catch (error) {
    return { ...result, artifact: null, artifactFailed: true,
      error: error instanceof Error ? error.message : String(error) };
  }
}

// One declared retry absorbs a transient launch refusal — the seat process
// dying before it produced anything judgeable (a rate-limit blip, a spawn
// hiccup). A timeout is spent time and is never retried, and one is the whole
// bound: it lives in the determinism-and-caps audit table. The retry
// re-LAUNCHES; nothing about any answer is reinterpreted. The event carries
// the first attempt's stderr so the cause ("You've hit your usage limit")
// reaches the operator instead of dying unread — dogfood runs 4 and 6 showed
// a bare "failed to launch" while the explanation sat in stderr.
export async function runVerifier(options) {
  const first = await runVerifierAttempt(options);
  if (!first.launchFailed || first.timedOut) return first;
  reportEvent(options.reporter, options.runId, 'verify', 'retry', {
    pass: options.pass,
    reason: String(first.stderr ?? '').trim() || 'launch failed with no stderr',
  });
  const second = await runVerifierAttempt(options);
  return annotateUsageConsistency({ ...second, attempts: [first, second],
    usage: first.usage == null && second.usage == null ? null : addUsage(first.usage, second.usage) });
}

async function runVerifierAttempt({
  cwd,
  bin = 'claude',
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
  assertNoForbiddenFlags(extraArgv);
  if (extraArgv.length) throw new Error('Claude verification does not accept extra command flags');
  const args = buildClaudeArgs({ prompt, model });
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
      input: prompt,
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
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    r = { code: null, stdout: '', stderr: diagnostic, error: diagnostic,
      timedOut: false, timeoutMs: resolvedTimeoutMs };
  } finally {
    if (!r) progress?.dispose();
  }
  observer.finish();
  const detail = parseVerdictDetail(r.stdout);
  const parsedClaude = parseArbiterStream(r.stdout);
  // Keep termination in the raw verdict evidence. The completed Claude result
  // check below overrides even a clean marker when the transport failed.
  const terminationReason = r.timedOut
    ? (r.timeoutReason ?? { kind: 'deadline' })
    : (r.code !== 0 ? { kind: 'exit', code: r.code } : null);
  const evidenceWithTermination = { ...detail.evidence, policy: 'claude-terminal',
    candidates: { ...detail.evidence.candidates, result: {
      ...detail.evidence.candidates.result, usable: parsedClaude.resultUsable,
      ...retainVerdictText(parsedClaude.answer, FINDINGS_LIMIT),
    } },
    ...(terminationReason ? { termination: terminationReason } : {}),
  };
  const derived = deriveVerdictFromEvidence(evidenceWithTermination);
  const evidence = {
    ...evidenceWithTermination,
    source: derived.source,
    judgedText: derived.judgedText,
    judgedTextTruncated: derived.judgedTextTruncated,
  };
  const { planText } = detail;
  const { verdict, source } = derived;
  const exitCode = r.code;
  // A seat that started talking and then died is not a seat that reviewed. This
  // once tested only for stream activity, so a single assistant chunk emitted
  // before the CLI aborted (quota exhaustion, killed process) made it false and
  // discarded the stderr carrying the actual cause. Process failure is distinct
  // from a successfully completed call with an unusable conclusion.
  const launchFailed = r.timedOut || exitCode !== 0;
  const usage = parsedClaude.usage;
  // A verdict without its reasoning is not actionable: report the findings on the
  // path where the verifier actually ran, mirroring how stderr is kept when it did not.
  const unannotatedResult = launchFailed
    ? { verdict, exitCode, launchFailed, timedOut: r.timedOut, timeoutMs: r.timeoutMs,
        ...(r.timeoutReason ? { timeoutReason: r.timeoutReason } : {}),
        stderr: r.stderr, verdictSource: source,
        verdictEvidence: evidence, usage }
    : {
        verdict,
        exitCode,
        launchFailed,
        timedOut: r.timedOut,
        timeoutMs: r.timeoutMs,
        ...(r.timeoutReason ? { timeoutReason: r.timeoutReason } : {}),
        // The full text, never an excerpt: planning parses structured lines
        // (AGREE, S/Q items, artifact tags) from the END of this field, and a
        // head-slice silently ate everything after 4000 characters — the
        // judged input must be complete. Excerpting belongs at persistence
        // sites, none of which retain this field any more.
        findings: parsedClaude.answer.trim(),
        verdictSource: source,
        plan: evidence.candidates.plan.present ? planText : null,
        verdictEvidence: evidence,
        usage,
      };
  const result = annotateVerifierConsistency(annotateUsageConsistency(unannotatedResult));
  Object.assign(result, { provider: 'claude', role: 'execution-reviewer',
    stdout: r.stdout, stderr: r.stderr, answer: parsedClaude.answer,
    ...(r.error ? { error: r.error } : {}) });
  progress?.observe({ runId, stage: 'verify', type: 'finish', pass, code: exitCode });
  progress?.dispose();
  reportEvent(reporter, runId, 'verify', 'finish', {
    code: exitCode,
    verdict: result.verdict,
    source: result.verdictSource,
    provider: 'claude', role: 'execution-reviewer',
    ...(usage ? { tokens: usage } : {}),
    timedOut: r.timedOut,
    pass,
    verdictConsistency: result.verdictConsistency?.status ?? null,
    usageConsistency: result.usageConsistency.status,
  });
  return result;
}
