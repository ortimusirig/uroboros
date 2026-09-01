import { decodeRecordedText } from './execution-record.js';
import { DEFAULT_DASHBOARD_FILTER, filterDashboardRuns } from './dashboard-filters.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function oneLine(value) {
  return String(value ?? '').replace(/[\r\n\u0000]+/g, ' ').trim();
}

function runStateLabel(state) {
  if (state === 'running') return 'Live';
  if (state === 'finished') return 'Finished';
  if (state === 'error') return 'Read error';
  return 'Waiting';
}

function mostRecentRun(runs) {
  return runs.reduce((latest, run) => {
    if (latest === null) return run;
    const runTime = Date.parse(run.lastEventTs ?? run.startTs ?? '');
    const latestTime = Date.parse(latest.lastEventTs ?? latest.startTs ?? '');
    if (!Number.isFinite(runTime)) return latest;
    return !Number.isFinite(latestTime) || runTime > latestTime ? run : latest;
  }, null);
}

function selectDefaultRun(runs) {
  return mostRecentRun(runs.filter((run) => run.state === 'running'))
    ?? mostRecentRun(runs.filter((run) => run.state === 'waiting'))
    ?? runs[0]
    ?? null;
}

function renderRunPicker(runs, selectedRunId) {
  if (runs.length === 0) {
    return '<label class="run-picker-label">Run <select id="run-picker" disabled>'
      + '<option selected>No runs discovered</option></select></label>';
  }
  const options = runs.map((run) => {
    const selected = run.runId === selectedRunId ? ' selected' : '';
    return `<option value="${escapeHtml(run.runId)}"${selected}>`
      + `${escapeHtml(run.runId)} — ${escapeHtml(runStateLabel(run.state))}</option>`;
  }).join('');
  return `<label class="run-picker-label">Run <select id="run-picker">${options}</select></label>`;
}

function renderPlan(run) {
  if (run.taskBody === null || run.taskBody === undefined) {
    return '<p class="muted">TASK.md is not available for this run.</p>';
  }
  return `<pre class="prose">${escapeHtml(run.taskBody)}</pre>`;
}

function shortTime(ts) {
  const parsed = typeof ts === 'string' ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(11, 19) : '--:--:--';
}

function renderTime(event) {
  return `<time datetime="${escapeHtml(event.ts ?? '')}">${escapeHtml(shortTime(event.ts))}</time>`;
}

function decodeEventText(event, field = 'text') {
  const encodingField = field === 'output' ? 'outputEncoding' : 'textEncoding';
  const truncatedField = field === 'output' ? 'outputTruncated' : 'textTruncated';
  return decodeRecordedText({
    text: event[field],
    encoding: event[encodingField],
    truncated: event[truncatedField],
  });
}

function renderReasoning(event) {
  const decoded = decodeEventText(event);
  const body = decoded.text === '' ? '<p>Reasoning step completed.</p>'
    : `<pre>${escapeHtml(decoded.text)}</pre>`;
  return '<li class="transcript-row reasoning-row">'
    + renderTime(event)
    + '<details class="transcript-reasoning muted"><summary>Executor reasoning'
    + `${decoded.truncated ? ' · truncated' : ''}</summary>${body}</details></li>`;
}

function renderAgentMessage(event) {
  const decoded = decodeEventText(event);
  const text = decoded.text || '(empty agent message)';
  return '<li class="transcript-row agent-row">'
    + renderTime(event)
    + '<div class="transcript-agent-message"><strong>Executor</strong>'
    + `<pre>${escapeHtml(text)}</pre>`
    + `${decoded.truncated ? '<small>Recorded text was truncated.</small>' : ''}</div></li>`;
}

function renderFileEdit(event) {
  const file = oneLine(event.file) || 'Unknown file';
  return '<li class="transcript-row file-row">'
    + renderTime(event)
    + `<button type="button" class="transcript-file" data-file-diff="${escapeHtml(file)}">`
    + '<span>File edit</span><code>' + escapeHtml(file) + '</code></button></li>';
}

function renderCommand(event) {
  const command = oneLine(event.command) || '(command not recorded)';
  const code = Number.isInteger(event.exitCode) ? String(event.exitCode) : '?';
  const exitClass = event.exitCode === 0 ? 'exit-ok' : 'exit-fail';
  const decoded = decodeEventText(event, 'output');
  const output = decoded.text === '' ? ''
    : '<details class="command-output"><summary>Recorded output'
      + `${decoded.truncated ? ' · truncated' : ''}</summary>`
      + `<pre>${escapeHtml(decoded.text)}</pre></details>`;
  return '<li class="transcript-row command-row">'
    + renderTime(event)
    + '<div class="transcript-command"><div class="command-heading">'
    + `<code>${escapeHtml(command)}</code><span class="${exitClass}">exit ${escapeHtml(code)}</span>`
    + `</div>${output}</div></li>`;
}

function renderError(event) {
  return '<li class="transcript-row error-row">'
    + renderTime(event)
    + `<div class="transcript-error"><strong>Executor error</strong><p>${escapeHtml(event.errorMessage ?? 'Unknown error')}</p></div></li>`;
}

function renderDecision(event) {
  if (event.type === 'challenged') {
    const questions = event.questions.length === 0
      ? [{ id: null, kind: null, question: 'Decision requested.' }]
      : event.questions;
    return questions.map((question) => {
      const author = oneLine(question.askedBy ?? event.askedBy ?? event.author) || 'Executor';
      const metadata = [question.id, question.kind].filter((value) => value).map(oneLine).join(' · ');
      const options = Array.isArray(question.options) ? question.options.join(' · ') : question.options;
      return '<li class="transcript-row decision-row">'
        + renderTime(event)
        + '<div class="decision-question"><strong>' + escapeHtml(author) + '</strong>'
        + `${metadata ? `<small>${escapeHtml(metadata)}</small>` : ''}`
        + `<p>${escapeHtml(question.question ?? 'Decision requested.')}</p>`
        + `${options ? `<p class="decision-options">Options: ${escapeHtml(options)}</p>` : ''}`
        + `${question.recommendation ? `<p class="decision-recommendation">Recommendation: ${escapeHtml(question.recommendation)}</p>` : ''}`
        + '</div></li>';
    }).join('');
  }
  const answers = event.answers.length === 0
    ? [{ id: null, answer: 'Decision resolved.' }]
    : event.answers;
  return answers.map((answer) => {
    const author = oneLine(answer.answeredBy ?? answer.author ?? event.answeredBy ?? event.author)
      || 'Planner';
    return '<li class="transcript-row decision-row">'
      + renderTime(event)
      + '<div class="decision-answer"><strong>' + escapeHtml(author) + '</strong>'
      + `${answer.id ? `<small>${escapeHtml(oneLine(answer.id))}</small>` : ''}`
      + `<p>${escapeHtml(answer.answer ?? 'Decision resolved.')}</p></div></li>`;
  }).join('');
}

function renderGenericEvent(event) {
  const label = `${oneLine(event.stage) || 'unknown'}/${oneLine(event.type) || 'unknown'}`;
  const facts = [
    event.attempt === null ? '' : `attempt ${event.attempt}`,
    event.verdict ? `verdict ${oneLine(event.verdict)}` : '',
  ].filter(Boolean).join(' · ');
  return '<li class="transcript-row event-row">'
    + renderTime(event)
    + `<div class="transcript-event"><strong>${escapeHtml(label)}</strong>`
    + `${facts ? `<small>${escapeHtml(facts)}</small>` : ''}</div></li>`;
}

function renderGate(run, event) {
  const commands = run.gateCommands.length === 0
    ? '<p class="muted">No gate commands recorded.</p>'
    : '<ul>' + run.gateCommands.map((command) => {
      const line = oneLine([command.bin, ...command.args].filter(Boolean).join(' '));
      const code = command.code ?? '?';
      const exitClass = command.code === 0 ? 'exit-ok' : 'exit-fail';
      return `<li><code>${escapeHtml(line)}</code><span class="${exitClass}">exit ${escapeHtml(code)}`
        + `${command.timedOut ? ' · timed out' : ''}</span></li>`;
    }).join('') + '</ul>';
  const resultClass = run.gateResult === 'passed' ? 'passed'
    : run.gateResult === 'failed' ? 'failed' : 'pending';
  return `<li class="gate-seam"><section class="transcript-gate ${resultClass}">`
    + '<header><span>Evidence</span>'
    + `<strong>${escapeHtml(run.gateResult)}</strong>${renderTime(event)}</header>`
    + commands + '</section></li>';
}

function reviewClass(review) {
  if (review === null || review === undefined) return 'pending';
  if (review.reported !== true) return 'unknown';
  return (review.blocking ?? 0) > 0 ? 'issues' : 'clean';
}

function reviewValue(review) {
  if (review === null || review === undefined) return 'Pending';
  if (review.reported !== true) return review.timedOut ? 'Timed out' : 'No report';
  if ((review.blocking ?? 0) > 0) return `${review.blocking} blocking`;
  if ((review.findings ?? 0) > 0) return `${review.findings} finding(s)`;
  return 'No findings';
}

function renderReviewSeat(review, event = {}) {
  return '<li class="transcript-row verifier-row">'
    + renderTime(event)
    + `<div class="transcript-verifier-seat ${reviewClass(review)}" data-verifier-seat="review">`
    + `<strong>Review</strong><span>${escapeHtml(reviewValue(review))}</span></div></li>`;
}

function renderVerifierInspector(run) {
  const review = run.review;
  if (review === null || review === undefined || review.reported !== true) {
    return '<article class="verifier-report pending" data-verifier-report="review">'
      + `<header><strong>Review report</strong><span>${escapeHtml(reviewValue(review))}</span></header></article>`;
  }
  const findings = review.findingsList ?? [];
  const items = findings
    .map((finding) => `<li><strong>${escapeHtml(finding.id ?? '?')}</strong> [${escapeHtml(finding.severity ?? 'unknown')}] ${escapeHtml(finding.description ?? '')}</li>`)
    .join('');
  return `<article class="verifier-report ${reviewClass(review)}" data-verifier-report="review">`
    + `<header><strong>Review report</strong><span>${escapeHtml(reviewValue(review))}</span></header>`
    + (findings.length === 0
      ? '<p class="muted">The reviewer reported no findings.</p>'
      : `<ul class="verifier-findings">${items}</ul>`)
    + '</article>';
}

function renderTimeline(run) {
  if (run.timeline.length === 0) {
    return `<p class="empty">${escapeHtml(run.message ?? 'No events yet.')}</p>`;
  }
  let renderedReview = false;
  let renderedGate = false;
  const steps = [];
  for (const event of run.timeline) {
    if (event.stage === 'gate') {
      if (!renderedGate) {
        renderedGate = true;
        steps.push(renderGate(run, event));
      }
      continue;
    }
    if (event.stage === 'verify' && event.pass === 'review') {
      if (!renderedReview) {
        renderedReview = true;
        steps.push(renderReviewSeat(run.review, event));
      }
      continue;
    }
    if (event.stage === 'decision' && (event.type === 'challenged' || event.type === 'resolved')) {
      steps.push(renderDecision(event));
      continue;
    }
    if (event.stage === 'executor' && event.type === 'file_change') {
      steps.push(renderFileEdit(event));
      continue;
    }
    if (event.stage === 'executor' && event.type === 'item_completed') {
      if (event.itemType === 'reasoning') steps.push(renderReasoning(event));
      else if (event.itemType === 'agent_message') steps.push(renderAgentMessage(event));
      else if (event.itemType === 'command_execution') steps.push(renderCommand(event));
      else if (event.itemType === 'error') steps.push(renderError(event));
      else steps.push(renderGenericEvent(event));
      continue;
    }
    steps.push(renderGenericEvent(event));
  }
  if (!renderedGate && (run.gateCommands.length > 0 || run.gateResult !== 'pending')) {
    steps.push(renderGate(run, {}));
  }
  if (!renderedReview && run.review !== null && run.review !== undefined) {
    steps.push(renderReviewSeat(run.review));
  }
  return `<ol class="transcript-steps">${steps.join('')}</ol>`;
}

function renderInspector(run, renderDiff) {
  const diff = typeof renderDiff === 'function'
    ? renderDiff(run.diff, run.worktreeDirectory)
    : '<p class="muted">Diff unavailable.</p>';
  return '<aside class="inspector-pane" aria-label="Run inspector">'
    + '<nav class="inspector-tabs" aria-label="Inspector views">'
    + '<button type="button" data-inspector-tab="diff" aria-pressed="true">Diff</button>'
    + '<button type="button" data-inspector-tab="plan" aria-pressed="false">Plan</button>'
    + '<button type="button" data-inspector-tab="verifier" aria-pressed="false">Verifier</button>'
    + '</nav>'
    + `<section data-inspector-panel="diff">${diff}</section>`
    + `<section data-inspector-panel="plan" hidden>${renderPlan(run)}</section>`
    + `<section data-inspector-panel="verifier" hidden>${renderVerifierInspector(run)}</section>`
    + '</aside>';
}

export function renderRunTranscript(run, renderDiff) {
  if (!run) {
    return '<div class="transcript-layout"><section class="transcript-pane">'
      + '<p class="empty">No run is available yet.</p></section>'
      + '<aside class="inspector-pane"><p class="muted">Nothing to inspect.</p></aside></div>';
  }
  return '<div class="transcript-layout">'
    + '<section class="transcript-pane" aria-label="Live run transcript">'
    + `<header class="run-heading"><div><h2>${escapeHtml(run.title ?? run.runId)}</h2>`
    + `<p>${escapeHtml(run.runId)}</p></div><span class="state ${escapeHtml(run.state)}">`
    + `${escapeHtml(runStateLabel(run.state))}</span></header>${renderTimeline(run)}</section>`
    + renderInspector(run, renderDiff) + '</div>';
}

export function renderTranscriptDashboard(
  snapshot,
  renderDiff,
  selectedFilter = DEFAULT_DASHBOARD_FILTER,
) {
  const allRuns = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const filteredRuns = filterDashboardRuns(snapshot, selectedFilter);
  // Prefer the FILTERED runs, exactly as the client's defaultRunId does.
  // Selecting from allRuns first picked the newest run overall, which under the
  // default attention filter is often a clean review-ready the board omits — so
  // first paint showed a transcript for a run absent from the board beside it.
  // The client never corrects this: syncPicker keeps the server's value once
  // state.runId is set.
  //
  // The fallback to allRuns is deliberate and must stay: when nothing matches
  // the filter the board is empty by design, and a blank transcript beside it
  // is worse than showing the newest run.
  const selected = selectDefaultRun(filteredRuns) ?? selectDefaultRun(allRuns);
  const runs = selected && !filteredRuns.some((run) => run.runId === selected.runId)
    ? [...filteredRuns, selected]
    : filteredRuns;
  const message = snapshot.message
    ? `<p class="empty source-message">${escapeHtml(snapshot.message)}</p>`
    : '';
  return '<section data-dashboard-view="transcript">'
    + '<header class="transcript-header">'
    + renderRunPicker(runs, selected?.runId ?? null)
    + '<small>Read-only · updates live</small></header>'
    + message
    + `<div id="transcript-body">${renderRunTranscript(selected, renderDiff)}</div>`
    + '</section>\n';
}
