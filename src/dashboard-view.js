import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { URO_DASHBOARD_MARKER } from './dashboard-config.js';
import { CAMPAIGN_EVENTS_FILENAME, readEventStream } from './event-stream.js';
import { resolveArtifact } from './artifacts.js';
import { renderDashboardBoard, renderDashboardBoards } from './dashboard-board.js';
import { DEFAULT_DASHBOARD_FILTER, dashboardFiltersForRun } from './dashboard-filters.js';
import { addUsage, EMPTY_USAGE } from './usage.js';
import {
  escapeHtml,
  renderRunTranscript,
  renderTranscriptDashboard,
} from './dashboard-transcript.js';

export const MAX_RENDERED_DIFF_BYTES = 128 * 1024;

const TASK_TITLE_MAX_LENGTH = 70;
const TASK_TITLE_MIN_PUNCTUATION_LENGTH = 20;

function emptyDiff() {
  return {
    path: null,
    text: '',
    byteCount: 0,
    renderedByteCount: 0,
    capped: false,
    message: 'CHANGES.diff is not available yet.',
  };
}

function emptyRun(directory, overrides = {}) {
  const run = {
    directory,
    worktreeDirectory: basename(directory).toLowerCase() === 'w'
      ? directory
      : join(directory, 'w'),
    eventsPath: null,
    runId: basename(directory),
    title: null,
    taskBody: null,
    state: 'waiting',
    message: 'Waiting for the event stream to appear.',
    startTs: null,
    endTs: null,
    currentStage: null,
    currentType: null,
    lastEventTs: null,
    timeline: [],
    review: null,
    gateCommands: [],
    gateResult: 'pending',
    outcome: null,
    debateRoundCount: 0,
    tokenTotal: 0,
    diff: emptyDiff(),
    ...overrides,
  };
  return run;
}

function readRunFacts(eventsPath) {
  if (eventsPath === null) return null;
  const factsPath = resolveArtifact(dirname(eventsPath), 'uro-runfacts.json');
  if (!existsSync(factsPath)) return null;
  try {
    const facts = JSON.parse(readFileSync(factsPath, { encoding: 'utf8', flag: 'r' }));
    return facts && typeof facts === 'object' && !Array.isArray(facts) ? facts : null;
  } catch {
    // Facts can be observed between truncate and the completed write. Retain the
    // event-derived state and pick up the complete document on the next poll.
    return null;
  }
}

function consistencyStatus(value) {
  if (typeof value === 'string') return value;
  return value?.status ?? null;
}

function enrichReviewFromFacts(review, facts) {
  if (facts === null) return review;
  const lastRound = facts.debate?.roundHistory?.at(-1) ?? null;
  if (lastRound === null) return review;
  return {
    ...(review ?? {}),
    reported: true,
    findings: (lastRound.findings ?? []).length,
    blocking: (lastRound.blockingFindingIds ?? []).length,
    findingsList: (lastRound.findings ?? []).map((finding) => ({ ...finding })),
  };
}

function readDiffPreview(worktreeDirectory, maxBytes = MAX_RENDERED_DIFF_BYTES) {
  const path = join(worktreeDirectory, 'CHANGES.diff');
  let byteCount;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return emptyDiff();
    byteCount = stat.size;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyDiff();
    return { ...emptyDiff(), path, message: `Cannot read CHANGES.diff: ${error.message}` };
  }

  const wanted = Math.min(byteCount, maxBytes);
  const buffer = Buffer.alloc(wanted);
  let descriptor;
  let offset = 0;
  try {
    descriptor = openSync(path, 'r');
    while (offset < wanted) {
      const count = readSync(descriptor, buffer, offset, wanted - offset, offset);
      if (count === 0) break;
      offset += count;
    }
  } catch (error) {
    return { ...emptyDiff(), path, byteCount, message: `Cannot read CHANGES.diff: ${error.message}` };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return {
    path,
    text: buffer.subarray(0, offset).toString('utf8'),
    byteCount,
    renderedByteCount: offset,
    capped: byteCount > offset,
    message: null,
  };
}

function validTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function firstTimestamp(events) {
  for (const event of events) {
    if (validTimestamp(event?.ts) !== null) return event.ts;
  }
  return null;
}

function lastTimestamp(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (validTimestamp(events[index]?.ts) !== null) return events[index].ts;
  }
  return null;
}

function usageTokenTotal(usage) {
  const input = typeof usage?.inputTokens === 'number' && Number.isFinite(usage.inputTokens)
    ? Math.max(0, usage.inputTokens) : 0;
  const output = typeof usage?.outputTokens === 'number' && Number.isFinite(usage.outputTokens)
    ? Math.max(0, usage.outputTokens) : 0;
  return input + output;
}

export function extractTaskTitle(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  let index = lines[0] === '# Task' ? 1 : 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (index === lines.length) return null;

  const explicitTitle = /^Title:\s*(.+)$/.exec(lines[index]);
  const candidate = explicitTitle ? explicitTitle[1] : lines[index];
  const title = candidate
    .replaceAll('`', '')
    .replace(/^#+(?:\s*Task\s*[:—-])?\s+/, '')
    .trim();
  if (title === '') return null;
  if (title.length <= TASK_TITLE_MAX_LENGTH) return title;

  const contentLimit = TASK_TITLE_MAX_LENGTH - 1;
  for (let punctuationIndex = contentLimit - 1;
    punctuationIndex >= TASK_TITLE_MIN_PUNCTUATION_LENGTH - 1;
    punctuationIndex--) {
    if (/[.:;—]/.test(title[punctuationIndex])) {
      return `${title.slice(0, punctuationIndex + 1).trimEnd()}…`;
    }
  }

  let wordBoundary = contentLimit;
  while (wordBoundary > 0 && !/\s/.test(title[wordBoundary])) wordBoundary -= 1;
  const truncated = wordBoundary > 0
    ? title.slice(0, wordBoundary).trimEnd()
    : title.slice(0, contentLimit).trimEnd();
  return `${truncated}…`;
}

function readTaskTitle(directory) {
  const taskPath = existsSync(join(directory, 'TASK.md'))
    ? join(directory, 'TASK.md')
    : join(directory, 'w', 'TASK.md');
  try {
    return extractTaskTitle(readFileSync(taskPath, { encoding: 'utf8', flag: 'r' }));
  } catch {
    return null;
  }
}

function readTaskBody(directory) {
  const taskPath = existsSync(join(directory, 'TASK.md'))
    ? join(directory, 'TASK.md')
    : join(directory, 'w', 'TASK.md');
  try {
    return readFileSync(taskPath, { encoding: 'utf8', flag: 'r' });
  } catch {
    return null;
  }
}

function digestRunDirectory(runDirectory) {
  const directory = resolve(runDirectory);
  const title = readTaskTitle(directory);
  const taskBody = readTaskBody(directory);
  let stream;
  try {
    stream = readEventStream(directory, { allowMissing: true });
  } catch (error) {
    return emptyRun(directory, {
      title,
      taskBody,
      state: 'error',
      message: `Cannot read event stream: ${error.message}`,
    });
  }

  if (!stream.directoryExists) {
    return emptyRun(directory, {
      runId: stream.runId,
      title,
      taskBody,
      message: `Run directory does not exist yet: ${directory}`,
    });
  }
  if (stream.eventsPath === null) {
    return emptyRun(directory, {
      runId: stream.runId,
      title,
      taskBody,
      message: `Run directory exists; waiting for events.jsonl: ${directory}`,
    });
  }

  const events = stream.events.filter((event) => event?.runId === stream.runId);
  let review = null;
  const gateCommands = [];
  let eventUsage = EMPTY_USAGE;
  let eventDebateRoundCount = 0;
  let gateResult = 'pending';

  for (const event of events) {
    eventUsage = addUsage(eventUsage, event.tokens);
    if (event.stage === 'debate' && Number.isSafeInteger(event.debateRound)) {
      eventDebateRoundCount = Math.max(eventDebateRoundCount, event.debateRound);
    }
    if (event.stage === 'verify' && event.type === 'finish' && event.pass === 'review') {
      review = {
        reported: false,
        code: event.code ?? null,
        timedOut: event.timedOut === true,
        ts: event.ts ?? null,
      };
    }
    if (event.stage === 'gate' && event.type === 'gate_command') {
      gateCommands.push({
        bin: event.bin ?? '',
        args: Array.isArray(event.args) ? event.args : [],
        code: event.code ?? null,
        attempt: event.attempt ?? null,
        timedOut: event.timedOut === true,
        ts: event.ts ?? null,
      });
    }
  }

  const facts = readRunFacts(stream.eventsPath);
  const completedReview = enrichReviewFromFacts(review, facts);
  const recordedTokenUsage = facts?.tokens?.total;
  const tokenUsage = recordedTokenUsage !== null && typeof recordedTokenUsage === 'object'
    && !Array.isArray(recordedTokenUsage)
    ? recordedTokenUsage : eventUsage;
  // The gate verdict is gone; evidence records carry the command results.
  if (gateResult === 'pending' && Array.isArray(facts?.evidence) && facts.evidence.length > 0) {
    gateResult = facts.evidence.some((entry) => entry.code !== 0) ? 'non-zero evidence' : 'evidence clean';
  }
  if (gateResult === 'pending' && gateCommands.some((command) => (
    command.timedOut || (command.code !== null && command.code !== 0)
  ))) {
    gateResult = 'non-zero evidence';
  }
  const lastEvent = events.at(-1) ?? null;
  const finished = events.some((event) => event.stage === 'report' && event.type === 'finish');
  const worktreeDirectory = dirname(stream.eventsPath);
  return {
    directory,
    worktreeDirectory,
    eventsPath: stream.eventsPath,
    runId: stream.runId,
    title,
    taskBody,
    state: finished ? 'finished' : events.length > 0 ? 'running' : 'waiting',
    message: events.length > 0 ? null : 'Event stream is empty; waiting for the first event.',
    startTs: firstTimestamp(events),
    endTs: lastTimestamp(events),
    currentStage: lastEvent?.stage ?? null,
    currentType: lastEvent?.type ?? null,
    lastEventTs: lastEvent?.ts ?? null,
    timeline: events.map((event) => ({
      ts: event.ts ?? null,
      stage: event.stage ?? 'unknown',
      type: event.type ?? 'unknown',
      attempt: event.attempt ?? null,
      pass: event.pass ?? null,
      verdict: event.verdict ?? null,
      itemType: typeof event.itemType === 'string' ? event.itemType : null,
      command: typeof event.command === 'string' ? event.command : null,
      exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
      output: typeof event.output === 'string' ? event.output : null,
      outputEncoding: typeof event.outputEncoding === 'string' ? event.outputEncoding : null,
      outputTruncated: event.outputTruncated === true,
      errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : null,
      text: typeof event.text === 'string' ? event.text : null,
      textEncoding: typeof event.textEncoding === 'string' ? event.textEncoding : null,
      textTruncated: event.textTruncated === true,
      file: typeof event.file === 'string' ? event.file : null,
      questions: Array.isArray(event.questions) ? event.questions.map((question) => ({
        id: typeof question?.id === 'string' ? question.id : null,
        kind: typeof question?.kind === 'string' ? question.kind : null,
        question: typeof question?.question === 'string' ? question.question : null,
        options: Array.isArray(question?.options)
          ? question.options.filter((option) => typeof option === 'string')
          : typeof question?.options === 'string' ? question.options : null,
        recommendation: typeof question?.recommendation === 'string'
          ? question.recommendation : null,
        askedBy: typeof question?.askedBy === 'string' ? question.askedBy : null,
      })) : [],
      answers: Array.isArray(event.answers) ? event.answers.map((answer) => ({
        id: typeof answer?.id === 'string' ? answer.id : null,
        answer: typeof answer?.answer === 'string' ? answer.answer : null,
        author: typeof answer?.author === 'string' ? answer.author : null,
        answeredBy: typeof answer?.answeredBy === 'string' ? answer.answeredBy : null,
      })) : [],
      author: typeof event.author === 'string' ? event.author : null,
      askedBy: typeof event.askedBy === 'string' ? event.askedBy : null,
      answeredBy: typeof event.answeredBy === 'string' ? event.answeredBy : null,
    })),
    review: completedReview,
    gateCommands,
    gateResult,
    outcome: typeof facts?.outcome === 'string' ? facts.outcome : null,
    debateRoundCount: Number.isSafeInteger(facts?.debate?.roundsRun)
      ? facts.debate.roundsRun : eventDebateRoundCount,
    tokenTotal: usageTokenTotal(tokenUsage),
    diff: readDiffPreview(worktreeDirectory),
  };
}

export function buildDashboardSnapshot({ runDirectory, scratchRoot } = {}) {
  if (Boolean(runDirectory) === Boolean(scratchRoot)) {
    throw new TypeError('dashboard requires exactly one of runDirectory or scratchRoot');
  }
  const observedAt = new Date().toISOString();
  if (runDirectory) {
    const sourcePath = resolve(runDirectory);
    const runs = [digestRunDirectory(sourcePath)];
    return { mode: 'run', sourcePath, observedAt, message: null, runs };
  }

  const sourcePath = resolve(scratchRoot);
  let entries;
  try {
    const stat = statSync(sourcePath);
    if (!stat.isDirectory()) {
      return {
        mode: 'scratch', sourcePath, observedAt,
        message: `Scratch root is not a directory: ${sourcePath}`,
        runs: [],
      };
    }
    entries = readdirSync(sourcePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        mode: 'scratch', sourcePath, observedAt,
        message: `Scratch root does not exist yet: ${sourcePath}`,
        runs: [],
      };
    }
    return {
      mode: 'scratch', sourcePath, observedAt,
      message: `Cannot read scratch root: ${error.message}`,
      runs: [],
    };
  }

  const runs = [];
  for (const entry of entries) {
    const directory = join(sourcePath, entry.name);
    const campaignPath = join(directory, CAMPAIGN_EVENTS_FILENAME);
    const hasCampaignStream = existsSync(campaignPath);
    const hasRunStream = existsSync(join(directory, 'events.jsonl'))
      || existsSync(join(directory, 'w', 'events.jsonl'));
    if (!hasCampaignStream || hasRunStream) runs.push(digestRunDirectory(directory));
  }
  return {
    mode: 'scratch',
    sourcePath,
    observedAt,
    message: runs.length === 0 ? 'No run directories found yet.' : null,
    runs,
  };
}

export function vscodeFileHref(path) {
  return `vscode://file${pathToFileURL(path).pathname}`;
}

function renderVsCodeLink(href) {
  return `<a href="${escapeHtml(href)}">Open in VS Code</a>`;
}

function diffPathFromMarkers(segment, fallbackPrevious = null, fallbackCurrent = null) {
  const previous = segment.match(/^--- (a\/[^\r\n]+|\/dev\/null)\r?$/m)?.[1] ?? null;
  const current = segment.match(/^\+\+\+ (b\/[^\r\n]+|\/dev\/null)\r?$/m)?.[1] ?? null;
  if (current?.startsWith('b/')) return current;
  if (current === '/dev/null' && previous?.startsWith('a/')) return previous;
  if (fallbackCurrent?.startsWith('b/')) return fallbackCurrent;
  return fallbackPrevious?.startsWith('a/') ? fallbackPrevious : null;
}

export function parseUnifiedDiff(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const boundaries = [...text.matchAll(/^diff --git a\/([^\r\n]+) b\/([^\r\n]+)\r?$/gm)];
  if (boundaries.length === 0) {
    return [{
      displayPath: diffPathFromMarkers(text),
      text,
    }];
  }
  return boundaries.map((boundary, index) => {
    const start = index === 0 ? 0 : boundary.index;
    const end = boundaries[index + 1]?.index ?? text.length;
    const segment = text.slice(start, end);
    return {
      displayPath: diffPathFromMarkers(
        segment,
        `a/${boundary[1]}`,
        `b/${boundary[2]}`,
      ),
      text: segment,
    };
  });
}

function renderDiffLines(text) {
  return text.split(/(?<=\n)/).map((line) => {
    const bare = line.endsWith('\n') ? line.slice(0, -1) : line;
    const kind = bare.startsWith('+') && !bare.startsWith('+++') ? 'diff-add'
      : bare.startsWith('-') && !bare.startsWith('---') ? 'diff-remove'
        : bare.startsWith('@@') ? 'diff-hunk' : 'diff-context';
    const label = kind === 'diff-add' ? 'added' : kind === 'diff-remove' ? 'removed' : 'context';
    return `<span class="diff-line ${kind}" data-diff-line="${label}">${escapeHtml(bare || ' ')}</span>`;
  }).join('');
}

export function renderUnifiedDiff(diff, worktreeDirectory = null) {
  if (diff.message !== null) return `<p class="notice">${escapeHtml(diff.message)}</p>`;
  const capNotice = diff.capped
    ? `<p class="diff-capped"><strong>Diff rendering capped.</strong> Showing ${diff.renderedByteCount.toLocaleString('en-US')} of ${diff.byteCount.toLocaleString('en-US')} bytes. The overall diff content was truncated.</p>`
    : `<p class="muted">${diff.byteCount.toLocaleString('en-US')} bytes.</p>`;
  const files = parseUnifiedDiff(diff.text).map((file) => {
    const label = file.displayPath ?? 'Unknown file';
    const relativePath = file.displayPath?.replace(/^[ab]\//, '') ?? null;
    const href = typeof worktreeDirectory === 'string' && relativePath !== null
      ? vscodeFileHref(join(worktreeDirectory, relativePath))
      : null;
    const link = href === null ? '' : `<p class="diff-file-link">${renderVsCodeLink(href)}</p>`;
    return `<details class="diff-file" data-diff-path="${escapeHtml(relativePath ?? '')}">`
      + `<summary><code>${escapeHtml(label)}</code></summary>`
      + `<div class="diff-file-content">${link}`
      + `<pre class="diff" aria-label="Unified diff for ${escapeHtml(label)}">`
      + `${renderDiffLines(file.text)}</pre></div></details>`;
  }).join('');
  return `${capNotice}<div class="diff-files">${files}</div>`;
}

export function renderDashboardContent(snapshot) {
  return renderTranscriptDashboard(snapshot, renderUnifiedDiff);
}

export function renderTranscriptDetail(run) {
  return renderRunTranscript(run, renderUnifiedDiff);
}

export function renderBoardDetail(snapshot) {
  return renderDashboardBoard(snapshot);
}

export function renderBoardDetails(snapshot) {
  return renderDashboardBoards(snapshot);
}

export function snapshotForClient(snapshot) {
  return {
    mode: snapshot.mode,
    sourcePath: snapshot.sourcePath,
    observedAt: snapshot.observedAt,
    message: snapshot.message,
    runs: snapshot.runs.map((run) => ({
      runId: run.runId,
      title: run.title,
      state: run.state,
      startTs: run.startTs,
      lastEventTs: run.lastEventTs,
      filters: dashboardFiltersForRun(run, snapshot.observedAt),
    })),
  };
}

function jsonForInlineScript(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function clientScript() {
  return String.raw`
const connection=document.getElementById('connection');
const root=document.getElementById('runs');
const defaultFilter=${JSON.stringify(DEFAULT_DASHBOARD_FILTER)};
const state={snapshot:JSON.parse(document.getElementById('initial-dashboard-data').textContent),boards:JSON.parse(document.getElementById('initial-dashboard-boards').textContent),filter:defaultFilter,runId:null,view:'transcript'};
function esc(value){return String(value==null?'':value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')}
function label(stateValue){if(stateValue==='running')return'Live';if(stateValue==='finished')return'Finished';if(stateValue==='error')return'Read error';return'Waiting'}
function mostRecent(runs){return runs.reduce(function(latest,run){if(latest===null)return run;const runTime=Date.parse(run.lastEventTs||run.startTs||'');const latestTime=Date.parse(latest.lastEventTs||latest.startTs||'');if(!Number.isFinite(runTime))return latest;return!Number.isFinite(latestTime)||runTime>latestTime?run:latest},null)}
function defaultRunId(runs){const run=mostRecent(runs.filter(function(item){return item.state==='running'}))||mostRecent(runs.filter(function(item){return item.state==='waiting'}))||runs[0];return run?run.runId:null}
function filteredRuns(){return state.snapshot.runs.filter(function(run){return Array.isArray(run.filters)&&run.filters.includes(state.filter)})}
function syncPicker(){const picker=document.getElementById('run-picker');if(!picker)return;const filtered=filteredRuns();const selected=state.runId?state.snapshot.runs.find(function(run){return run.runId===state.runId}):null;const wanted=selected?selected.runId:defaultRunId(filtered);const pickerRuns=selected&&!filtered.some(function(run){return run.runId===selected.runId})?filtered.concat([selected]):filtered;picker.innerHTML=pickerRuns.map(function(run){return'<option value="'+esc(run.runId)+'">'+esc(run.runId)+' — '+esc(label(run.state))+'</option>'}).join('');picker.disabled=pickerRuns.length===0;if(wanted!==null)picker.value=wanted;state.runId=wanted}
function renderBoard(){const board=document.getElementById('board-body');const html=state.boards&&state.boards[state.filter];if(board&&typeof html==='string')board.innerHTML=html}
let transcriptRequest=0;
async function refreshTranscript(){const request=++transcriptRequest;const target=document.getElementById('transcript-body');if(!target)return;const requestedRunId=state.runId;if(requestedRunId===null){target.removeAttribute('aria-busy');target.innerHTML='<div class="transcript-layout"><section class="transcript-pane"><p class="empty">No run is available yet.</p></section><aside class="inspector-pane"><p class="muted">Nothing to inspect.</p></aside></div>';return}target.setAttribute('aria-busy','true');try{const response=await fetch('/detail?runId='+encodeURIComponent(requestedRunId),{cache:'no-store'});const html=response.ok?await response.text():'<p class="empty">That run is no longer available.</p>';if(request===transcriptRequest)target.innerHTML=html}catch(error){if(request===transcriptRequest)target.innerHTML='<p class="empty">Could not load run: '+esc(error.message)+'</p>'}finally{if(request===transcriptRequest)target.removeAttribute('aria-busy')}}
function showDashboardTab(name){state.view=name;document.querySelectorAll('[data-dashboard-tab]').forEach(function(button){button.setAttribute('aria-selected',String(button.dataset.dashboardTab===name))});document.querySelectorAll('[data-dashboard-panel]').forEach(function(panel){panel.hidden=panel.dataset.dashboardPanel!==name})}
function showInspectorTab(name){document.querySelectorAll('[data-inspector-tab]').forEach(function(button){button.setAttribute('aria-pressed',String(button.dataset.inspectorTab===name))});document.querySelectorAll('[data-inspector-panel]').forEach(function(panel){panel.hidden=panel.dataset.inspectorPanel!==name})}
function diffKey(value){return String(value||'').replace(/\\/g,'/').replace(/^(?:[.][/]|[ab][/])/,'')}
root.addEventListener('change',function(event){if(event.target.id==='run-picker'){state.runId=event.target.value;refreshTranscript()}});
root.addEventListener('click',function(event){const dashboardTab=event.target.closest('[data-dashboard-tab]');if(dashboardTab){showDashboardTab(dashboardTab.dataset.dashboardTab);return}const boardFilter=event.target.closest('[data-board-filter]');if(boardFilter){state.filter=boardFilter.dataset.boardFilter;renderBoard();syncPicker();return}const boardRun=event.target.closest('[data-board-run]');if(boardRun){state.runId=boardRun.dataset.boardRun;syncPicker();showDashboardTab('transcript');refreshTranscript();return}const tab=event.target.closest('[data-inspector-tab]');if(tab){showInspectorTab(tab.dataset.inspectorTab);return}const file=event.target.closest('[data-file-diff]');if(!file)return;showInspectorTab('diff');const wanted=diffKey(file.dataset.fileDiff);document.querySelectorAll('[data-diff-path]').forEach(function(section){const match=diffKey(section.dataset.diffPath)===wanted;section.hidden=!match;if(match){section.open=true;section.scrollIntoView({behavior:'smooth',block:'start'})}})});
const picker=document.getElementById('run-picker');state.runId=picker&&!picker.disabled?picker.value:null;
const stream=new EventSource('/events');
stream.addEventListener('snapshot',function(event){const payload=JSON.parse(event.data);state.snapshot=payload.snapshot;if(payload.boardHtmlByFilter&&typeof payload.boardHtmlByFilter==='object')state.boards=payload.boardHtmlByFilter;else if(typeof payload.boardHtml==='string')state.boards[defaultFilter]=payload.boardHtml;renderBoard();syncPicker();refreshTranscript();connection.textContent='Live'});
stream.onopen=function(){connection.textContent='Live'};
stream.onerror=function(){connection.textContent='Reconnecting…'};
`;
}

export function renderDashboardPage(snapshot) {
  const boards = renderDashboardBoards(snapshot);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CCC run dashboard</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f2;--card:#fff;--ink:#18201d;--muted:#65716b;--line:#d9dedb;--ok:#197047;--warn:#9c5a08;--bad:#a32828;--soft:#eef1ef;--add:#e7f6ed;--remove:#fdeaea}
@media(prefers-color-scheme:dark){:root{--bg:#111513;--card:#19201d;--ink:#edf2ef;--muted:#a5b0aa;--line:#35403a;--soft:#222b27;--ok:#6ed39e;--warn:#f0ae59;--bad:#ff8b8b;--add:#183c2a;--remove:#472121}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}
body>header{padding:1rem 1.25rem;border-bottom:1px solid var(--line);display:flex;gap:1rem;align-items:end;justify-content:space-between}
h1{font-size:1.15rem;margin:0}
body>header p{margin:.15rem 0 0;color:var(--muted);word-break:break-all}
.connection{white-space:nowrap;color:var(--ok)}
main{padding:1rem;min-height:calc(100vh - 70px);max-width:1800px;margin:0 auto;width:100%}
button,select{font:inherit}
button{color:inherit}
.dashboard-tabs{display:flex;gap:.25rem;margin-bottom:1rem;border-bottom:1px solid var(--line)}
.dashboard-tabs button{border:0;border-bottom:3px solid transparent;background:transparent;padding:.6rem .85rem;cursor:pointer;color:var(--muted)}
.dashboard-tabs button[aria-selected="true"]{border-color:var(--ink);color:var(--ink);font-weight:700}
.board-filters{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.5rem}
.board-filters button{display:flex;align-items:center;gap:.4rem;border:1px solid var(--line);border-radius:999px;background:var(--card);padding:.35rem .65rem;cursor:pointer}
.board-filters button:hover{background:var(--soft)}
.board-filters button[aria-pressed="true"]{border-color:var(--ink);font-weight:700}
.board-filters span{min-width:1.35rem;border-radius:999px;background:var(--soft);padding:0 .35rem;text-align:center;font-size:.75rem;font-variant-numeric:tabular-nums}
.board-filter-summary{margin:.35rem 0 .75rem;color:var(--muted)}
.board-grid{display:grid;grid-template-columns:repeat(5,minmax(220px,1fr));gap:.8rem;align-items:start;overflow-x:auto;padding-bottom:.5rem}
.board-column{min-height:14rem;background:var(--soft);border:1px solid var(--line);border-radius:7px;padding:.65rem}
.board-column>header{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.65rem}
.board-column h2{font-size:.85rem;margin:0}
.board-column>header span{min-width:1.6rem;text-align:center;border-radius:999px;background:var(--card);color:var(--muted);font-size:.75rem;padding:.05rem .4rem}
.board-empty{color:var(--muted);margin:.5rem 0;padding:.6rem;border:1px dashed var(--line);border-radius:5px;background:var(--card)}
.board-card{background:var(--card);border:1px solid var(--line);border-top:3px solid var(--warn);border-radius:6px;margin:.55rem 0;overflow:hidden}
.board-card.passed{border-top-color:var(--ok)}
.board-card.failed{border-top-color:var(--bad)}
.board-card-select{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.5rem;width:100%;border:0;background:transparent;padding:.7rem;text-align:left;cursor:pointer}
.board-card-select:hover{background:var(--soft)}
.board-card-select:focus-visible{outline:2px solid var(--ink);outline-offset:-2px}
.board-card-identity{display:flex;min-width:0;flex-direction:column;gap:.1rem}
.board-card-identity strong{overflow-wrap:anywhere}
.board-card-identity code{color:var(--muted);font-size:.72rem;overflow-wrap:anywhere}
.board-outcome{align-self:start;border:1px solid currentColor;border-radius:999px;padding:.08rem .4rem;font-size:.7rem;white-space:nowrap}
.board-outcome.passed,.result.passed,.result.clean{color:var(--ok)}
.board-outcome.failed,.result.failed,.result.issues{color:var(--bad)}
.board-outcome.pending,.result.pending,.result.unknown{color:var(--warn)}
.board-consensus{grid-column:1/-1;border-left:3px solid var(--line);padding:.2rem .4rem;background:var(--soft);font-size:.75rem}
.board-consensus.agreement{border-color:var(--ok)}
.board-consensus.disagreement{border-color:var(--bad);color:var(--bad)}
.board-metrics{grid-column:1/-1;display:flex;flex-direction:column;gap:.2rem;margin:.1rem 0 0;font-size:.75rem}
.board-metric{display:flex;justify-content:space-between;gap:.6rem}
.board-metric>span:first-child{color:var(--muted)}
.board-metric>span:last-child{text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.transcript-header{display:flex;align-items:center;justify-content:space-between;gap:1rem;background:var(--card);border:1px solid var(--line);border-radius:7px;padding:.7rem .85rem;margin-bottom:1rem}
.transcript-header small,.muted{color:var(--muted)}
.run-picker-label{display:flex;align-items:center;gap:.55rem;font-weight:650;min-width:min(620px,75vw)}
.run-picker-label select{flex:1;min-width:0;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:.35rem .5rem}
.empty,.notice{padding:.7rem;background:var(--soft);border-radius:5px}
.source-message{margin-bottom:0}
.transcript-layout{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(360px,.75fr);gap:1rem;align-items:start}
.transcript-pane,.inspector-pane{background:var(--card);border:1px solid var(--line);border-radius:7px;overflow:hidden}
.transcript-pane{min-height:70vh}
.inspector-pane{position:sticky;top:1rem;max-height:calc(100vh - 2rem);overflow:auto}
.run-heading{display:flex;justify-content:space-between;gap:.8rem;padding:1rem;border-bottom:1px solid var(--line)}
.run-heading h2{font-size:1rem;margin:0;overflow-wrap:anywhere}
.run-heading p{font-size:.75rem;color:var(--muted);margin:.2rem 0 0;overflow-wrap:anywhere}
.state{border:1px solid currentColor;border-radius:999px;padding:.15rem .55rem;height:max-content;font-size:.75rem}
.state.finished{color:var(--ok)}
.state.error{color:var(--bad)}
.state.running{color:var(--warn)}
.transcript-steps{list-style:none;margin:0;padding:0}
.transcript-row{display:grid;grid-template-columns:4.8rem minmax(0,1fr);gap:.65rem;padding:.65rem .85rem;border-bottom:1px solid var(--line)}
.transcript-row>time{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.75rem;padding-top:.15rem}
.transcript-row pre,.prose,.verifier-report pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:.35rem 0 0;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.transcript-reasoning>summary,.command-output>summary,.verifier-report summary{cursor:pointer;font-weight:650}
.transcript-reasoning.muted{color:var(--muted);font-style:italic}
.transcript-agent-message strong,.decision-question strong,.decision-answer strong{display:block;margin-bottom:.2rem}
.transcript-agent-message small,.decision-question small,.decision-answer small,.transcript-event small{display:block;color:var(--muted)}
.transcript-file{width:100%;border:0;background:transparent;padding:0;text-align:left;cursor:pointer;display:flex;justify-content:space-between;gap:.7rem}
.transcript-file span{color:var(--muted)}
.transcript-file code,.command-heading code{overflow-wrap:anywhere}
.command-heading{display:flex;justify-content:space-between;gap:.7rem}
.command-output pre{max-height:280px;overflow:auto;background:var(--soft);padding:.55rem;border-radius:4px}
.transcript-error{color:var(--bad)}
.decision-question,.decision-answer{border-left:3px solid var(--warn);padding-left:.7rem}
.decision-options,.decision-recommendation{color:var(--muted)}
.exit-ok{color:var(--ok)!important}
.exit-fail{color:var(--bad)!important}
.gate-seam{list-style:none}
.transcript-gate{border-block:3px solid var(--line);background:var(--soft);padding:.8rem .85rem}
.transcript-gate.passed{border-color:var(--ok)}
.transcript-gate.failed{border-color:var(--bad)}
.transcript-gate header,.transcript-gate li{display:flex;justify-content:space-between;gap:.7rem}
.transcript-gate header time{color:var(--muted);margin-left:auto}
.transcript-gate ul{list-style:none;margin:.55rem 0 0;padding:0}
.transcript-gate li{padding:.3rem 0;border-top:1px solid var(--line)}
.transcript-verifier-seat{display:flex;justify-content:space-between;border-left:3px solid var(--line);padding:.35rem .55rem;background:var(--soft)}
.transcript-verifier-seat.clean{border-color:var(--ok)}
.transcript-verifier-seat.issues{border-color:var(--bad)}
.transcript-verifier-seat.unknown{border-color:var(--warn)}
.inspector-tabs{display:flex;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card);z-index:1}
.inspector-tabs button{border:0;border-bottom:3px solid transparent;background:transparent;padding:.6rem .85rem;cursor:pointer;color:var(--muted)}
.inspector-tabs button[aria-pressed="true"]{border-color:var(--ink);color:var(--ink);font-weight:700}
[data-inspector-panel]{padding:.8rem}
.verifier-consensus{padding:.5rem .65rem;margin-bottom:.7rem;background:var(--soft);border-left:3px solid var(--line)}
.verifier-consensus.agreement{border-color:var(--ok)}
.verifier-consensus.disagreement{border-color:var(--bad);color:var(--bad)}
.verifier-report{border:1px solid var(--line);border-left-width:3px;border-radius:5px;padding:.65rem;margin:.65rem 0}
.verifier-report.clean{border-left-color:var(--ok)}
.verifier-report.issues{border-left-color:var(--bad)}
.verifier-report.unknown{border-left-color:var(--warn)}
.verifier-report header{display:flex;justify-content:space-between;gap:.7rem}
.verifier-report>small{color:var(--muted)}
.diff-capped{padding:.6rem;background:var(--soft);border-left:3px solid var(--warn)}
.diff-file{background:var(--card);border:1px solid var(--line);border-radius:7px;margin:.7rem 0;overflow:hidden}
.diff-file>summary{cursor:pointer;padding:.7rem .85rem}
.diff-file-content{border-top:1px solid var(--line);padding:.7rem}
.diff-file-link{margin:0 0 .7rem}
.diff{margin:.35rem 0;max-height:65vh;overflow:auto;border:1px solid var(--line);background:var(--card);font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.diff-line{display:block;min-height:1.5em;padding:0 .5rem;white-space:pre}
.diff-add{background:var(--add);color:var(--ok)}
.diff-remove{background:var(--remove);color:var(--bad)}
.diff-hunk{color:var(--warn)}
@media(max-width:900px){body>header{align-items:start;flex-direction:column}main{padding:.5rem}.transcript-header{align-items:start;flex-direction:column}.run-picker-label{min-width:100%;width:100%}.transcript-layout{grid-template-columns:1fr}.inspector-pane{position:static;max-height:none}.transcript-row{grid-template-columns:4.2rem minmax(0,1fr)}}
</style>
</head>
<body>
<header><div><h1>${URO_DASHBOARD_MARKER}</h1><p>${escapeHtml(snapshot.sourcePath)}</p></div><span id="connection" class="connection">Connecting…</span></header>
<main id="runs"><nav class="dashboard-tabs" role="tablist" aria-label="Dashboard views">
<button type="button" role="tab" data-dashboard-tab="transcript" aria-selected="true">Transcript</button>
<button type="button" role="tab" data-dashboard-tab="board" aria-selected="false">Board</button>
</nav>
<section role="tabpanel" data-dashboard-panel="transcript">${renderDashboardContent(snapshot)}</section>
<section role="tabpanel" data-dashboard-panel="board" hidden><div id="board-body">${boards[DEFAULT_DASHBOARD_FILTER]}</div></section></main>
<script id="initial-dashboard-data" type="application/json">${jsonForInlineScript(snapshotForClient(snapshot))}</script>
<script id="initial-dashboard-boards" type="application/json">${jsonForInlineScript(boards)}</script>
<script>${clientScript()}</script>
</body>
</html>`;
}
