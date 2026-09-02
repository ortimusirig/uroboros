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
  seatStance,
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

/**
 * How many times one conversation will feed a malformed proposal back to the
 * seat that produced it. Repair is unbounded feedback otherwise: the same seat
 * can answer badly forever, and with `rounds` unbounded nothing ever stops it.
 * The bound is stated, never silent — the sixth malformed artifact ends the
 * conversation as `proposal-irreparable`, converged false, nothing written,
 * with every repair message still in `roundHistory`.
 */
export const MAX_ARTIFACT_REPAIRS = 5;

// Structured seat responses. The format is prompt discipline, not protocol: the
// parser extracts what matches and carries severities VERBATIM. Nothing anywhere
// validates a severity, filters by one, or branches on one — they are input to
// the arbiter's judgement and nothing else.
export function parseSeatReview(text) {
  const source = String(text ?? '');
  // Dogfood runs 2 and 3 (terminal records, F10/F11): cursor-agent glues its
  // narration and its answer into one string with no separator, so the stance
  // arrives as "...injecting a size probe:AGREE: no" — mid-string, behind a
  // colon. The boundary therefore accepts any non-alphanumeric character (the
  // letter before AGREE in DISAGREE still refuses), emphasis marks are
  // stripped first, and the lookahead keeps the contract's own "AGREE: yes
  // means ..." echo from reading as a stance. Tolerance lives in READING,
  // never in meaning: only an explicit AGREE: yes|no parses, silence stays
  // non-consent, and the last stated stance wins.
  //
  // Every review contract — and the stance-repair paragraph that answers an
  // unreadable one — contains the literal "AGREE: yes or AGREE: no". A seat
  // that quotes the instruction back instead of answering it must not be
  // credited with the stance it merely echoed, so neither half of that phrase
  // parses: the first is refused by the lookahead, the second by the lookbehind
  // that sees the "or" in front of it. A stance the seat actually states
  // elsewhere still wins, echo or no echo.
  const stanceSource = source.replace(/[*_`]/g, '');
  const agreeMatches = [...stanceSource.matchAll(
    /(?:^|[^A-Za-z0-9])(?<!\bor\s{1,4})AGREE\s*:\s*(yes|no)\b(?!\s+means\b)(?!\s+or\s+AGREE)/gi,
  )];
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

// The proposal-repair law, applied to a review: the seat RAN and answered, and
// the answer simply carries no stance, so the unparseable text goes back to it
// verbatim — exactly once, and only to repair how the answer is READ. Nothing
// here asks a seat to change what it judged, and a seat that stays unreadable
// stays non-consenting. Every tier renders these same sentences, so no seat is
// told a different law than another.
// Deliberately states the missing line WITHOUT writing a stance token: a seat
// that quotes this sentence back must not be credited with a stance it echoed.
export const STANCE_REPAIR_OPENING = 'Your previous response did not contain a parseable stance: no AGREE line stating yes or no could be read anywhere in it.';
export const STANCE_REPAIR_CLOSING = [
  'Respond again in EXACTLY the required structure: AGREE: yes or AGREE: no, then your S<id> suggestion lines, then your Q<id> question lines.',
  // Deliberately carries no second stance token: a seat that quotes this
  // paragraph back must not be credited with a stance it only echoed.
  'This repairs only how your answer is READ. It does not ask you to change what you judged: an unchanged, unsatisfied judgement is a complete answer, as long as it arrives in the required structure with every suggestion you meant.',
];

export function stanceRepairLines(content) {
  return [
    STANCE_REPAIR_OPENING,
    'It said, verbatim:',
    String(content ?? ''),
    ...STANCE_REPAIR_CLOSING,
  ];
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
    // A probe that cannot even launch (spawn ENAMETOOLONG killed a
    // twice-converged dogfood run at the finish line) is an unavailable
    // judge — not a veto, not consent, and never a crash that discards
    // judged work. The seat is skipped and the conversation proceeds.
    let first;
    try { first = await checkCapability({ seat, plan, prompt: firstPrompt }); }
    catch { continue; }
    let judgement = parseCapabilityJudgement(first);
    if (judgement.verdict !== 'answered' || judgement.capable !== false) continue;
    const answers = [first];
    if (!judgement.complete) {
      const prompt = capabilityPrompt({
        seat, plan, remedyOnly: true, previousAnswer: first,
      });
      let second;
      try {
        second = await checkCapability({
          seat,
          plan,
          prompt,
          remedyOnly: true,
          previousAnswer: first,
        });
      } catch { second = undefined; }
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
    reviewRepairRequest,
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

  // What the seat ACTUALLY said, verbatim and untrimmed. A judgement that did
  // not parse cannot be represented by its parsed fields — they are all
  // absent — so exactly then the answer itself is the only evidence of what
  // happened, and dropping it (dogfood run 3, round 3) makes the failure
  // undiagnosable after the fact.
  const rawAnswer = (response) => {
    if (typeof response === 'string') return response;
    if (typeof response?.answer === 'string') return response.answer;
    return '';
  };

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

  // A readable review is fully represented by its parsed structure. An
  // unreadable stance is not — the raw text is the only evidence of what the
  // seat actually said, so it travels verbatim in exactly that case, alongside
  // whether the one bounded re-ask ran and whether it repaired the reading.
  const reviewRow = (review) => ({
    agree: review.agree,
    readable: review.readable !== false,
    suggestions: review.suggestions,
    questions: review.questions,
    ...(review.unavailable ? { unavailable: true } : {}),
    ...(review.stanceReasked ? { stanceReasked: true } : {}),
    ...(review.stanceRepaired ? { stanceRepaired: true } : {}),
    ...(review.readable === false && !review.unavailable
      ? { content: review.content ?? '' } : {}),
    ...(review.priorContent ? { priorContent: review.priorContent } : {}),
    ...(review.reaskContent ? { reaskContent: review.reaskContent } : {}),
  });

  /**
   * One seat's review for one round, with the bounded stance re-ask.
   *
   * A seat whose answer carries no stance RAN and SPOKE — that is a reading
   * failure, not a refusal — so its own words go back to it once, verbatim,
   * and the answer is read again. The bound is exactly one re-ask per seat per
   * round (it stands in the design's determinism-and-caps audit table): a
   * second unreadable answer travels as it does today, non-consenting, with
   * the raw text intact. Tolerance lives in READING; meaning is never re-asked.
   * A seat that never ran is not re-asked at all — there is no reading to
   * repair, and a rule may not stand in for a seat that said nothing.
   */
  const askSeatReview = async (seat, call, request) => {
    if (typeof call !== 'function') return unavailableReview();
    let review;
    try { review = normalizeSeatReview(tallyUsage(await call(request))); }
    catch { return unavailableReview(); }
    if (review.readable !== false || review.unavailable === true) return review;
    if (typeof reviewRepairRequest !== 'function') return review;
    const content = review.content ?? '';
    // Nothing was said, so there is nothing to feed back: every tier's repair
    // paragraph is gated on that text, which would make the second request
    // byte-identical to the first — a seat call spent to learn nothing. The
    // row travels as stance-unreadable directly, still not consenting.
    if (content.trim() === '') return review;
    let repairRequest;
    // A hook that throws means no re-ask was ever made. Recording that as a
    // re-ask that failed would be a check that did not run reading as one
    // that did — so the first answer stands exactly as it did before.
    try { repairRequest = reviewRepairRequest({ seat, request, content }); }
    catch { return review; }
    if (repairRequest === null || repairRequest === undefined) return review;
    let repaired;
    try { repaired = normalizeSeatReview(tallyUsage(await call(repairRequest))); }
    catch {
      // The re-ask was made and the seat died on it. That happened, and the
      // record says so; the seat's first answer stands untouched beside it.
      return { ...review, stanceReasked: true };
    }
    if (repaired.readable === false || repaired.unavailable === true) {
      return {
        ...review,
        stanceReasked: true,
        // A bound states what it withheld: when the re-ask said something new
        // and still unreadable, both answers are evidence and both are kept.
        ...(repaired.content && repaired.content !== content
          ? { reaskContent: repaired.content } : {}),
      };
    }
    // The repaired answer is the review now — but the answer it repaired is
    // where the seat's original prose lives (F20: a genuine verified review
    // wrapped in meta-commentary). Reading was repaired; the first words are
    // not deleted for having been unreadable.
    return {
      ...repaired, stanceReasked: true, stanceRepaired: true, priorContent: content,
    };
  };

  const reviewBoth = async ({ round, proposal }) => {
    const requests = reviewRequests({ round, proposal });
    const [codex, cursor] = await Promise.all([
      askSeatReview('codex', reviewCodex, requests.codex),
      askSeatReview('cursor', reviewCursor, requests.cursor),
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
        ...(review.stanceReasked ? { stanceReasked: true } : {}),
        ...(review.stanceRepaired ? { stanceRepaired: true } : {}),
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
  let artifactRepairs = 0;

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
      // ending the conversation. The row keeps this round's number: a repair
      // and the retry it buys happened INSIDE the round, and the record says so.
      roundHistory.push({ round, repair });
      artifactRepairs += 1;
      if (artifactRepairs > MAX_ARTIFACT_REPAIRS) {
        // A stated bound, not a silent cap: the seat has now answered
        // unreadably MAX_ARTIFACT_REPAIRS + 1 times, every message is in
        // roundHistory above, and the conversation ends without converging so
        // no partial artifact is ever written from an artifact that never
        // parsed. Unbounded `rounds` would otherwise loop here forever.
        return finish('proposal-irreparable', round);
      }
      feedback = repair;
      reStorm = false;
      // F12 (dogfood run 6): a repair is not deliberation — no seat reviewed
      // anything in it — so it must not spend a round. Undoing the loop's
      // increment lets the retried proposal reuse this round's number, which
      // is what makes `--rounds 1` still buy one real round of review after a
      // malformed first answer. The budget on repairs is the one above.
      round -= 1;
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
    const judgedAgreement = parseAgreementJudgement(agreementResponse);
    const agreement = judgedAgreement.verdict === 'answered'
      ? judgedAgreement
      : { ...judgedAgreement, raw: rawAnswer(agreementResponse) };
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
        codex: reviewRow(reviews.codex),
        cursor: reviewRow(reviews.cursor),
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
      // The booleans stay for compatibility with journals already on disk, but
      // the STATE is the truth: a seat whose stance could not be read has not
      // disagreed, and a seat that never ran has not spoken at all.
      codexState: seatStance(reviews.codex),
      cursorState: seatStance(reviews.cursor),
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
      const pivotResponse = await arbitrate({
        type: 'pivot',
        ledger: Array.from({ length: ledger.currentRound }, (_, index) => ({
          round: index + 1, findingIds: ledger.round(index + 1),
        })),
        recurringFindings: suggestionIds.filter((id) => ledger.stuckFindings().has(id)),
        attempted: pivotHistory,
        plan: renderProposal(proposal),
      });
      const pivotJudgement = parsePivotJudgement(pivotResponse);
      const unjudged = pivotJudgement.verdict !== 'answered';
      const decision = unjudged ? shouldPivot(pivotCount) : pivotJudgement.decision;
      pivotCount++;
      pivotHistory.push({
        decision,
        unjudged,
        ...(pivotJudgement.reason ? { reason: pivotJudgement.reason } : {}),
        // The engine's own ladder decided this one, so what the seat said —
        // and could not be read — is the only record of why it had to.
        ...(unjudged ? { raw: rawAnswer(pivotResponse) } : {}),
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
