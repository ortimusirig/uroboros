export const DEFAULT_DASHBOARD_FILTER = 'needs-attention';

export const DASHBOARD_FILTERS = Object.freeze([
  Object.freeze({ key: 'needs-attention', label: 'Needs attention' }),
  Object.freeze({ key: 'active', label: 'Active' }),
  Object.freeze({ key: 'today', label: 'Today' }),
  Object.freeze({ key: 'all', label: 'All' }),
]);

const HUMAN_STOP_OUTCOMES = new Set([
  'needs-decision',
  'needs-pivot',
  'gate-failed',
  'executor-failed',
  'timed-out',
  'conflicting-intent',
]);

export function verifierSeatsDisagree(verifiers = {}) {
  const correctness = verifiers.correctness;
  const intent = verifiers.intent;
  if (correctness?.verdict == null || intent?.verdict == null) return false;
  const correctnessUnavailable = correctness.verdictSource === 'none';
  const intentUnavailable = intent.verdictSource === 'none';
  if (correctnessUnavailable && intentUnavailable) return false;
  return correctnessUnavailable !== intentUnavailable || correctness.verdict !== intent.verdict;
}

export function runNeedsAttention(run) {
  return runIsActive(run)
    || HUMAN_STOP_OUTCOMES.has(run?.outcome)
    || (run?.state === 'finished' && verifierSeatsDisagree(run.verifiers));
}

export function runIsActive(run) {
  return run?.state === 'running' || run?.state === 'waiting';
}

function utcDate(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

export function runStartedToday(run, observedAt) {
  const today = utcDate(observedAt);
  return today !== null && utcDate(run?.startTs) === today;
}

export function runMatchesDashboardFilter(run, selectedFilter, observedAt) {
  if (selectedFilter === 'all') return true;
  if (selectedFilter === 'active') return runIsActive(run);
  if (selectedFilter === 'today') return runStartedToday(run, observedAt);
  return runNeedsAttention(run);
}

export function filterDashboardRuns(snapshot, selectedFilter = DEFAULT_DASHBOARD_FILTER) {
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  return runs.filter((run) => runMatchesDashboardFilter(
    run,
    selectedFilter,
    snapshot?.observedAt,
  ));
}

export function dashboardFiltersForRun(run, observedAt) {
  return DASHBOARD_FILTERS
    .filter(({ key }) => runMatchesDashboardFilter(run, key, observedAt))
    .map(({ key }) => key);
}

export function dashboardFilterCounts(snapshot) {
  return Object.fromEntries(DASHBOARD_FILTERS.map(({ key }) => [
    key,
    filterDashboardRuns(snapshot, key).length,
  ]));
}
