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

// The prompt goes on STDIN, never in argv. When `claude` resolves to the npm
// .cmd shim, Windows routes the launch through cmd.exe, whose command line is
// capped at 8191 characters — an arbiter prompt carrying a plan blows past that
// and the shim exits 1 with "The command line is too long" in under a second.
// The arbiter then reads as UNVERIFIED, so every blocking finding stands with no
// appeal and the run looks judged when nothing judged it.
//
// Measured on Windows with a 10,022-character prompt:
//   claude.cmd -p <prompt>        -> exit 1, "The command line is too long"
//   claude.exe -p <prompt>        -> exit 0
//   <prompt> | claude.cmd -p      -> exit 0        <- uniform, shim or exe
//
// Preferring the nested claude.exe would also work, but only where npm happens
// to have unpacked one. Stdin has no length limit anywhere and needs no
// threshold deciding which path to take.
export function buildClaudeArgs({ prompt, model = DEFAULT_ARBITER_MODEL } = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError('arbiter prompt must be a non-empty string');
  }
  return [
    '-p',
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

/**
 * Exactly what is known about one reviewing seat, in one of four states — never
 * a boolean. `agree` and `disagree` are judgements the seat made; the other two
 * are not judgements at all: `stance-unreadable` means the seat answered and no
 * stance could be read in what it said, `unavailable` means the seat never ran.
 * Collapsing either into `disagree` (as every prompt and the round line did
 * until 63c788f) reports a measurement failure as an objection on the merits.
 */
export function seatStance(review) {
  if (!review || typeof review !== 'object') return 'unavailable';
  if (review.unavailable === true) return 'unavailable';
  if (review.readable === false) return 'stance-unreadable';
  return review.agree === true ? 'agree' : 'disagree';
}

// Read by every tier's agreement prompt, so a judge cannot be told one thing
// about a plan's seats and another about a goal's.
export const SEAT_STATE_LAW = [
  'Each seat block below states that seat\'s STATE, which is one of exactly four:',
  '- agree: the seat stated AGREE: yes.',
  '- disagree: the seat stated AGREE: no.',
  '- stance-unreadable: the seat answered, but no stance could be read in what it said. This is a MEASUREMENT failure, not a disagreement on the merits — the seat\'s raw answer is quoted in full beneath its block, and reading it is your job, not a parser\'s.',
  '- unavailable: the seat never ran and said nothing at all.',
  'Only an explicit agree is agreement: stance-unreadable and unavailable are never consent, and neither is a refusal you may attribute to the seat. When either one stands in the way of convergence, say so in your reason using its own name rather than calling that seat a disagreement.',
].join('\n');

/**
 * The per-seat context every tier hands its agreement judge: the state first,
 * then the structured findings, then the seat's own words. Shared so a plan's
 * judge and a goal's judge are told the same kind of truth about their seats.
 */
export function seatReviewContext(review) {
  return {
    stance: seatStance(review),
    agree: review?.agree === true,
    suggestions: review?.suggestions ?? [],
    questions: review?.questions ?? [],
    content: review?.content ?? '',
  };
}

/**
 * One seat's review as the judge sees it: its state named, its structured
 * findings intact, and — exactly when the stance could not be read — the seat's
 * own answer verbatim and complete, because there the parsed fields represent
 * nothing and the raw text is the only evidence of what was said.
 */
export function seatReviewBlock(label, review) {
  const stance = review?.stance ?? seatStance(review);
  if (stance === 'unavailable') {
    return `${label} (stance: unavailable — this seat never ran and produced no review; its absence is not agreement and not a disagreement)`;
  }
  const findings = compact({
    suggestions: review?.suggestions ?? [],
    questions: review?.questions ?? [],
  });
  if (stance === 'stance-unreadable') {
    return [
      `${label} (stance: stance-unreadable — no AGREE line could be read in this seat's answer; judge the raw text yourself)`,
      findings,
      'RAW ANSWER, verbatim and complete — everything this seat said:',
      String(review?.content ?? ''),
    ].join('\n');
  }
  return `${label} (stance: ${stance} — this seat stated AGREE: ${stance === 'agree' ? 'yes' : 'no'})\n${findings}`;
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
  if (request.type === 'review') {
    return [...common,
      'The debate has circled without progress, so you now read the change YOURSELF instead of judging other seats\' claims about it. Review the diff against the task first-hand: are the recurring objections real defects, or is the executor\'s defence right?',
      'Severities are your own judgement of priority (P0/P1/P2 or your own words); nothing mechanical acts on them.',
      'Schema: {"stance":"reviewer|executor|mixed","findings":[{"id":"C1","severity":"P0","text":"..."}],"reasoning":"what you verified first-hand"}.',
      `TASK ${String(request.task ?? '')}`,
      `DIFF ${String(request.diff ?? '')}`,
      `STANDING_FINDINGS ${compact(request.findings ?? [])}`,
      ...(request.gate ? [`GATE_RED ${compact(request.gate)}`] : []),
    ].join('\n\n');
  }
  if (request.type === 'landing') {
    return [...common,
      'The reviewer has closed its findings and the debate converged. Before this change lands on the operator\'s tree, review it YOURSELF, first-hand: read the diff against the task, weigh the closed findings and the command evidence, and judge whether it should land.',
      'Landing is your judgement, not a checklist: approve when you are satisfied the change achieves the task without a defect worth stopping for; refuse when you are not, and say exactly why. Severities in your findings are your own words; nothing mechanical acts on them.',
      'Schema: {"approved":true|false,"reasoning":"what you verified first-hand","findings":[{"id":"L1","severity":"P0","text":"..."}]}.',
      `TASK ${String(request.task ?? '')}`,
      `DIFF ${String(request.diff ?? '')}`,
      `CLOSED_FINDINGS ${compact(request.findings ?? [])}`,
      `EVIDENCE ${compact(request.evidence ?? [])}`,
    ].join('\n\n');
  }
  if (request.type === 'acceptance') {
    return [...common,
      'Every task for this goal has landed. Read the goal spec and the aggregate diff of everything that landed YOURSELF, first-hand: is the project in a working state that now delivers this goal\'s capability?',
      'Approve when you are satisfied the working tree now delivers the goal; refuse when you are not, and say exactly why. Severities in your findings are your own words; nothing mechanical acts on them.',
      'Schema: {"approved":true|false,"reasoning":"what you verified first-hand","findings":[{"id":"A1","severity":"P0","text":"..."}]}.',
      `GOAL_SPEC ${String(request.goalSpec ?? '')}`,
      ...(request.constitution ? [`CONSTITUTION ${String(request.constitution)}`] : []),
      `AGGREGATE_DIFF ${String(request.diff ?? '')}`,
      `QUEUE_LOG ${compact(request.queueLog ?? [])}`,
    ].join('\n\n');
  }
  if (request.type === 'pivot') {
    return [...common,
      'Choose how to respond to deterministic evidence that the debate is circling.',
      'Schema: {"decision":"amend|fresh|conclude","reason":"brief merits"}.',
      `LEDGER ${compact(request.ledger)}`,
      `RECURRING ${compact(request.recurringFindings ?? [])}`,
      `ATTEMPTED ${compact(request.attempted ?? [])}`,
      ...(request.independentReview
        ? [`YOUR_INDEPENDENT_REVIEW ${compact(request.independentReview)}`]
        : []),
      `PLAN ${String(request.plan ?? '')}`,
    ].join('\n\n');
  }
  if (request.type === 'draft') {
    return [
      '# Claude plan drafting seat',
      'You are read-only. Do not create, edit, or delete files and do not run a gate.',
      'You are one of three seats drafting independently from the same raw goal. Draft from your own reading of the repository; do not imagine what the other seats might write.',
      'Draft an implementation plan and its executable gate.json for this goal:',
      String(request.goal ?? ''),
      'Every cited path and line must already exist in the target; verify each citation by reading before citing. Describe proposed new paths without formatting them as citations.',
      'Return exactly two tagged artifacts and no prose outside them:',
      '<PLAN_MD>\n...complete Markdown...\n</PLAN_MD>',
      '<GATE_JSON>\n[{"bin":"...","args":["..."]}]\n</GATE_JSON>',
      ...(request.feedback ? ['Required corrections from the previous round:', String(request.feedback)] : []),
      ...(request.failedPlan ? ['Discarded framing (choose a genuinely different strategy):', String(request.failedPlan)] : []),
    ].join('\n\n');
  }
  if (request.type === 'propose') {
    return [
      '# Claude proposal seat',
      'You are read-only. Do not create, edit, or delete files and do not run a gate.',
      'Three seats drafted plans independently from the same raw goal. Collate them into one proposal: keep the strongest structure, graft the best ideas from the others, and resolve their disagreements by judgement stated in the plan itself.',
      `GOAL ${String(request.goal ?? '')}`,
      ...(request.drafts ?? []).flatMap((draft) => [
        `## Draft from the ${draft.seat} seat`,
        String(draft.plan ?? '(this seat produced no draft)'),
        `Gate: ${JSON.stringify(draft.gate ?? null)}`,
      ]),
      ...(request.previousProposal ? ['Previous proposal:', String(request.previousProposal)] : []),
      ...(request.feedback ? ['Required corrections:', String(request.feedback)] : []),
      ...((request.questions ?? []).length > 0 ? [
        'Open questions from the reviewing seats. Answer each explicitly inside the plan, or revise the plan so the question does not arise:',
        ...request.questions.map((question) => `- ${question.seat} ${question.id}: ${question.text}`),
      ] : []),
      'Every cited path and line must already exist in the target; verify each citation by reading before citing.',
      'Return exactly two tagged artifacts and no prose outside them:',
      '<PLAN_MD>\n...complete Markdown...\n</PLAN_MD>',
      '<GATE_JSON>\n[{"bin":"...","args":["..."]}]\n</GATE_JSON>',
    ].join('\n\n');
  }
  if (request.type === 'agreement') {
    return [...common,
      'You are the final arbiter of plan convergence. Two seats have reviewed the proposal against the raw goal; their responses are below, verbatim, severities included. No severity blocks by rule — weigh everything by judgement.',
      'Converge only when the proposal genuinely achieves the goal and both seats have said AGREE: yes. If either seat disagrees, or you are not satisfied, do not converge; say what must change.',
      SEAT_STATE_LAW,
      'Schema: {"converged":true,"reason":"brief merits"} or {"converged":false,"reason":"...","feedback":"exact corrections for the next proposal"}.',
      `GOAL ${String(request.goal ?? '')}`,
      `PROPOSAL ${String(request.proposal ?? '')}`,
      `GATE ${compact(request.gate ?? null)}`,
      seatReviewBlock('CODEX_REVIEW', request.reviews?.codex),
      seatReviewBlock('CURSOR_REVIEW', request.reviews?.cursor),
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
  const directKeys = ['answer', 'decision', 'capable', 'alternative', 'converged', 'stance', 'approved'];
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

export function parseIndependentReview(response) {
  const value = directOrAnswer(response);
  const stance = String(value?.stance ?? '').toLowerCase();
  if (!['reviewer', 'executor', 'mixed'].includes(stance)) {
    return { verdict: ARBITER_UNVERIFIED };
  }
  // Findings are carried as given — id, severity and text are the arbiter's own
  // words. Severity is never validated or filtered; it is input to judgement.
  const findings = Array.isArray(value.findings)
    ? value.findings
      .filter((finding) => finding && typeof finding.text === 'string' && finding.text.trim() !== '')
      .map((finding, index) => ({
        id: String(finding.id ?? `C${index + 1}`),
        severity: String(finding.severity ?? ''),
        text: finding.text.trim(),
      }))
    : [];
  return {
    verdict: 'answered',
    stance,
    findings,
    reasoning: String(value.reasoning ?? '').trim(),
  };
}

export function parseLandingJudgement(response) {
  const value = directOrAnswer(response);
  if (typeof value?.approved !== 'boolean') return { verdict: ARBITER_UNVERIFIED };
  // Findings and severities are carried as given — the arbiter's own words,
  // never validated or filtered on the way through.
  const findings = Array.isArray(value.findings)
    ? value.findings
      .filter((finding) => finding && typeof finding.text === 'string' && finding.text.trim() !== '')
      .map((finding, index) => ({
        id: String(finding.id ?? `L${index + 1}`),
        severity: String(finding.severity ?? ''),
        text: finding.text.trim(),
      }))
    : [];
  return {
    verdict: 'answered',
    approved: value.approved,
    reasoning: String(value.reasoning ?? '').trim(),
    findings,
  };
}

// The acceptance judgement shares the landing parser's contract deliberately
// (approved boolean required else UNVERIFIED; findings carried verbatim) —
// nothing in parseLandingJudgement's output is landing-specific, so this is a
// re-export rather than a duplicate implementation.
export const parseAcceptanceJudgement = parseLandingJudgement;

export function parseAgreementJudgement(response) {
  const value = directOrAnswer(response);
  if (typeof value?.converged !== 'boolean') return { verdict: ARBITER_UNVERIFIED };
  return {
    verdict: 'answered',
    converged: value.converged,
    reason: String(value.reason ?? '').trim(),
    feedback: String(value.feedback ?? '').trim(),
  };
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
      input: prompt,
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
