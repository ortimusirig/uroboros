import { escapeHtml, oneLine } from './dashboard-transcript.js';

const COLUMNS = [
  {
    key: 'running',
    title: 'Running',
    outcomes: new Set([null, undefined]),
    empty: 'No running runs.',
  },
  {
    key: 'needs-decision',
    title: 'Needs decision',
    outcomes: new Set(['needs-decision', 'needs-pivot', 'conflicting-intent']),
    empty: 'No runs need a decision.',
  },
  {
    key: 'failed',
    title: 'Failed',
    outcomes: new Set(['gate-failed', 'executor-failed', 'timed-out', 'verifier-failed']),
    empty: 'No failed runs.',
  },
  {
    key: 'review-ready',
    title: 'Review ready',
    outcomes: new Set(['review-ready']),
    empty: 'No runs are ready for review.',
  },
  {
    key: 'no-change',
    title: 'No change',
    outcomes: new Set(['no-op']),
    empty: 'No runs ended without changes.',
  },
];

function columnFor(outcome) {
  return COLUMNS.find((column) => column.outcomes.has(outcome))?.key ?? 'running';
}

function timestamp(run) {
  for (const value of [run.endTs, run.lastEventTs, run.startTs]) {
    const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function newestFirst(left, right) {
  const timeDifference = timestamp(right) - timestamp(left);
  if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
  return String(right.runId ?? '').localeCompare(String(left.runId ?? ''));
}

function shortRunId(runId) {
  const value = oneLine(runId);
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-7)}`;
}

function outcomeTone(outcome) {
  if (outcome === 'review-ready' || outcome === 'no-op') return 'passed';
  if (columnFor(outcome) === 'failed') return 'failed';
  return 'pending';
}

function verifierVerdict(verifier) {
  if (verifier === null || verifier === undefined) return 'Pending';
  if (verifier.verdictSource === 'none') return 'No verdict — unknown';
  return oneLine(verifier.verdict) || 'Unknown';
}

function verifierTone(verifier) {
  if (verifier === null || verifier === undefined) return 'pending';
  if (verifier.verdictSource === 'none') return 'unknown';
  if (verifier.verdict === 'NO_BLOCKERS') return 'clean';
  if (verifier.verdict === 'ISSUES') return 'issues';
  return 'pending';
}

function verifierConsensus(verifiers = {}) {
  const correctness = verifiers.correctness;
  const intent = verifiers.intent;
  if (correctness?.verdict == null || intent?.verdict == null) {
    return { kind: 'pending', label: 'Seats pending' };
  }
  const correctnessUnavailable = correctness.verdictSource === 'none';
  const intentUnavailable = intent.verdictSource === 'none';
  if (correctnessUnavailable && intentUnavailable) {
    return { kind: 'pending', label: 'Seats unavailable' };
  }
  if (correctnessUnavailable !== intentUnavailable || correctness.verdict !== intent.verdict) {
    return { kind: 'disagreement', label: 'Seats disagree' };
  }
  return { kind: 'agreement', label: 'Seats agree' };
}

function elapsed(startTs, endTs) {
  const start = typeof startTs === 'string' ? Date.parse(startTs) : Number.NaN;
  const end = typeof endTs === 'string' ? Date.parse(endTs) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function countLabel(count) {
  return `${count} ${count === 1 ? 'run' : 'runs'}`;
}

function renderMetric(key, label, value, { tone = null, verifierSeat = null } = {}) {
  const resultClass = tone === null ? '' : ` class="result ${tone}"`;
  const seat = verifierSeat === null ? '' : ` data-verifier-seat="${verifierSeat}"`;
  return `<span class="board-metric" data-board-metric="${key}">`
    + `<span>${label}</span><span${resultClass}${seat}>${escapeHtml(value)}</span></span>`;
}

function renderCard(run) {
  const runId = oneLine(run.runId);
  const title = oneLine(run.title);
  const outcome = oneLine(run.outcome) || 'running';
  const tone = outcomeTone(run.outcome);
  const consensus = verifierConsensus(run.verifiers);
  const identity = title
    ? `<strong>${escapeHtml(title)}</strong><code title="${escapeHtml(runId)}">${escapeHtml(shortRunId(runId))}</code>`
    : `<strong><code title="${escapeHtml(runId)}">${escapeHtml(shortRunId(runId))}</code></strong>`;
  const gateResult = oneLine(run.gateResult) || 'pending';
  const gateTone = gateResult === 'passed' ? 'passed'
    : gateResult === 'failed' ? 'failed' : 'pending';
  const rounds = Number.isSafeInteger(run.debateRoundCount) && run.debateRoundCount > 0
    ? renderMetric('rounds', 'Rounds', run.debateRoundCount) : '';
  const tokenTotal = typeof run.tokenTotal === 'number' && Number.isFinite(run.tokenTotal)
    ? Math.max(0, Math.floor(run.tokenTotal)) : 0;
  return `<article class="board-card ${tone}" data-run-id="${escapeHtml(runId)}" data-verifier-consensus="${consensus.kind}">`
    + `<button type="button" class="board-card-select" data-board-run="${escapeHtml(runId)}">`
    + `<span class="board-card-identity">${identity}</span>`
    + `<span class="board-outcome ${tone}">${escapeHtml(outcome)}</span>`
    + `<strong class="board-consensus ${consensus.kind}">${consensus.label}</strong>`
    + '<span class="board-metrics">'
    + renderMetric('gate', 'Gate', gateResult, { tone: gateTone })
    + renderMetric('correctness', 'Correctness', verifierVerdict(run.verifiers?.correctness), {
      tone: verifierTone(run.verifiers?.correctness), verifierSeat: 'correctness',
    })
    + renderMetric('intent', 'Intent', verifierVerdict(run.verifiers?.intent), {
      tone: verifierTone(run.verifiers?.intent), verifierSeat: 'intent',
    })
    + rounds
    + renderMetric('elapsed', 'Elapsed', elapsed(run.startTs, run.endTs))
    + renderMetric('tokens', 'Tokens', tokenTotal.toLocaleString('en-US'))
    + '</span></button></article>';
}

export function renderDashboardBoard(snapshot) {
  const grouped = new Map(COLUMNS.map((column) => [column.key, []]));
  for (const run of Array.isArray(snapshot?.runs) ? snapshot.runs : []) {
    grouped.get(columnFor(run.outcome)).push(run);
  }
  const columns = COLUMNS.map((definition) => {
    const runs = grouped.get(definition.key).toSorted(newestFirst);
    const body = runs.length === 0
      ? `<p class="board-empty">${definition.empty}</p>`
      : runs.map(renderCard).join('');
    return `<section class="board-column" data-board-column="${definition.key}">`
      + `<header><h2>${definition.title}</h2><span aria-label="${countLabel(runs.length)}">${runs.length}</span></header>`
      + `${body}</section>`;
  }).join('\n');
  return '<section class="board" data-dashboard-view="board">\n'
    + '<div class="board-grid">\n'
    + `${columns}\n`
    + '</div>\n</section>\n';
}
