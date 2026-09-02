import {
  DebateLedger,
  detectCircling,
  PIVOT_CONCLUDE,
  PIVOT_FRESH,
  shouldPivot,
} from './debate.js';
import {
  ARBITER_UNVERIFIED,
  buildArbiterPrompt,
  parseAgreementJudgement,
  parseCapabilityJudgement,
  parsePivotJudgement,
} from './arbiter.js';
import { reportEvent } from './events.js';
import { addUsage, EMPTY_USAGE } from './usage.js';

// The standing law every seat reads before it drafts, proposes, reviews, or
// judges agreement — identical in every tier, so a seat cannot be told one
// thing about a plan and another about a goal.
export const CONVERSATION_DNA = [
  'Standing law for every seat in this conversation:',
  '1. Determinism advises; the model decides; contradiction asks. Mechanical signals rank, flag, record, or ration — they never decide, hide an option, or assert a conclusion.',
  '2. No silent caps, gates, or refusals. Every bound states what it withheld. A check that did not run must never read as one that passed; an empty result may mean never-ran; trust no completion signal.',
  '3. Never cut judged text short. Correctness beats speed and cost.',
  '4. Corrections show BOTH: when you reverse an earlier round\'s decision, mark it explicitly (SUPERSEDED: ...) beside what must survive — never a silent rewrite. Recommend with a reason; never withhold the alternative.',
  '5. The loop writes the tests too: every task carries test requirements the executor implements, and the reviewer still writes its own independent tests.',
  '6. Surface owner decisions; record assumptions: a product-intent question you cannot ground in the project statement or constitution is answered conservatively AND recorded under an ## Assumptions heading in your artifact.',
  '7. Repair until it works: malformed artifacts, contradictions, and cycles come back to you verbatim as feedback — answer them.',
  '8. Rations (like the repository map) are reachable-past: read any file directly when the survey is not enough.',
].join('\n');

/**
 * An artifact that ARRIVED but does not parse, contradicts itself, or cycles.
 * The seat ran and said something, so the conversation can answer it: the
 * message goes back verbatim as the next round's feedback. Refusal stays
 * reserved for a seat that did not run at all.
 */
export class RepairableArtifactError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RepairableArtifactError';
  }
}

// Structured seat responses. The format is prompt discipline, not protocol: the
// parser extracts what matches and carries severities VERBATIM. Nothing anywhere
// validates a severity, filters by one, or branches on one — they are input to
// the arbiter's judgement and nothing else.
export function parseSeatReview(text) {
  const source = String(text ?? '');
  const agreeMatches = [...source.matchAll(/(?:^|\n|\s)AGREE:\s*(yes|no)\b/gi)];
  const agree = agreeMatches.length > 0
    ? agreeMatches.at(-1)[1].toLowerCase() === 'yes'
    : null;
  const suggestions = [...source.matchAll(/(?:^|\n)\s*(S[\w-]+)\s+([^\s:]{1,12}):\s*(.+?)(?=\n|$)/g)]
    .map((match) => ({ id: match[1], severity: match[2], text: match[3].trim() }));
  const questions = [...source.matchAll(/(?:^|\n)\s*(Q[\w-]+):\s*(.+?)(?=\n|$)/g)]
    .map((match) => ({ id: match[1], text: match[2].trim() }));
  return {
    agree: agree === true,
    readable: agree !== null,
    suggestions,
    questions,
    content: source,
  };
}

function capabilityPrompt({ seat, plan, remedyOnly = false, previousAnswer }) {
  return buildArbiterPrompt({
    type: 'capability', seat, plan, remedyOnly, previousAnswer,
  }).replace('# Claude arbiter seat', `# ${seat} capability seat`);
}

async function capabilityVetoes({
  plan,
  checkCapability,
  reporter,
  runId,
  planRound,
  tier,
}) {
  if (typeof checkCapability !== 'function') return [];
  const vetoes = [];
  for (const seat of ['executor', 'reviewer', 'arbiter']) {
    const firstPrompt = capabilityPrompt({ seat, plan });
    const first = await checkCapability({ seat, plan, prompt: firstPrompt });
    let judgement = parseCapabilityJudgement(first);
    if (judgement.verdict !== 'answered' || judgement.capable !== false) continue;
    const answers = [first];
    if (!judgement.complete) {
      const prompt = capabilityPrompt({
        seat, plan, remedyOnly: true, previousAnswer: first,
      });
      const second = await checkCapability({
        seat,
        plan,
        prompt,
        remedyOnly: true,
        previousAnswer: first,
      });
      answers.push(second);
      const supplement = parseCapabilityJudgement(second);
      if (supplement.verdict === 'answered' && supplement.capable === false) {
        judgement = {
          ...judgement,
          what: supplement.what || judgement.what,
          why: supplement.why || judgement.why,
          alternative: supplement.alternative || judgement.alternative,
        };
        judgement.complete = Boolean(judgement.what && judgement.why && judgement.alternative);
      } else {
        const alternative = typeof second === 'string'
          ? second.trim()
          : typeof second?.alternative === 'string' ? second.alternative.trim()
            : typeof second?.answer === 'string' ? second.answer.trim() : '';
        if (alternative) {
          judgement = { ...judgement, alternative, complete: Boolean(judgement.what && judgement.why) };
        }
      }
    }
    const veto = { seat, ...judgement, answers };
    vetoes.push(veto);
    reportEvent(reporter, runId, 'capability', 'vetoed', {
      tier,
      planRound,
      seat,
      what: veto.what,
      why: veto.why,
      alternative: veto.alternative,
      complete: veto.complete,
      answers,
    });
  }
  return vetoes;
}

function vetoFeedback(vetoes) {
  return [
    '# Capability veto remedies',
    '',
    'The previous draft cannot proceed. Redraft it around each seat-authoritative remedy.',
    '',
    ...vetoes.flatMap((veto) => [
      `## ${veto.seat}`,
      `Cannot do: ${veto.what}`,
      `Limitation: ${veto.why}`,
      `Use instead: ${veto.alternative || 'No complete alternative was supplied; find a compatible mechanism.'}`,
      '',
    ]),
  ].join('\n');
}

/**
 * The tier-agnostic conversation: three seats storm from the same raw input,
 * the arbiter proposes, two seats review, the arbiter judges agreement, and a
 * converged proposal is written by the tier's own writer. Tiers differ only in
 * their `strategy` — what a request looks like, how an artifact parses, and
 * what converging writes. The engine owns the loop, the ledger, the pivot, the
 * usage meter, and the event stream.
 */
export async function runConversation({
  runId,
  reporter,
  rounds,
  tier,
  seats = {},
  strategy = {},
} = {}) {
  const {
    draftCodex,
    draftCursor,
    reviewCodex,
    reviewCursor,
    arbitrate: arbitrateSeat,
    checkCapability,
  } = seats;
  const {
    draftRequest,
    parseDraft,
    proposeRequest,
    parseProposal,
    proposalText,
    reviewRequests,
    agreementRequest,
    capabilityPlanText,
    writeConverged,
  } = strategy;

  const ledger = new DebateLedger();
  // Every seat call adds its usage here, so a conversation that never converges
  // still reports what it spent. The taxi meter runs whether or not you arrive.
  let usageTotal = EMPTY_USAGE;
  const tallyUsage = (value) => { if (value?.usage) usageTotal = addUsage(usageTotal, value.usage); return value; };
  let pivotCount = 0;
  const pivotHistory = [];
  const capabilityHistory = [];
  const stormHistory = [];
  const roundHistory = [];

  const arbitrate = async (arbiterRequest) => {
    if (typeof arbitrateSeat !== 'function') {
      return { verdict: ARBITER_UNVERIFIED, unavailable: true };
    }
    let result;
    try {
      result = await arbitrateSeat(arbiterRequest);
    } catch {
      result = { verdict: ARBITER_UNVERIFIED };
    }
    return tallyUsage(result);
  };

  const finish = (reason, round, extra = {}) => {
    const converged = reason === 'converged';
    const result = {
      runId,
      converged,
      reason,
      rounds: round,
      storm: stormHistory,
      roundHistory,
      capabilityVetoes: capabilityHistory,
      pivotHistory,
      tokens: { total: { ...usageTotal } },
      ...extra,
    };
    reportEvent(reporter, runId, 'plan', 'finish', {
      tier,
      converged,
      reason,
      rounds: round,
      ...(extra.pivot === undefined ? {} : { pivot: extra.pivot }),
    });
    return result;
  };

  const failureMessage = (error) => (error instanceof Error ? error.message : String(error));

  // What a proposal READS AS, in the tier's own words. Only the plan tier's
  // artifact happens to be a `plan` string; a tier whose proposal is
  // {items, sections} says so here, and that rendering — never `undefined` — is
  // what the next proposal, the pivot judgement, and a FRESH re-storm see.
  const renderProposal = (proposal) => proposalText?.(proposal) ?? proposal.plan;

  // All three seats draft independently from the SAME raw input - never from a
  // paraphrase, so their takes stay uncorrelated.
  const stormOnce = async ({ round, feedback, failedPlan }) => {
    const requests = draftRequest({ round, feedback, failedPlan });
    const attempts = await Promise.all([
      (async () => {
        try {
          // Usage is tallied on the seat's own answer, before parsing: a seat
          // that spoke unintelligibly still spent what it spent.
          const artifact = parseDraft(tallyUsage(await draftCodex(requests.codexInput)));
          return { seat: 'codex', ...artifact };
        } catch (error) { return { seat: 'codex', error: failureMessage(error) }; }
      })(),
      (async () => {
        if (typeof draftCursor !== 'function') return { seat: 'cursor', error: 'cursor drafting seat unavailable' };
        try {
          const artifact = parseDraft(tallyUsage(await draftCursor(requests.cursorRequest)));
          return { seat: 'cursor', ...artifact };
        } catch (error) { return { seat: 'cursor', error: failureMessage(error) }; }
      })(),
      (async () => {
        const response = await arbitrate(requests.claudeRequest);
        if (!response || response.verdict === ARBITER_UNVERIFIED
          || response.launchFailed || response.timedOut) {
          return { seat: 'claude', error: 'claude drafting seat unavailable' };
        }
        try {
          const text = typeof response === 'string' ? response : response.answer ?? response;
          return { seat: 'claude', ...parseDraft(text) };
        } catch (error) { return { seat: 'claude', error: failureMessage(error) }; }
      })(),
    ]);
    reportEvent(reporter, runId, 'plan', 'storm', {
      tier,
      planRound: round,
      drafts: attempts.map(({ seat, error }) => ({ seat, ok: !error, ...(error ? { error } : {}) })),
    });
    stormHistory.push({
      round,
      drafts: attempts.map(({ seat, error }) => ({ seat, ok: !error, ...(error ? { error } : {}) })),
    });
    return attempts;
  };

  const normalizeSeatReview = (value) => {
    if (typeof value === 'string') return parseSeatReview(value);
    if (value && typeof value === 'object' && typeof value.agree === 'boolean') {
      return {
        readable: true,
        suggestions: [],
        questions: [],
        content: '',
        ...value,
      };
    }
    return parseSeatReview(String(value?.content ?? ''));
  };

  const unavailableReview = () => ({
    agree: false, readable: false, suggestions: [], questions: [], content: '', unavailable: true,
  });

  const reviewBoth = async ({ round, proposal }) => {
    const requests = reviewRequests({ round, proposal });
    const [codex, cursor] = await Promise.all([
      (async () => {
        if (typeof reviewCodex !== 'function') return unavailableReview();
        try {
          return normalizeSeatReview(tallyUsage(await reviewCodex(requests.codex)));
        } catch { return unavailableReview(); }
      })(),
      (async () => {
        if (typeof reviewCursor !== 'function') return unavailableReview();
        try {
          return normalizeSeatReview(tallyUsage(await reviewCursor(requests.cursor)));
        } catch { return unavailableReview(); }
      })(),
    ]);
    for (const [seat, review] of [['codex', codex], ['cursor', cursor]]) {
      reportEvent(reporter, runId, 'plan', 'review', {
        tier,
        planRound: round,
        seat,
        agree: review.agree === true,
        readable: review.readable !== false,
        suggestionIds: review.suggestions.map((item) => item.id),
        questionCount: review.questions.length,
        ...(review.unavailable ? { unavailable: true } : {}),
      });
    }
    return { codex, cursor };
  };

  let stormDrafts = null;
  let reStorm = true;
  let feedback = '';
  let failedPlan = '';
  let previousProposal = '';
  let openQuestions = [];
  let round = 0;

  for (round = 1; rounds === undefined || round <= rounds; round++) {
    if (reStorm) {
      stormDrafts = await stormOnce({ round, feedback, failedPlan });
      reStorm = false;
      if (stormDrafts.every((attempt) => attempt.error)) {
        // Nothing was drafted, so there is nothing to talk about. This is
        // inability, not a mechanical verdict on any artifact.
        return finish('storm-exhausted', round);
      }
    }

    const proposeResponse = await arbitrate(proposeRequest({
      round,
      drafts: stormDrafts.filter((attempt) => !attempt.error),
      feedback,
      questions: openQuestions,
      previousProposal,
    }));
    let proposal = null;
    let repair = null;
    if (proposeResponse && proposeResponse.verdict !== ARBITER_UNVERIFIED
      && !proposeResponse.launchFailed && !proposeResponse.timedOut) {
      try {
        // The seat's response goes to the tier's parser RAW. Collapsing it to
        // text here stringified an artifact-less object to '[object Object]',
        // which every tier parser then read as a MALFORMED artifact and fed
        // back — forever, when rounds are unbounded. Only the tier knows what
        // its artifact looks like, so only the tier can tell a seat that said
        // nothing (terminal) from one that said it badly (repairable).
        proposal = parseProposal(proposeResponse);
      } catch (error) {
        if (error instanceof RepairableArtifactError) repair = error.message;
        else proposal = null;
      }
    }
    reportEvent(reporter, runId, 'plan', 'proposal', {
      tier, planRound: round, ok: proposal !== null, ...(repair === null ? {} : { repair }),
    });
    if (repair !== null) {
      // The seat ran and answered; the answer just does not parse. That is a
      // repairable artifact, so the error goes back to it verbatim rather than
      // ending the conversation.
      roundHistory.push({ round, repair });
      feedback = repair;
      reStorm = false;
      continue;
    }
    if (proposal === null) {
      // The collating seat did not produce a proposal. A seat that did not run
      // cannot be substituted by a rule, so the round cannot proceed.
      return finish('arbiter-unavailable', round);
    }
    previousProposal = renderProposal(proposal);

    const reviews = await reviewBoth({ round, proposal });
    openQuestions = [
      ...reviews.codex.questions.map((question) => ({ seat: 'codex', ...question })),
      ...reviews.cursor.questions.map((question) => ({ seat: 'cursor', ...question })),
    ];

    const agreementResponse = await arbitrate(agreementRequest({ round, proposal, reviews }));
    const agreement = parseAgreementJudgement(agreementResponse);
    reportEvent(reporter, runId, 'plan', 'agreement', {
      tier,
      planRound: round,
      converged: agreement.verdict === 'answered' && agreement.converged === true,
      unjudged: agreement.verdict !== 'answered',
      ...(agreement.reason ? { reason: agreement.reason } : {}),
    });

    // Convergence is three seats actually agreeing. Silence, an unreadable
    // response, or an absent seat is not agreement; an overruled objection does
    // not exist here at all - Claude persuades through feedback, never outvotes.
    const seatsAgree = reviews.codex.agree === true && reviews.cursor.agree === true;
    const converged = seatsAgree
      && agreement.verdict === 'answered'
      && agreement.converged === true;

    const suggestionIds = [
      ...reviews.codex.suggestions.map((item) => `codex-${item.id}`),
      ...reviews.cursor.suggestions.map((item) => `cursor-${item.id}`),
    ];
    ledger.record(round, suggestionIds);
    roundHistory.push({
      round,
      reviews: {
        codex: {
          agree: reviews.codex.agree,
          readable: reviews.codex.readable !== false,
          suggestions: reviews.codex.suggestions,
          questions: reviews.codex.questions,
          ...(reviews.codex.unavailable ? { unavailable: true } : {}),
        },
        cursor: {
          agree: reviews.cursor.agree,
          readable: reviews.cursor.readable !== false,
          suggestions: reviews.cursor.suggestions,
          questions: reviews.cursor.questions,
          ...(reviews.cursor.unavailable ? { unavailable: true } : {}),
        },
      },
      agreement,
      converged,
    });
    reportEvent(reporter, runId, 'plan', 'round', {
      tier,
      planRound: round,
      suggestionIds,
      codexAgrees: reviews.codex.agree === true,
      cursorAgrees: reviews.cursor.agree === true,
      converged,
    });

    if (converged) {
      const capabilityText = capabilityPlanText(proposal);
      if (capabilityText !== null && capabilityText !== undefined) {
        const vetoes = await capabilityVetoes({
          plan: capabilityText,
          checkCapability,
          reporter,
          runId,
          planRound: round,
          tier,
        });
        if (vetoes.length > 0) {
          capabilityHistory.push({ round, vetoes });
          feedback = vetoFeedback(vetoes);
          continue;
        }
      }
      let extra;
      try {
        extra = await writeConverged(proposal);
      } catch (error) {
        if (!(error instanceof RepairableArtifactError)) throw error;
        // A contradiction the writer found (a cycle, a mismatch) is the seats'
        // to resolve, and they only can if they are told what it was.
        roundHistory.push({ round, repair: error.message });
        feedback = error.message;
        reStorm = false;
        continue;
      }
      reportEvent(reporter, runId, 'plan', 'converged', {
        tier,
        planRound: round,
        suggestions: suggestionIds.length,
      });
      return finish('converged', round, extra);
    }

    // Claude's feedback leads; the seats' own words follow verbatim so the next
    // proposal answers them rather than a summary of them.
    feedback = [
      agreement.feedback || '',
      ...['codex', 'cursor'].flatMap((seat) => reviews[seat].suggestions.map(
        (item) => `${seat} ${item.id} ${item.severity}: ${item.text}`,
      )),
    ].filter(Boolean).join('\n');

    if (detectCircling(ledger)) {
      const pivotJudgement = parsePivotJudgement(await arbitrate({
        type: 'pivot',
        ledger: Array.from({ length: ledger.currentRound }, (_, index) => ({
          round: index + 1, findingIds: ledger.round(index + 1),
        })),
        recurringFindings: suggestionIds.filter((id) => ledger.stuckFindings().has(id)),
        attempted: pivotHistory,
        plan: renderProposal(proposal),
      }));
      const unjudged = pivotJudgement.verdict !== 'answered';
      const decision = unjudged ? shouldPivot(pivotCount) : pivotJudgement.decision;
      pivotCount++;
      pivotHistory.push({
        decision,
        unjudged,
        ...(pivotJudgement.reason ? { reason: pivotJudgement.reason } : {}),
      });
      if (decision === PIVOT_CONCLUDE) {
        return finish('pivot-conclude', round, { pivot: PIVOT_CONCLUDE });
      }
      if (decision === PIVOT_FRESH) {
        reStorm = true;
        failedPlan = renderProposal(proposal);
        previousProposal = '';
        openQuestions = [];
        feedback = '';
      } else {
        feedback = `${feedback}\nAmend the approach specifically to break the recurring suggestions.`;
      }
    }
  }

  return finish('rounds-exhausted', round - 1);
}
