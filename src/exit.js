// Outcome -> process exit code.
//
// Kept out of bin/loop.js because that module self-executes on import and so
// cannot be unit tested. Only review-ready and no-op are successes. verifier-failed
// marks a failed verification launch; executor-failed marks a crashed or aborted
// executor that wrote nothing.
export const EXIT_BY_OUTCOME = {
  'review-ready': 0,
  'no-op': 0,
  'gate-failed': 1,
  'verifier-failed': 4,
  'timed-out': 5,
  'campaign-failed': 6,
  'budget-exhausted': 7,
  'conflicting-intent': 8,
  'needs-decision': 9,
  'executor-failed': 10,
};

// An unrecognised outcome is not a success. Defaulting to 0 here would recreate
// the original bug for any outcome added later.
export const EXIT_UNKNOWN_OUTCOME = 3;

export function exitCodeFor(outcome) {
  return Object.prototype.hasOwnProperty.call(EXIT_BY_OUTCOME, outcome)
    ? EXIT_BY_OUTCOME[outcome]
    : EXIT_UNKNOWN_OUTCOME;
}
