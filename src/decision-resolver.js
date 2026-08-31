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
  const presenceEvidence = operatorPresenceEvidence(options);
  const arbiter = options.arbiter;

  return async ({ questions, plan }) => {
    if (!Array.isArray(questions) || questions.length === 0) return { answers: [] };

    const hasAuthorityQuestion = questions.some((question) => question.kind === 'authority');
    if (hasAuthorityQuestion && presenceEvidence.ttyAttached) return { answers: [] };
    if (typeof arbiter !== 'function') return { answers: [] };
    const answers = [];
    for (const question of questions) {
      let response;
      try { response = await arbiter({ type: 'decision', question, plan }); }
      catch { return { answers: [] }; }
      const judgement = parseDecisionJudgement(response);
      if (judgement.verdict !== 'answered') return { answers: [] };
      answers.push({ id: question.id, answer: judgement.answer });
    }
    if (!hasAuthorityQuestion) return { answers };

    return {
      answers,
      escalation: 'operator-absent',
      presenceEvidence,
      reasoning: 'No TTY was attached and the run was invoked non-interactively, so no '
        + 'operator was available to answer. The read-only arbiter judged the challenge '
        + 'inside the isolated worktree for later operator review.',
    };
  };
}
