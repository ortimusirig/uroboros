import { WAIT_NOT_ACKNOWLEDGED } from './interaction-signals.js';

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

  return async ({ questions }) => {
    if (!Array.isArray(questions) || questions.length === 0) return { answers: [] };
    if (questions.some((question) => (
      typeof question?.recommendation !== 'string' || question.recommendation.trim() === ''
    ))) {
      return { answers: [] };
    }

    const hasAuthorityQuestion = questions.some((question) => question.kind === 'authority');
    if (hasAuthorityQuestion && presenceEvidence.ttyAttached) return { answers: [] };

    const answers = questions.map((question) => ({
      id: question.id,
      answer: question.recommendation.trim(),
    }));
    if (!hasAuthorityQuestion) return { answers };

    return {
      answers,
      escalation: 'operator-absent',
      presenceEvidence,
      reasoning: 'No TTY was attached and the run was invoked non-interactively, so no '
        + 'operator was available to answer. The executor recommendations were adopted only '
        + 'inside the isolated worktree for later operator review.',
    };
  };
}
