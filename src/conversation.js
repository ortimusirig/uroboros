import { createHash } from 'node:crypto';
import { decisionAuthority } from './decision-policy.js';
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

/** Keep historical prompts readable while reconciling new dialogue output rules. */
export function dialoguePromptText(text) {
  return String(text ?? '')
    .replaceAll('Return exactly two tagged artifacts and no prose outside them:',
      'For an explicit proposal or revision return these two artifact tags alongside the required UROBOROS_DIALOGUE envelope:')
    .replaceAll('and the reviewer still writes its own independent tests.',
      'and the reviewer independently inspects evidence, adding tests when useful. Preserve all explicitly required checks.');
}

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

/**
 * The one wording a seat uses to say its process died before producing anything
 * judgeable, with the launch stderr excerpt appended. The excerpt is the whole
 * point: bare "failed to launch" names no cause, and the account condition
 * behind it (63c788f — "You've hit your usage limit", sitting unread in stderr)
 * can then be neither classified nor remedied.
 */
export function seatLaunchFailure(seat, result) {
  const stderr = result?.stderr ? String(result.stderr) : '';
  return `${seat} seat ${result?.timedOut ? 'timed out' : 'failed to launch'}${stderr ? `: ${stderr}` : ''}`;
}

/**
 * What a PRODUCTION review seat returns when its process died: not a throw — a
 * non-consenting `unavailable` row, exactly as before. It carries the launch
 * text in `error`, which `reviewRow` deliberately does not copy: that text
 * feeds the terminal outage summary only, never an event and never the round
 * record. Without it a review-only outage has nothing to classify, and a capped
 * account reads as an anonymous absent seat.
 */
export function unavailableSeatReview(result, seat = 'codex review') {
  return {
    agree: false,
    readable: false,
    suggestions: [],
    questions: [],
    content: '',
    unavailable: true,
    error: seatLaunchFailure(seat, result),
    usage: result?.usage,
  };
}

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


/** Canonical JSON identity includes requirements, plan bytes, and evidence configuration. */
export function canonicalPlanningArtifact(value) {
  if (value instanceof Map) value = Object.fromEntries(value);
  if (Array.isArray(value)) return value.map(canonicalPlanningArtifact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined)
      .map(key => [key, canonicalPlanningArtifact(value[key])]));
  }
  return value;
}

export function planningArtifactDigest(requirements, proposal) {
  return createHash('sha256').update(JSON.stringify(canonicalPlanningArtifact({ requirements, proposal }))).digest('hex');
}

export function conversationText(messages = []) {
  return messages.map(message => [
    `## ${message.speaker} (${message.role}), turn ${message.turn}, ${message.stance}`,
    message.content,
    ...(message.error ? [`Transport error: ${message.error}`] : []),
    ...(message.decision ? [`Decision: ${message.decision}; ${message.reason ?? ''}`] : []),
  ].join('\n')).join('\n\n');
}

function responseText(response) {
  if (typeof response === 'string') return response;
  return response?.content ?? response?.answer ?? response?.text ?? '';
}

function stance(response) {
  const parsed = parseSeatReview(responseText(response));
  return {
    ...parsed,
    ...(response && typeof response === 'object' ? response : {}),
    content: responseText(response),
  };
}

function unavailable(response) {
  return response == null || response.unavailable || response.launchFailed || response.timedOut
    || response.verdict === 'UNVERIFIED';
}

/**
 * Claude owns every proposal. Codex reviews the delivered version; after a
 * substantive answer and reconciliation, unresolved disputes follow the mode.
 * Writers run only after version-specific approval. The returned checkpoint
 * contains serializable state; persistence and validated resume belong to the
 * caller and do not require reconstructing messages from summaries.
 */
export async function runConversation({
  runId, reporter, rounds, tier, requirements = '', interactionMode = 'manual',
  seats = {}, strategy = {}, prelude = {}, continuation, humanRuling,
} = {}) {
  const authority = decisionAuthority({ interactionMode, phase: 'planning' });
  if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds < 1)) {
    throw new TypeError('rounds must be a positive integer');
  }
  const messages = [...(continuation?.messages ?? prelude.messages ?? [])], roundHistory = [...(continuation?.roundHistory ?? prelude.roundHistory ?? [])];
  let usageTotal = addUsage(EMPTY_USAGE, continuation?.usage ?? prelude.usage);
  let proposal = continuation?.proposal ?? null, artifactDigest = continuation?.artifactDigest ?? null, approval = null, pendingDecision = null;
  let openIssues = continuation?.openIssues ?? [], feedback = continuation?.feedback ?? '',
    artifactRepairs = continuation?.artifactRepairs ?? prelude.artifactRepairs ?? 0, revisionDigest = continuation?.revisionDigest ?? null;
  let initialAuthor = prelude.author;
  let round = continuation?.round ?? 0;
  const author = seats.author ?? seats.arbitrate;
  const reviewer = seats.reviewCodex;
  const renderProposal = value => value == null ? '' : strategy.proposalText?.(value) ?? value.plan ?? '';
  const snapshot = () => ({
    version: 1, phase: 'planning', tier, runId, interactionMode, authority,
    requirements: canonicalPlanningArtifact(requirements),
    proposal: canonicalPlanningArtifact(proposal), artifactDigest, approval,
    messages: canonicalPlanningArtifact(messages), openIssues: canonicalPlanningArtifact(openIssues),
    pendingDecision, round, roundsLimit: rounds ?? null, artifactRepairs,
    revisionDigest, feedback, usage: { ...usageTotal }, roundHistory,
    ...(continuation?.candidateState ? { candidateState: continuation.candidateState } : {}),
  });
  const finish = (reason, extra = {}) => {
    const result = {
      runId, interactionMode, approved: approval !== null,
      converged: approval?.basis === 'consensus', approval, reason, rounds: round,
      proposal, artifactDigest, messages, roundHistory, openIssues,
      tokens: { total: { ...usageTotal } }, checkpointState: snapshot(), ...extra,
    };
    reportEvent(reporter, runId, 'plan', 'finish', {
      tier, interactionMode, approved: result.approved, converged: result.converged,
      approval, reason, rounds: round,
    });
    return result;
  };
  const call = async (fn, request, speaker, role) => {
    let response;
    try {
      response = typeof fn === 'function' ? await fn(request) : {
        unavailable: true, error: `${speaker} ${role} is unavailable`,
      };
    } catch (error) {
      response = { unavailable: true, error: error instanceof Error ? error.message : String(error) };
    }
    if (response?.usage) usageTotal = addUsage(usageTotal, response.usage);
    const parsed = stance(response);
    const message = {
      speaker, role, phase: 'planning', turn: messages.length + 1, round,
      artifactDigest: request.artifactDigest ?? null,
      stance: unavailable(response) ? 'unavailable' : parsed.readable
        ? (parsed.agree ? 'agree' : 'disagree') : 'stance-unreadable',
      content: parsed.content, addressedIssueIds: parsed.addressedIssueIds ?? [],
      unresolvedQuestions: parsed.questions ?? [],
      transport: Object.fromEntries(['stderr', 'stdout', 'agentMessages', 'exitCode', 'launchFailed', 'timedOut', 'usage']
        .filter(key => response?.[key] !== undefined).map(key => [key, response[key]])),
      ...(response?.error ? { error: response.error } : {}),
      ...(parsed.decision ? { decision: parsed.decision, reason: parsed.reason } : {}),
    };
    messages.push(message);
    if (role === 'reviewer' || unavailable(response)) {
      reportEvent(reporter, runId, 'plan', role === 'author' ? 'proposal' : 'review', { tier, ...message });
    }
    return { response, parsed, message };
  };
  const repair = error => {
    approval = null;
    feedback = [error.message, 'Previous delivered response:', messages.at(-1)?.content ?? ''].join('\n');
    roundHistory.push({ round, repair: error.message });
    artifactRepairs++;
    return artifactRepairs <= MAX_ARTIFACT_REPAIRS;
  };
  const review = async (request) => {
    let answer = await call(reviewer, request, 'codex', 'reviewer');
    if (!unavailable(answer.response) && !answer.parsed.readable
      && !request.finalDecision && answer.parsed.content) {
      const repairedRequest = strategy.reviewRepairRequest?.({ request, content: answer.parsed.content })
        ?? { ...request, repairContent: answer.parsed.content };
      answer = await call(reviewer, { ...repairedRequest, messages: [...messages] }, 'codex', 'reviewer');
    }
    return answer;
  };
  const approvalFor = (basis, reason) => ({ artifactDigest, decidedBy: 'codex', basis, reason });

  if (continuation) {
    if (continuation.interactionMode !== 'manual' || interactionMode !== 'manual'
      || continuation.runId !== runId || planningArtifactDigest(requirements, proposal) !== artifactDigest) {
      throw new Error('invalid saved planning continuation');
    }
    const answer = humanRuling?.answers?.find(item => item.id === continuation.pendingDecision?.id)?.answer;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('missing human planning ruling');
    messages.push({ speaker: 'human', role: 'decision-authority', phase: 'planning',
      turn: messages.length + 1, round, stance: 'ruling', content: answer,
      artifactDigest, decisionId: humanRuling.decisionId });
    const disposition = /^(approve|revise|stop)(?:\s*:|\s*$)/i.exec(answer.trim())?.[1]?.toLowerCase();
    feedback = `Authoritative human ruling for the recorded dispute:\n${answer}\nContinue from the saved proposal; preserve unrelated requirements and issues.`;
    if (disposition === 'approve' || disposition === 'stop') {
      // Delivery is evidence, not a new veto over the human ruling on this version.
      const notice = { type: 'human-ruling', humanRuling, proposal, previousProposal: renderProposal(proposal),
        requirements, feedback, artifactDigest, round, interactionMode, phase: 'planning', messages: [...messages] };
      await call(author, notice, 'claude', 'author');
      await call(reviewer, { ...notice, messages: [...messages] }, 'codex', 'reviewer');
      if (disposition === 'stop') return finish('human-stopped');
      approval = { artifactDigest, decidedBy: 'human', basis: 'human', reason: answer,
        decisionId: humanRuling.decisionId };
      const written = await strategy.writeConverged?.(proposal);
      return finish('approved', written);
    }
    if (disposition === 'revise') revisionDigest = artifactDigest;
  }

  while (rounds === undefined || round < rounds) {
    round++;
    const previousProposal = renderProposal(proposal);
    const request = proposal === null
      ? strategy.draftRequest?.({ round, feedback })?.claudeRequest ?? { type: 'draft' }
      : strategy.proposeRequest?.({ round, feedback, questions: openIssues,
        previousProposal, drafts: [] }) ?? { type: 'propose', previousProposal };
    const authorRequest = {
      ...request, round, feedback, previousProposal, messages: [...messages],
      requirements, artifactDigest, interactionMode, phase: 'planning',
      reconciliation: round > 1,
    };
    // Candidate drafting already delivered and recorded the selected response.
    // Reuse that receipt once rather than invent another call or charge its usage twice.
    const reusedAuthor = initialAuthor !== undefined;
    const authored = reusedAuthor
      ? { ...initialAuthor, parsed: stance(initialAuthor.response) }
      : await call(author, authorRequest, 'claude', 'author');
    initialAuthor = undefined;
    if (unavailable(authored.response)) return finish('author-unavailable');
    let nextProposal;
    try { nextProposal = strategy.parseProposal(authored.response); }
    catch (error) {
      reportEvent(reporter, runId, 'plan', 'proposal', { tier, ...authored.message, parseError: error.message });
      if (!(error instanceof RepairableArtifactError)) return finish('author-unavailable', { error: error.message });
      if (!repair(error)) return finish('proposal-irreparable');
      round--;
      continue;
    }
    proposal = nextProposal;
    artifactDigest = planningArtifactDigest(requirements, proposal);
    authored.message.artifactDigest = artifactDigest;
    if (!reusedAuthor) reportEvent(reporter, runId, 'plan', 'proposal', { tier, ...authored.message });
    approval = null;
    if (revisionDigest === artifactDigest) {
      feedback = 'The reviewer required a revision, but the artifact bytes did not change. Implement the recorded revision.';
      if (++artifactRepairs > MAX_ARTIFACT_REPAIRS) return finish('proposal-irreparable');
      round--;
      continue;
    }
    revisionDigest = null;
    const reviewRequest = {
      ...(strategy.reviewRequests?.({ round, proposal })?.codex ?? { proposal }),
      round, artifactDigest, interactionMode, phase: 'planning', messages: [...messages],
      reconciliation: round > 1, openIssues,
    };
    let reviewed = await review(reviewRequest);
    if (unavailable(reviewed.response)) return finish('reviewer-unavailable');
    if (!reviewed.parsed.readable) return finish('stance-unreadable');
    if (reviewed.parsed.artifactDigest !== artifactDigest) return finish('stale-review');
    const currentIssues = [
      ...(reviewed.parsed.suggestions ?? []),
      ...(reviewed.parsed.questions ?? []),
    ].map(issue => ({ speaker: 'codex', ...issue }));
    const addressed = new Set(reviewed.parsed.addressedIssueIds ?? []);
    const retained = reviewed.parsed.agree ? [] : openIssues.filter(issue => !addressed.has(issue.id));
    const continuingDispute = retained.length > 0
      || currentIssues.some(issue => openIssues.some(previous => previous.id === issue.id))
      || currentIssues.length === 0 || !authored.parsed.agree;
    openIssues = [...new Map([...retained, ...currentIssues].map(issue => [issue.id, issue])).values()];
    roundHistory.push({
      round, artifactDigest, author: authored.message, reviews: { codex: reviewed.message },
    });
    if (authored.parsed.readable && authored.parsed.agree && reviewed.parsed.agree) {
      approval = approvalFor('consensus', reviewed.parsed.reason || 'Claude and Codex explicitly agree on this artifact.');
    } else {
      feedback = reviewed.parsed.content;
      // One author answer and one reviewer response constitute reconciliation.
      // This is a dispute routing point, not an implicit limit on allowed rounds.
      if (round > 1 && continuingDispute) {
        const question = 'Should this proposal be approved, revised, or stopped? Resolve the retained Claude and Codex positions.';
        if (authority === 'human') {
          pendingDecision = {
            id: `planning-${artifactDigest}`, phase: 'planning', artifactDigest,
            question, options: ['approve', 'revise', 'stop'],
            positions: { claude: authored.message.content, codex: reviewed.message.content },
            evidence: [], interactionMode,
          };
          return finish('needs-decision', { pendingDecision });
        }
        reviewed = await review({
          ...reviewRequest, finalDecision: true, question, messages: [...messages],
        });
        if (unavailable(reviewed.response)) return finish('reviewer-unavailable');
        if (reviewed.parsed.artifactDigest !== artifactDigest) return finish('stale-review');
        if (!['approve', 'revise', 'stop'].includes(reviewed.parsed.decision)
          || !reviewed.parsed.reason?.trim()) return finish('decision-unreadable');
        if (reviewed.parsed.decision === 'stop') return finish('reviewer-stopped');
        if (reviewed.parsed.decision === 'revise') {
          revisionDigest = artifactDigest;
          feedback = reviewed.parsed.reason + '\n' + reviewed.parsed.content;
          continue;
        }
        approval = approvalFor('reviewer', reviewed.parsed.reason);
      }
    }
    if (approval) {
      let written;
      try { written = await strategy.writeConverged?.(proposal); }
      catch (error) {
        if (!(error instanceof RepairableArtifactError)) throw error;
        if (!repair(error)) return finish('proposal-irreparable');
        continue;
      }
      reportEvent(reporter, runId, 'plan', 'agreement', {
        tier, artifactDigest, approval, approved: true, converged: approval.basis === 'consensus',
      });
      return finish(approval.basis === 'consensus' ? 'converged' : 'approved', written);
    }
  }
  return finish('rounds-exhausted');
}
