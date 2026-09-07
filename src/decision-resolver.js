import { decisionAuthority } from './decision-policy.js';
import { WAIT_NOT_ACKNOWLEDGED } from './interaction-signals.js';
import { parseDecisionJudgement } from './arbiter.js';

export function operatorPresenceEvidence({
  ttyAttached = process.stdin.isTTY === true,
  invocation = ttyAttached ? 'interactive' : 'non-interactive',
} = {}) {
  const waitSignal = ttyAttached ? null : WAIT_NOT_ACKNOWLEDGED;
  return {
    ttyAttached,
    invocation,
    operatorWait: waitSignal === WAIT_NOT_ACKNOWLEDGED ? 'not-acknowledged' : 'available',
  };
}

export function createAutonomousDecisionResolver(options = {}) {
  const phase = options.phase ?? 'execution';
  const interactionMode = options.interactionMode ?? 'autonomous';
  const decidedBy = decisionAuthority({ interactionMode, phase });
  // Keep the execution arbiter alias while its call site migrates to reviewer.
  const reviewer = options.reviewer ?? (phase === 'execution' ? options.arbiter : undefined);
  return async ({ questions, plan, artifactDigest, messages = [] }) => {
    if (!Array.isArray(questions) || questions.length === 0 || decidedBy === 'human'
      || typeof reviewer !== 'function') return { answers: [] };
    const answers = [], decisions = [];
    for (const question of questions) {
      let response;
      try { response = await reviewer({ type: 'decision', phase, interactionMode,
        question, plan, artifactDigest, messages }); }
      catch { return { answers: [] }; }
      const judgement = parseDecisionJudgement(response);
      if (judgement.verdict !== 'answered') return { answers: [] };
      answers.push({ id: question.id, answer: judgement.answer });
      decisions.push({ question, response, reason: judgement.reason ?? '' });
    }
    return { answers, decidedBy, role: 'reviewer', basis: 'reviewer', phase,
      interactionMode, artifactDigest, decisions };
  };
}
