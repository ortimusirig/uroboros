import { escapeHtml, oneLine } from './dashboard-transcript.js';
import {
  DASHBOARD_FILTERS,
  DEFAULT_DASHBOARD_FILTER,
  dashboardFilterCounts,
  filterDashboardRuns,
} from './dashboard-filters.js';

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
    outcomes: new Set(['executor-failed', 'timed-out', 'verifier-failed']),
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

function reviewValue(review) {
  if (review === null || review === undefined) return 'Pending';
  if (review.reported !== true) return review.timedOut ? 'Timed out' : 'No report';
  if (review.blocking > 0) return `${review.blocking} blocking`;
  if (review.findings > 0) return `${review.findings} finding(s)`;
  return 'No findings';
}

function reviewTone(review) {
  if (review === null || review === undefined) return 'pending';
  if (review.reported !== true) return 'unknown';
  return review.blocking > 0 ? 'issues' : 'clean';
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
  const identity = title
    ? `<strong>${escapeHtml(title)}</strong><code title="${escapeHtml(runId)}">${escapeHtml(shortRunId(runId))}</code>`
    : `<strong><code title="${escapeHtml(runId)}">${escapeHtml(shortRunId(runId))}</code></strong>`;
  const gateResult = oneLine(run.gateResult) || 'pending';
  const rounds = Number.isSafeInteger(run.debateRoundCount) && run.debateRoundCount > 0
    ? renderMetric('rounds', 'Rounds', run.debateRoundCount) : '';
  const tokenTotal = typeof run.tokenTotal === 'number' && Number.isFinite(run.tokenTotal)
    ? Math.max(0, Math.floor(run.tokenTotal)) : 0;
  return `<article class="board-card ${tone}" data-run-id="${escapeHtml(runId)}">`
    + `<button type="button" class="board-card-select" data-board-run="${escapeHtml(runId)}">`
    + `<span class="board-card-identity">${identity}</span>`
    + `<span class="board-outcome ${tone}">${escapeHtml(outcome)}</span>`
    + '<span class="board-metrics">'
    + renderMetric('evidence', 'Evidence', gateResult)
    + renderMetric('review', 'Review', reviewValue(run.review), {
      tone: reviewTone(run.review), verifierSeat: 'review',
    })
    + rounds
    + renderMetric('elapsed', 'Elapsed', elapsed(run.startTs, run.endTs))
    + renderMetric('tokens', 'Tokens', tokenTotal.toLocaleString('en-US'))
    + '</span></button></article>';
}

export function renderDashboardBoard(snapshot, selectedFilter = DEFAULT_DASHBOARD_FILTER) {
  const grouped = new Map(COLUMNS.map((column) => [column.key, []]));
  const visibleRuns = filterDashboardRuns(snapshot, selectedFilter);
  for (const run of visibleRuns) {
    grouped.get(columnFor(run.outcome)).push(run);
  }
  const filterCounts = dashboardFilterCounts(snapshot);
  const filters = DASHBOARD_FILTERS.map(({ key, label }) => (
    `<button type="button" data-board-filter="${key}" data-filter-count="${filterCounts[key]}"`
    + ` aria-pressed="${selectedFilter === key}">${label} <span>${filterCounts[key]}</span></button>`
  )).join('');
  const total = filterCounts.all;
  const summary = visibleRuns.length < total
    ? `<p class="board-filter-summary" data-board-summary>showing ${visibleRuns.length} of ${total}</p>`
    : '';
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
    + `<nav class="board-filters" aria-label="Filter runs">${filters}</nav>\n`
    + `${summary}`
    + '<div class="board-grid">\n'
    + `${columns}\n`
    + '</div>\n</section>\n';
}

export function renderDashboardBoards(snapshot) {
  return Object.fromEntries(DASHBOARD_FILTERS.map(({ key }) => [
    key,
    renderDashboardBoard(snapshot, key),
  ]));
}
