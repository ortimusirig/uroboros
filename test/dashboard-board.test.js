import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { renderDashboardBoard } from '../src/dashboard-board.js';
import { buildDashboardSnapshot, renderDashboardPage } from '../src/dashboard-view.js';
import { createDashboardObserver } from '../src/dashboard.js';

function emptySnapshot() {
  return {
    mode: 'scratch',
    sourcePath: 'C:\\scratch',
    observedAt: '2026-08-28T12:00:00.000Z',
    message: 'No run directories found yet.',
    runs: [],
  };
}

function run(runId, overrides = {}) {
  return {
    runId,
    title: null,
    outcome: null,
    state: 'running',
    message: null,
    taskBody: null,
    timeline: [],
    gateCommands: [],
    gateResult: 'pending',
    verifiers: { correctness: null, intent: null },
    debateRoundCount: 0,
    startTs: '2026-08-28T12:00:00.000Z',
    endTs: '2026-08-28T12:00:05.000Z',
    lastEventTs: '2026-08-28T12:00:05.000Z',
    tokenTotal: 0,
    worktreeDirectory: 'C:\\scratch\\w',
    diff: {
      path: null, text: '', byteCount: 0, renderedByteCount: 0,
      capped: false, message: 'CHANGES.diff is not available yet.',
    },
    ...overrides,
  };
}

function snapshot(...runs) {
  return { ...emptySnapshot(), message: null, runs };
}

function column(html, key) {
  return html.match(new RegExp(
    `<section class="board-column" data-board-column="${key}">([\\s\\S]*?)<\\/section>`,
  ))?.[1] ?? '';
}

function writeRun(root, runId, events, facts = null) {
  const work = join(root, runId, 'w');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'events.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`);
  if (facts !== null) writeFileSync(join(work, 'uro-runfacts.json'), JSON.stringify(facts));
}

test('dashboard has exactly Transcript and Board tabs with Transcript selected by default', () => {
  const html = renderDashboardPage(emptySnapshot());
  const tabs = [...html.matchAll(/<button[^>]+data-dashboard-tab="([^"]+)"[^>]*>([^<]+)<\/button>/g)];
  assert.deepEqual(tabs.map((match) => match[1]), ['transcript', 'board']);
  assert.deepEqual(tabs.map((match) => match[2]), ['Transcript', 'Board']);
  assert.match(tabs[0][0], /aria-selected="true"/);
  assert.match(tabs[1][0], /aria-selected="false"/);
  assert.match(html, /data-dashboard-panel="transcript"(?![^>]* hidden)/);
  assert.match(html, /data-dashboard-panel="board"[^>]* hidden/);
});

test('tab and card clicks preserve one SSE connection and the latest transcript selection', async () => {
  const firstId = 'run-first';
  const secondId = 'run-second';
  const html = renderDashboardPage(snapshot(run(firstId), run(secondId, {
    outcome: 'review-ready', state: 'finished',
  })));
  const initialData = html.match(
    /<script id="initial-dashboard-data" type="application\/json">([\s\S]*?)<\/script>/,
  )?.[1];
  const source = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)?.[1];
  assert.ok(initialData && source);

  const listeners = {};
  const streamListeners = {};
  const root = { addEventListener(type, listener) { listeners[type] = listener; } };
  const picker = { disabled: false, value: firstId, innerHTML: '' };
  const transcriptBody = {
    innerHTML: '',
    busy: false,
    setAttribute(name) { if (name === 'aria-busy') this.busy = true; },
    removeAttribute(name) { if (name === 'aria-busy') this.busy = false; },
  };
  const boardBody = {
    innerHTML: '<p>initial board</p>', setAttribute() {}, removeAttribute() {},
  };
  const connection = { textContent: '' };
  const dashboardTabs = ['transcript', 'board'].map((name) => ({
    dataset: { dashboardTab: name }, selected: name === 'transcript',
    setAttribute(_key, value) { this.selected = value === 'true'; },
  }));
  const dashboardPanels = ['transcript', 'board'].map((name) => ({
    dataset: { dashboardPanel: name }, hidden: name === 'board',
  }));
  const document = {
    getElementById(id) {
      return {
        connection,
        runs: root,
        'run-picker': picker,
        'transcript-body': transcriptBody,
        'board-body': boardBody,
        'initial-dashboard-data': { textContent: initialData },
      }[id] ?? null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-dashboard-tab]') return dashboardTabs;
      if (selector === '[data-dashboard-panel]') return dashboardPanels;
      return [];
    },
  };
  const fetchCalls = [];
  const fetch = (url, options) => new Promise((resolve) => {
    fetchCalls.push({ url, options, resolve });
  });
  const resolveFetch = (url, body) => {
    const call = fetchCalls.find((candidate) => candidate.url === url && candidate.resolve);
    assert.ok(call, `expected pending request for ${url}`);
    call.resolve({ ok: true, async text() { return body; } });
    call.resolve = null;
  };
  let eventSourceCount = 0;
  class FakeEventSource {
    constructor() { eventSourceCount += 1; }
    addEventListener(type, listener) { streamListeners[type] = listener; }
  }
  runInNewContext(source, { document, EventSource: FakeEventSource, fetch });
  assert.equal(eventSourceCount, 1);

  const boardTab = dashboardTabs[1];
  listeners.click({
    target: { closest(selector) { return selector === '[data-dashboard-tab]' ? boardTab : null; } },
  });
  assert.equal(dashboardPanels[0].hidden, true);
  assert.equal(dashboardPanels[1].hidden, false);
  assert.equal(picker.value, firstId);
  assert.equal(eventSourceCount, 1);

  streamListeners.snapshot({
    data: JSON.stringify({
      snapshot: {
        ...emptySnapshot(),
        message: null,
        runs: [
          { runId: firstId, title: null, state: 'running', startTs: null, lastEventTs: null },
          { runId: secondId, title: null, state: 'finished', startTs: null, lastEventTs: null },
        ],
      },
      boardHtml: '<p>live board</p>',
    }),
  });
  assert.ok(fetchCalls.some(({ url }) => url === `/detail?runId=${firstId}`));
  assert.equal(boardBody.innerHTML, '<p>live board</p>');

  const card = { dataset: { boardRun: secondId } };
  listeners.click({
    target: { closest(selector) { return selector === '[data-board-run]' ? card : null; } },
  });
  assert.equal(dashboardPanels[0].hidden, false);
  assert.equal(dashboardPanels[1].hidden, true);
  assert.equal(picker.value, secondId, 'the live snapshot must retain the selected run');
  assert.ok(fetchCalls.some(({ url }) => url === `/detail?runId=${secondId}`));

  resolveFetch(`/detail?runId=${secondId}`, '<p>run B transcript</p>');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transcriptBody.innerHTML, '<p>run B transcript</p>');
  resolveFetch(`/detail?runId=${firstId}`, '<p>stale run A transcript</p>');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transcriptBody.innerHTML, '<p>run B transcript</p>',
    'a stale request must not overwrite the latest board-card selection');
  assert.equal(fetchCalls.some(({ url }) => url === '/board'), false,
    'board updates must ride the existing SSE payload instead of adding another transport');
  assert.equal(eventSourceCount, 1);

  streamListeners.snapshot({
    data: JSON.stringify({
      snapshot: {
        ...emptySnapshot(), message: null,
        runs: [{ runId: secondId, title: null, state: 'running', startTs: null, lastEventTs: null }],
      },
      boardHtml: '<p>one live run</p>',
    }),
  });
  assert.equal(transcriptBody.busy, true);
  streamListeners.snapshot({
    data: JSON.stringify({ snapshot: emptySnapshot(), boardHtml: '<p>empty board</p>' }),
  });
  assert.equal(transcriptBody.busy, false,
    'an empty snapshot must clear busy state from the request it superseded');
  assert.match(transcriptBody.innerHTML, /No run is available yet/);
  resolveFetch(`/detail?runId=${secondId}`, '<p>stale run B transcript</p>');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(transcriptBody.innerHTML, /No run is available yet/,
    'the superseded request must not overwrite the empty snapshot');
});

test('the existing SSE payload carries pure board HTML without a second route', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-board-sse-'));
  const runId = 'sse-board-run';
  writeRun(root, runId, [
    { ts: '2026-08-28T12:00:00.000Z', runId, stage: 'executor', type: 'start' },
  ]);
  const observer = createDashboardObserver({ scratchRoot: root }, 60000);
  const writes = [];
  const response = {
    writeHead() {},
    flushHeaders() {},
    write(value) { writes.push(value); },
    end() {},
  };
  try {
    observer.connect({ once() {} }, response);
    const data = writes.join('').match(/data: (.+)\n\n/)?.[1];
    assert.ok(data);
    const payload = JSON.parse(data);
    assert.match(payload.boardHtml, /^<section class="board" data-dashboard-view="board">/);
    assert.match(payload.boardHtml, /data-run-id="sse-board-run"/);
    assert.doesNotMatch(payload.boardHtml, /<form|method=|data-action=/i);
    assert.deepEqual(Object.keys(payload).sort(), ['boardHtml', 'snapshot']);
    assert.equal(payload.snapshot.runs[0].runId, runId);
  } finally {
    observer.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('every recorded outcome is grouped into its pipeline column', () => {
  const cases = [
    [null, 'running'],
    ['needs-decision', 'needs-decision'],
    ['needs-pivot', 'needs-decision'],
    ['conflicting-intent', 'needs-decision'],
    ['gate-failed', 'failed'],
    ['executor-failed', 'failed'],
    ['timed-out', 'failed'],
    ['verifier-failed', 'failed'],
    ['review-ready', 'review-ready'],
    ['no-op', 'no-change'],
  ];
  const runs = cases.map(([outcome], index) => run(`group-${index}`, { outcome }));
  const html = renderDashboardBoard(snapshot(...runs));
  for (const [[, key], item] of cases.map((entry, index) => [entry, runs[index]])) {
    assert.match(column(html, key), new RegExp(`data-run-id="${item.runId}"`));
  }
  assert.deepEqual(
    [...html.matchAll(/data-board-column="([^"]+)"/g)].map((match) => match[1]),
    ['running', 'needs-decision', 'failed', 'review-ready', 'no-change'],
  );
});

test('dashboard snapshots expose board facts from run facts and live events', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-board-facts-'));
  const completedId = 'completed-board-facts';
  const liveId = 'live-board-events';
  writeRun(root, completedId, [
    { ts: '2026-08-28T12:00:00.000Z', runId: completedId, stage: 'executor', type: 'start' },
    { ts: '2026-08-28T12:00:05.000Z', runId: completedId, stage: 'executor', type: 'finish',
      tokens: { inputTokens: 2, outputTokens: 3 } },
    { ts: '2026-08-28T12:00:20.000Z', runId: completedId, stage: 'report', type: 'finish' },
  ], {
    runId: completedId,
    outcome: 'review-ready',
    gateStatus: 'passed',
    debate: { roundsRun: 2 },
    tokens: { total: { inputTokens: 20, outputTokens: 5 } },
  });
  writeRun(root, liveId, [
    { ts: '2026-08-28T12:01:00.000Z', runId: liveId, stage: 'executor', type: 'finish',
      tokens: { inputTokens: 7, cachedInputTokens: 4, outputTokens: 3 } },
    { ts: '2026-08-28T12:01:05.000Z', runId: liveId, stage: 'debate', type: 'round',
      debateRound: 3 },
    { ts: '2026-08-28T12:01:10.000Z', runId: liveId, stage: 'verify', type: 'finish',
      pass: 'correctness', verdict: 'NO_BLOCKERS', tokens: { inputTokens: 4, outputTokens: 2 } },
  ]);
  try {
    const runs = buildDashboardSnapshot({ scratchRoot: root }).runs;
    const completed = runs.find((item) => item.runId === completedId);
    const live = runs.find((item) => item.runId === liveId);
    assert.equal(completed.outcome, 'review-ready');
    assert.equal(completed.debateRoundCount, 2);
    assert.equal(completed.tokenTotal, 25,
      'canonical input and output totals count cached and reasoning subsets only once');
    assert.equal(live.outcome, null);
    assert.equal(live.debateRoundCount, 3);
    assert.equal(live.tokenTotal, 16);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty columns keep their heading, count, and honest empty note', () => {
  const html = renderDashboardBoard(snapshot(run('only-running')));
  const failed = column(html, 'failed');
  assert.match(failed, /<h2>Failed<\/h2><span aria-label="0 runs">0<\/span>/);
  assert.match(failed, /<p class="board-empty">No failed runs[.]<\/p>/);
});

test('a board card shows outcome, gate, both verifier seats, rounds, elapsed time, and tokens', () => {
  const html = renderDashboardBoard(snapshot(run('run-card-details', {
    title: 'Implement the board',
    outcome: 'review-ready',
    state: 'finished',
    gateResult: 'passed',
    verifiers: {
      correctness: { verdict: 'NO_BLOCKERS', verdictSource: 'assistant' },
      intent: { verdict: 'ISSUES', verdictSource: 'assistant' },
    },
    debateRoundCount: 3,
    startTs: '2026-08-28T12:00:00.000Z',
    endTs: '2026-08-28T12:02:05.000Z',
    tokenTotal: 12345,
  })));
  assert.match(html, /class="board-outcome passed"[^>]*>review-ready<\/span>/);
  assert.match(html, /data-board-metric="gate"[^>]*>[\s\S]*class="result passed">passed<\/span>/);
  assert.match(html, /data-verifier-seat="correctness"[^>]*>NO_BLOCKERS<\/span>/);
  assert.match(html, /data-verifier-seat="intent"[^>]*>ISSUES<\/span>/);
  assert.match(html, /data-board-metric="rounds"[^>]*>[\s\S]*>3<\/span>/);
  assert.match(html, /data-board-metric="elapsed"[^>]*>[\s\S]*>2m 5s<\/span>/);
  assert.match(html, /data-board-metric="tokens"[^>]*>[\s\S]*>12,345<\/span>/);
  assert.doesNotMatch(html, /<button[^>]*>[\s\S]*?<dl>/,
    'the whole-card button must contain phrasing content only');
});

test('verifier disagreement has a distinct visible treatment from agreement', () => {
  const disagreeing = run('disagreeing', {
    outcome: 'review-ready',
    verifiers: {
      correctness: { verdict: 'NO_BLOCKERS' },
      intent: { verdict: 'ISSUES' },
    },
  });
  const agreeing = run('agreeing', {
    outcome: 'review-ready',
    verifiers: {
      correctness: { verdict: 'NO_BLOCKERS' },
      intent: { verdict: 'NO_BLOCKERS' },
    },
  });
  const html = renderDashboardBoard(snapshot(disagreeing, agreeing));
  const disagreement = html.match(/<article[^>]+data-run-id="disagreeing"[\s\S]*?<\/article>/)?.[0] ?? '';
  const agreement = html.match(/<article[^>]+data-run-id="agreeing"[\s\S]*?<\/article>/)?.[0] ?? '';
  assert.match(disagreement, /data-verifier-consensus="disagreement"/);
  assert.match(disagreement, />Seats disagree<\/strong>/);
  assert.match(agreement, /data-verifier-consensus="agreement"/);
  assert.match(agreement, />Seats agree<\/strong>/);
  assert.notEqual(disagreement, agreement);
});

test('cards are newest first within a column', () => {
  const older = run('older', {
    outcome: 'gate-failed',
    endTs: '2026-08-28T12:01:00.000Z',
    lastEventTs: '2026-08-28T12:01:00.000Z',
  });
  const newer = run('newer', {
    outcome: 'executor-failed',
    endTs: '2026-08-28T12:03:00.000Z',
    lastEventTs: '2026-08-28T12:03:00.000Z',
  });
  const failed = column(renderDashboardBoard(snapshot(older, newer)), 'failed');
  assert.ok(failed.indexOf('data-run-id="newer"') < failed.indexOf('data-run-id="older"'));
});

test('a card carries the complete run id used to select its transcript', () => {
  const runId = '2026-08-28T12-00-00-000Z-select-me';
  const html = renderDashboardBoard(snapshot(run(runId)));
  assert.match(html, new RegExp(`data-run-id="${runId}"`));
  assert.match(html, new RegExp(`data-board-run="${runId}"`));
});

test('untrusted task titles are one-line escaped values that cannot break card markup', () => {
  const html = renderDashboardBoard(snapshot(run('unsafe-title', {
    title: '<script>alert("board")</script>\nquoted "tail"',
  })));
  assert.doesNotMatch(html, /<script>|\nquoted/);
  assert.match(html, /&lt;script&gt;alert\(&quot;board&quot;\)&lt;\/script&gt; quoted &quot;tail&quot;/);
  assert.equal((html.match(/<article/g) ?? []).length, 1);
});

test('a zero-run snapshot renders all five columns without throwing', () => {
  let html;
  assert.doesNotThrow(() => { html = renderDashboardBoard(emptySnapshot()); });
  assert.equal((html.match(/class="board-column"/g) ?? []).length, 5);
  assert.equal((html.match(/class="board-empty"/g) ?? []).length, 5);
});

test('changing a run outcome moves its card to a different column', () => {
  const item = run('moving-run', { outcome: 'needs-decision' });
  const before = renderDashboardBoard(snapshot(item));
  const after = renderDashboardBoard(snapshot({ ...item, outcome: 'review-ready' }));
  assert.match(column(before, 'needs-decision'), /data-run-id="moving-run"/);
  assert.doesNotMatch(column(before, 'review-ready'), /data-run-id="moving-run"/);
  assert.doesNotMatch(column(after, 'needs-decision'), /data-run-id="moving-run"/);
  assert.match(column(after, 'review-ready'), /data-run-id="moving-run"/);
});

test('board rendering matches its golden file and is byte-identical for an identical snapshot', () => {
  const fixture = snapshot(run('run-golden', {
    title: 'Golden board',
    outcome: 'review-ready',
    state: 'finished',
    gateResult: 'passed',
    verifiers: {
      correctness: { verdict: 'NO_BLOCKERS' },
      intent: { verdict: 'NO_BLOCKERS' },
    },
    debateRoundCount: 2,
    startTs: '2026-08-28T12:00:00.000Z',
    endTs: '2026-08-28T12:01:05.000Z',
    lastEventTs: '2026-08-28T12:01:05.000Z',
    tokenTotal: 1234,
  }));
  const first = renderDashboardBoard(fixture);
  const second = renderDashboardBoard(fixture);
  const golden = readFileSync(new URL('./golden/dashboard-board.html', import.meta.url), 'utf8');
  assert.equal(first, golden);
  assert.equal(second, first);
});
