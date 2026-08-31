import { spawnCapture } from './spawn.js';
import { reportEvent } from './events.js';
import {
  annotateUsageConsistency,
  EMPTY_USAGE,
  normalizeClaudeUsage,
} from './usage.js';
import { resolveStageTimeouts } from './timeouts.js';

export const DEFAULT_ARBITER_MODEL = 'sonnet';
export const ARBITER_UNVERIFIED = 'UNVERIFIED';

export function buildClaudeArgs({ prompt, model = DEFAULT_ARBITER_MODEL } = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError('arbiter prompt must be a non-empty string');
  }
  return [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'plan',
    ...(model ? ['--model', model] : []),
  ];
}

function readableText(streamText) {
  let assistant = '';
  let result = '';
  let resultSeen = false;
  let resultUsable = false;
  let usage = EMPTY_USAGE;
  for (const line of String(streamText ?? '').split(/\r?\n/)) {
    const source = line.trim();
    if (!source) continue;
    let item;
    try { item = JSON.parse(source); } catch { continue; }
    if (item.type === 'assistant' && Array.isArray(item.message?.content)) {
      for (const part of item.message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') assistant = part.text;
      }
    }
    if (item.type === 'result') {
      resultSeen = true;
      resultUsable = item.is_error !== true && typeof item.result === 'string';
      result = resultUsable ? item.result : '';
      usage = normalizeClaudeUsage(item.usage);
    }
  }
  // A real but empty/error result must not be replaced with stale assistant prose.
  const answer = resultSeen ? (resultUsable ? result : '') : assistant;
  return { answer: answer.trim(), usage };
}

export function parseArbiterStream(streamText) {
  const parsed = readableText(streamText);
  return {
    verdict: parsed.answer === '' ? ARBITER_UNVERIFIED : 'ANSWERED',
    answer: parsed.answer,
    usage: parsed.usage,
  };
}

function compact(value) {
  return JSON.stringify(value, null, 2);
}

export function buildArbiterPrompt(request = {}) {
  const common = [
    '# Claude arbiter seat',
    'You are read-only. Do not create, edit, or delete files and do not run a gate.',
    'Judge independently on the merits. Return exactly one JSON object and no prose.',
  ];
  if (request.type === 'finding') {
    return [...common,
      'Decide whether this blocking review finding is valid.',
      'Schema: {"verdict":"valid"} or {"verdict":"invalid","reason":"specific reason"}.',
      `FINDING ${compact(request.finding)}`,
      `PLAN ${String(request.plan ?? '')}`,
      `DIFF ${String(request.diff ?? '')}`,
    ].join('\n\n');
  }
  if (request.type === 'decision') {
    return [...common,
      'Answer the executor challenge independently; its recommendation is evidence, not a default.',
      'Schema: {"answer":"the selected answer","reason":"brief merits"}.',
      `QUESTION ${compact(request.question)}`,
      `PLAN ${String(request.plan ?? '')}`,
    ].join('\n\n');
  }
  if (request.type === 'pivot') {
    return [...common,
      'Choose how to respond to deterministic evidence that the debate is circling.',
      'Schema: {"decision":"amend|fresh|conclude","reason":"brief merits"}.',
      `LEDGER ${compact(request.ledger)}`,
      `RECURRING ${compact(request.recurringFindings ?? [])}`,
      `ATTEMPTED ${compact(request.attempted ?? [])}`,
      `PLAN ${String(request.plan ?? '')}`,
    ].join('\n\n');
  }
  if (request.type === 'capability') {
    return [...common,
      `Answer only about the ${request.seat} seat's own capabilities for this plan.`,
      'If capable, schema: {"capable":true}.',
      'If not capable, schema: {"capable":false,"what":"...","why":"...",'
        + '"alternative":"what would work instead, or exactly I do not know an alternative"}.',
      ...(request.remedyOnly ? [
        'Your previous veto was incomplete. Supply every missing field now, especially the '
          + 'constructive alternative. Repeat the full not-capable schema.',
        `PREVIOUS ${compact(request.previousAnswer)}`,
      ] : []),
      `PLAN ${String(request.plan ?? '')}`,
    ].join('\n\n');
  }
  throw new TypeError(`unknown arbiter request type: ${request.type}`);
}

function jsonAnswer(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = typeof value === 'string'
    ? value
    : typeof value?.answer === 'string' ? value.answer : '';
  if (!text.trim()) return null;
  const candidates = [
    text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
    /\{[\s\S]*\}/.exec(text)?.[0],
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next representation */ }
  }
  return null;
}

function directOrAnswer(response) {
  if (!response || response.verdict === ARBITER_UNVERIFIED
    || response.launchFailed || response.timedOut) return null;
  if (typeof response === 'string') return jsonAnswer(response);
  if (typeof response.answer === 'string') {
    const embedded = jsonAnswer(response.answer);
    if (embedded) return embedded;
  }
  const directKeys = ['answer', 'decision', 'capable', 'alternative'];
  if (directKeys.some((key) => Object.hasOwn(response, key))) return response;
  if (response.verdict === 'valid' || response.verdict === 'invalid') return response;
  return jsonAnswer(response.answer);
}

export function parseFindingJudgement(response) {
  const value = directOrAnswer(response);
  const verdict = String(value?.verdict ?? '').toLowerCase();
  if (verdict === 'valid') return { verdict: 'valid' };
  if (verdict === 'invalid' && typeof value.reason === 'string' && value.reason.trim()) {
    return { verdict: 'invalid', reason: value.reason.trim() };
  }
  return { verdict: ARBITER_UNVERIFIED };
}

export function parseDecisionJudgement(response) {
  const value = directOrAnswer(response);
  return typeof value?.answer === 'string' && value.answer.trim()
    ? { verdict: 'answered', answer: value.answer.trim(), reason: String(value.reason ?? '').trim() }
    : { verdict: ARBITER_UNVERIFIED };
}

export function parsePivotJudgement(response) {
  const value = directOrAnswer(response);
  const decision = String(value?.decision ?? '').toLowerCase();
  return ['amend', 'fresh', 'conclude'].includes(decision)
    ? { verdict: 'answered', decision, reason: String(value.reason ?? '').trim() }
    : { verdict: ARBITER_UNVERIFIED };
}

export function parseCapabilityJudgement(response) {
  const value = directOrAnswer(response);
  if (value?.capable === true) return { verdict: 'answered', capable: true };
  if (value?.capable !== false && typeof value?.alternative !== 'string') {
    const raw = typeof response === 'string'
      ? response.trim()
      : typeof response?.answer === 'string' ? response.answer.trim() : '';
    if (/\b(?:cannot|can't|unable|not capable)\b/i.test(raw)) {
      return {
        verdict: 'answered', capable: false, what: raw, why: '', alternative: '', complete: false,
      };
    }
    return { verdict: ARBITER_UNVERIFIED };
  }
  const what = String(value.what ?? '').trim();
  const why = String(value.why ?? '').trim();
  const alternative = String(value.alternative ?? '').trim();
  return {
    // A refusal remains a veto even when it is incomplete. The caller must re-ask
    // instead of silently treating malformed refusal as consent.
    verdict: 'answered',
    capable: false,
    what,
    why,
    alternative,
    complete: Boolean(what && why && alternative),
  };
}

export async function runArbiter({
  cwd,
  request,
  prompt = buildArbiterPrompt(request),
  bin = 'claude',
  model = DEFAULT_ARBITER_MODEL,
  timeoutMs,
  env = process.env,
  reporter,
  runId,
  spawnProcess,
  killProcessTree,
} = {}) {
  const resolvedTimeoutMs = timeoutMs === undefined
    ? resolveStageTimeouts(env).arbiter
    : timeoutMs;
  const args = buildClaudeArgs({ prompt, model });
  reportEvent(reporter, runId, 'arbiter', 'start', {
    bin, args, model, judgement: request?.type,
  });
  let captured;
  try {
    captured = await spawnCapture(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      timeoutMs: resolvedTimeoutMs,
      timeoutSetting: 'URO_ARBITER_TIMEOUT_MS',
      spawnProcess,
      killProcessTree,
    });
  } catch (error) {
    const failed = annotateUsageConsistency({
      verdict: ARBITER_UNVERIFIED,
      answer: '',
      usage: EMPTY_USAGE,
      launchFailed: true,
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    });
    reportEvent(reporter, runId, 'arbiter', 'finish', {
      code: null, verdict: ARBITER_UNVERIFIED, launchFailed: true,
      timedOut: false, judgement: request?.type,
    });
    return failed;
  }
  const parsed = parseArbiterStream(captured.stdout);
  const result = annotateUsageConsistency({
    ...parsed,
    launchFailed: captured.code !== 0 || captured.timedOut,
    timedOut: captured.timedOut,
    timeoutMs: captured.timeoutMs,
    exitCode: captured.code,
    ...(captured.code === 0 ? {} : { stderr: captured.stderr.slice(-1000) }),
  });
  if (result.launchFailed) {
    result.verdict = ARBITER_UNVERIFIED;
    result.answer = '';
  }
  reportEvent(reporter, runId, 'arbiter', 'finish', {
    code: captured.code,
    verdict: result.verdict,
    timedOut: captured.timedOut,
    tokens: result.usage,
    judgement: request?.type,
  });
  return result;
}
