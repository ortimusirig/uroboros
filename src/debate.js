export const PIVOT_AMEND = 'amend';
export const PIVOT_FRESH = 'fresh';
export const PIVOT_CONCLUDE = 'conclude';

const recordedRounds = new WeakMap();

export class DebateLedger {
  constructor() {
    recordedRounds.set(this, new Map());
  }

  record(round, findingIds) {
    recordedRounds.get(this).set(round, [...findingIds]);
  }

  round(round) {
    return [...(recordedRounds.get(this).get(round) ?? [])];
  }

  get currentRound() {
    const rounds = recordedRounds.get(this);
    if (rounds.size === 0) return 0;
    return Math.max(...rounds.keys());
  }

  allFindings() {
    const findings = new Set();
    for (const round of recordedRounds.get(this).values()) {
      for (const findingId of round) findings.add(findingId);
    }
    return findings;
  }

  resolvedFindings() {
    const resolved = this.allFindings();
    for (const findingId of this.round(this.currentRound)) resolved.delete(findingId);
    return resolved;
  }

  stuckFindings() {
    const rounds = lastThreeRounds(this);
    if (rounds === null) return new Set();

    return new Set(rounds[0].filter((findingId) =>
      rounds[1].includes(findingId) && rounds[2].includes(findingId)));
  }
}

function lastThreeRounds(ledger) {
  const latest = ledger.currentRound;
  const roundNumbers = [latest - 2, latest - 1, latest];
  const rounds = recordedRounds.get(ledger);
  if (!rounds || !roundNumbers.every((round) => rounds.has(round))) return null;
  return roundNumbers.map((round) => ledger.round(round));
}

export function detectCircling(ledger) {
  const rounds = lastThreeRounds(ledger);
  if (rounds === null || rounds[2].length === 0) return false;
  if (ledger.stuckFindings().size > 0) return true;

  const counts = rounds.map((round) => round.length);
  return !(counts[0] > counts[1] && counts[1] > counts[2]);
}

export function shouldPivot(pivotCount) {
  if (pivotCount === 0) return PIVOT_AMEND;
  if (pivotCount === 1) return PIVOT_FRESH;
  return PIVOT_CONCLUDE;
}
