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
import { startDashboard } from '../src/dashboard.js';
import {
  buildDashboardSnapshot,
  renderDashboardContent,
  renderDashboardPage,
} from '../src/dashboard-view.js';

function event(runId, stage, type, fields = {}, second = 0) {
  return {
    ts: `2026-08-28T12:00:${String(second).padStart(2, '0')}.000Z`,
    runId,
    stage,
    type,
    ...fields,
  };
}

function makeRun(root, runId, events, task = '# Task\n\nRender the live transcript.\n') {
  const directory = join(root, runId);
  const worktreeDirectory = join(directory, 'w');
  mkdirSync(worktreeDirectory, { recursive: true });
  writeFileSync(join(worktreeDirectory, 'events.jsonl'),
    events.length === 0 ? '' : `${events.map(JSON.stringify).join('\n')}\n`);
  writeFileSync(join(worktreeDirectory, 'TASK.md'), task);
  return { directory, worktreeDirectory };
}

test('dashboard renders one transcript view with no legacy view tabs', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-transcript-shell-'));
  const runId = '2026-08-28T12-00-00-000Z-active';
  makeRun(root, runId, [event(runId, 'executor', 'start')]);
  try {
    const html = renderDashboardPage(buildDashboardSnapshot({ scratchRoot: root }));
    assert.match(html, /data-dashboard-view="transcript"/,
      'positive control: the primary page must identify the transcript view');
    assert.match(html, /class="transcript-pane"/);
    assert.match(html, /class="inspector-pane"/);
    assert.doesNotMatch(html, /class="view-tabs"|data-view-panel=|>Triage<|>Detail</);
    assert.doesNotMatch(html, /Session\/Project|id="sessions"|attention-only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run picker lists run states and defaults to the most recent running run', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-transcript-picker-'));
  const olderFinished = '2026-08-28T10-00-00-000Z-finished';
  const active = '2026-08-28T11-00-00-000Z-active';
  const mostRecentActive = '2026-08-28T09-00-00-000Z-most-recent-active';
  const newerFinished = '2026-08-28T12-00-00-000Z-finished';
  const older = makeRun(root, olderFinished, [
    event(olderFinished, 'executor', 'start'),
    event(olderFinished, 'report', 'finish', {}, 1),
  ]);
  writeFileSync(join(older.worktreeDirectory, 'uro-runfacts.json'), JSON.stringify({
    runId: olderFinished,
    outcome: 'needs-decision',
  }));
  makeRun(root, active, [event(active, 'executor', 'start')]);
  makeRun(root, mostRecentActive, [event(mostRecentActive, 'executor', 'start', {
    ts: '2026-08-28T13:00:00.000Z',
  })]);
  const newer = makeRun(root, newerFinished, [
    event(newerFinished, 'executor', 'start'),
    event(newerFinished, 'report', 'finish', {}, 1),
  ]);
  writeFileSync(join(newer.worktreeDirectory, 'uro-runfacts.json'), JSON.stringify({
    runId: newerFinished,
    outcome: 'needs-decision',
  }));
  try {
    const html = renderDashboardPage(buildDashboardSnapshot({ scratchRoot: root }));
    assert.match(html, /<select id="run-picker"[^>]*>/);
    assert.match(html, new RegExp(
      `<option value="${mostRecentActive}" selected>${mostRecentActive} — Live<\\/option>`,
    ));
    assert.match(html, new RegExp(
      `<option value="${newerFinished}">${newerFinished} — Finished<\\/option>`,
    ));
    assert.match(html, new RegExp(
      `<option value="${olderFinished}">${olderFinished} — Finished<\\/option>`,
    ));
    const pickerMarkup = html.match(/<select id="run-picker">([\s\S]*?)<\/select>/)?.[1] ?? '';
    assert.deepEqual(
      [...pickerMarkup.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]),
      [newerFinished, active, olderFinished, mostRecentActive],
      'discoverable runs must remain newest-first in the one picker',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('executor step types render as reasoning, prose, clickable file, and command shapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-transcript-steps-'));
  const runId = '2026-08-28T12-00-00-000Z-steps';
  makeRun(root, runId, [
    event(runId, 'executor', 'item_completed', {
      itemType: 'reasoning', text: 'Inspect the boundary first.', textEncoding: 'plain',
    }),
    event(runId, 'executor', 'item_completed', {
      itemType: 'agent_message', text: 'I updated the dashboard shell.', textEncoding: 'plain',
    }, 1),
    event(runId, 'executor', 'file_change', { file: 'src/dashboard-transcript.js' }, 2),
    event(runId, 'executor', 'item_completed', {
      itemType: 'command_execution', command: 'node --test dashboard', exitCode: 7,
      output: 'one assertion failed', outputEncoding: 'plain',
    }, 3),
  ]);
  try {
    const html = renderDashboardContent(buildDashboardSnapshot({ scratchRoot: root }));
    assert.match(html, /<details class="transcript-reasoning muted">[\s\S]*Inspect the boundary first/);
    assert.match(html, /class="transcript-agent-message"[\s\S]*I updated the dashboard shell/);
    assert.match(html, /<button[^>]+class="transcript-file"[^>]+data-file-diff="src\/dashboard-transcript[.]js"/);
    assert.match(html, /class="transcript-command"[\s\S]*node --test dashboard[\s\S]*class="exit-fail">exit 7/);
    assert.match(html, /<details class="command-output">[\s\S]*one assertion failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate is one full-width band containing every command and exit code', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-transcript-gate-'));
  const runId = '2026-08-28T12-00-00-000Z-gate';
  makeRun(root, runId, [
    event(runId, 'executor', 'finish'),
    event(runId, 'gate', 'start', {}, 1),
    event(runId, 'gate', 'gate_command', {
      bin: 'node', args: ['--test', 'test/a.test.js'], code: 0,
    }, 2),
    event(runId, 'gate', 'gate_command', {
      bin: 'npm', args: ['run', 'lint'], code: 2,
    }, 3),
    event(runId, 'gate', 'finish', { verdict: 'failed' }, 4),
  ]);
  try {
    const html = renderDashboardContent(buildDashboardSnapshot({ scratchRoot: root }));
    assert.equal((html.match(/<section class="transcript-gate/g) ?? []).length, 1);
    const gate = html.slice(html.indexOf('<section class="transcript-gate'),
      html.indexOf('</section>', html.indexOf('<section class="transcript-gate')));
    assert.match(gate, /Evidence/);
    assert.match(gate, /node --test test\/a[.]test[.]js[\s\S]*exit 0/);
    assert.match(gate, /npm run lint[\s\S]*exit 2/);
    assert.doesNotMatch(gate, /class="transcript-row/,
      'the gate seam must not masquerade as an ordinary chat row');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the review seat renders once from the live event stream', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-transcript-verifiers-'));
  const runId = '2026-08-28T12-00-00-000Z-verifiers';
  makeRun(root, runId, [
    event(runId, 'verify', 'finish', { pass: 'review', code: 0 }),
  ]);
  try {
    const html = renderDashboardContent(buildDashboardSnapshot({ scratchRoot: root }));
    assert.equal((html.match(/class="transcript-verifier-seat/g) ?? []).length, 1);
    assert.match(html, /data-verifier-seat="review"/);
    assert.doesNotMatch(html, /Seats disagree|Seats agree/,
      'single-seat review has no consensus chip');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('decision questions and answers retain executor and author attribution', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-transcript-decision-'));
  const runId = '2026-08-28T12-00-00-000Z-decision';
  makeRun(root, runId, [
    event(runId, 'decision', 'challenged', {
      questions: [{ id: 'Q1', kind: 'product', question: 'Keep the compact header?' }],
    }),
    event(runId, 'decision', 'resolved', {
      answeredBy: 'operator',
      answers: [{ id: 'Q1', answer: 'Yes, keep it compact.' }],
    }, 1),
  ]);
  try {
    const html = renderDashboardContent(buildDashboardSnapshot({ scratchRoot: root }));
    assert.match(html, /class="decision-question"[\s\S]*Executor[\s\S]*Keep the compact header[?]/);
    assert.match(html, /class="decision-answer"[\s\S]*operator[\s\S]*Yes, keep it compact[.]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('untrusted agent and command content is escaped without breaking transcript markup', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-transcript-escape-'));
  const runId = '2026-08-28T12-00-00-000Z-escape';
  makeRun(root, runId, [
    event(runId, 'executor', 'item_completed', {
      itemType: 'agent_message', text: '<script>alert("agent")</script>',
      textEncoding: 'plain',
    }),
    event(runId, 'executor', 'item_completed', {
      itemType: 'command_execution',
      command: 'node -e "bad"\n<script>command</script>', exitCode: 1,
    }, 1),
  ]);
  try {
    const html = renderDashboardContent(buildDashboardSnapshot({ scratchRoot: root }));
    assert.doesNotMatch(html, /<script>alert\("agent"\)<\/script>|<script>command<\/script>/);
    assert.match(html, /&lt;script&gt;alert\(&quot;agent&quot;\)&lt;\/script&gt;/);
    assert.match(html, /node -e &quot;bad&quot; &lt;script&gt;command&lt;\/script&gt;/,
      'the command must be one escaped line inside its code element');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('zero-event, running, and finished runs all render deterministically', () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-transcript-lifecycle-'));
  const waiting = '2026-08-28T10-00-00-000Z-waiting';
  const running = '2026-08-28T11-00-00-000Z-running';
  const finished = '2026-08-28T12-00-00-000Z-finished';
  makeRun(root, waiting, []);
  makeRun(root, running, [event(running, 'executor', 'start')]);
  makeRun(root, finished, [
    event(finished, 'executor', 'start'),
    event(finished, 'report', 'finish', {}, 1),
  ]);
  try {
    const snapshot = buildDashboardSnapshot({ scratchRoot: root });
    for (const run of snapshot.runs) {
      const isolated = { ...snapshot, runs: [run] };
      assert.doesNotThrow(() => renderDashboardContent(isolated));
      assert.match(renderDashboardContent(isolated), new RegExp(`state ${run.state}`));
    }
    const first = renderDashboardContent(snapshot);
    const second = renderDashboardContent(snapshot);
    assert.equal(first, second, 'an identical snapshot must produce byte-identical HTML');
    const withoutState = structuredClone(snapshot);
    delete withoutState.runs.find((run) => run.runId === running).state;
    assert.notEqual(renderDashboardContent(withoutState), first,
      'positive control: removing a required snapshot field must change the output');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('served run swaps return the transcript layout through read-only requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-dashboard-transcript-route-'));
  const runId = '2026-08-28T12-00-00-000Z-route';
  const run = makeRun(root, runId, [
    event(runId, 'executor', 'file_change', { file: 'src/route.js' }),
  ]);
  let dashboard;
  try {
    dashboard = await startDashboard({ scratchRoot: root, port: 0 });
    const pageResponse = await fetch(dashboard.url);
    const pageHtml = await pageResponse.text();
    assert.match(pageHtml, /new EventSource\('\/events'\)/);
    assert.doesNotMatch(pageHtml, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)/i);
    assert.match(pageHtml, /picker[.]disabled=pickerRuns[.]length===0/,
      'an SSE-discovered first run must enable the initially empty picker');

    const listeners = {};
    const streamListeners = {};
    const picker = { disabled: false, value: runId, innerHTML: '' };
    const connection = { textContent: '' };
    const transcriptBody = {
      innerHTML: '<p>stale transcript</p>',
      setAttribute() {},
      removeAttribute() {},
    };
    const initialData = pageHtml.match(
      /<script id="initial-dashboard-data" type="application\/json">([\s\S]*?)<\/script>/,
    )?.[1];
    const initialBoardsData = pageHtml.match(
      /<script id="initial-dashboard-boards" type="application\/json">([\s\S]*?)<\/script>/,
    )?.[1];
    assert.ok(initialData && initialBoardsData, 'the client test needs the page snapshot');
    const rootElement = {
      addEventListener(type, listener) { listeners[type] = listener; },
    };
    const tabs = ['diff', 'plan', 'verifier'].map((name) => ({
      dataset: { inspectorTab: name },
      pressed: null,
      setAttribute(_name, value) { this.pressed = value; },
    }));
    const panels = ['diff', 'plan', 'verifier'].map((name) => ({
      dataset: { inspectorPanel: name }, hidden: name !== 'diff',
    }));
    const matchingDiff = {
      dataset: { diffPath: 'src/route.js' }, hidden: false, open: false, scrolled: false,
      scrollIntoView() { this.scrolled = true; },
    };
    const otherDiff = {
      dataset: { diffPath: 'src/other.js' }, hidden: false, open: false,
      scrollIntoView() {},
    };
    const document = {
      getElementById(id) {
        return {
          connection,
          runs: rootElement,
          'run-picker': picker,
          'transcript-body': transcriptBody,
          'initial-dashboard-data': { textContent: initialData },
          'initial-dashboard-boards': { textContent: initialBoardsData },
        }[id] ?? null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-inspector-tab]') return tabs;
        if (selector === '[data-inspector-panel]') return panels;
        if (selector === '[data-diff-path]') return [matchingDiff, otherDiff];
        return [];
      },
    };
    class FakeEventSource {
      addEventListener(type, listener) { streamListeners[type] = listener; }
    }
    const clientSource = pageHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)?.[1];
    assert.ok(clientSource, 'the client test needs the event wiring');
    runInNewContext(clientSource, { document, EventSource: FakeEventSource });
    const clickedFile = { dataset: { fileDiff: String.raw`src\route.js` } };
    listeners.click({
      target: {
        closest(selector) { return selector === '[data-file-diff]' ? clickedFile : null; },
      },
    });
    assert.equal(tabs.find((tab) => tab.dataset.inspectorTab === 'diff').pressed, 'true');
    assert.equal(panels.find((panel) => panel.dataset.inspectorPanel === 'diff').hidden, false);
    assert.equal(matchingDiff.hidden, false,
      'a Windows-style file event must load its slash-normalized diff');
    assert.equal(matchingDiff.open, true);
    assert.equal(matchingDiff.scrolled, true);
    assert.equal(otherDiff.hidden, true);

    streamListeners.snapshot({
      data: JSON.stringify({
        snapshot: {
          mode: 'scratch', sourcePath: root, observedAt: '2026-08-28T12:05:00.000Z',
          message: 'No run directories found yet.', runs: [],
        },
      }),
    });
    assert.equal(picker.disabled, true);
    assert.match(transcriptBody.innerHTML, /No run is available yet/,
      'an empty live snapshot must clear the no-longer-discoverable run transcript');

    const detailUrl = new URL('/detail', dashboard.url);
    detailUrl.searchParams.set('runId', runId);
    const response = await fetch(detailUrl);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /^<div class="transcript-layout">/);
    assert.match(html, /data-file-diff="src\/route[.]js"/);
    assert.doesNotMatch(html, /class="run-card"|data-view-panel=/);

    const missingResponse = await fetch(new URL('/detail?runId=missing', dashboard.url));
    assert.equal(missingResponse.status, 404);
    assert.equal(await missingResponse.text(), 'Run not found\n');
    assert.equal(run.directory.startsWith(root), true, 'positive control: the served run is real');
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('transcript rendering matches the checked-in golden file byte for byte', () => {
  const snapshot = {
    mode: 'scratch',
    sourcePath: 'C:\\scratch',
    observedAt: '2026-08-28T12:00:00.000Z',
    message: null,
    runs: [{
      directory: 'C:\\scratch\\run-golden',
      worktreeDirectory: 'C:\\scratch\\run-golden\\w',
      eventsPath: 'C:\\scratch\\run-golden\\w\\events.jsonl',
      runId: 'run-golden',
      title: 'Golden transcript',
      taskBody: '# Task\n\nGolden transcript.\n',
      state: 'running',
      message: null,
      startTs: '2026-08-28T12:00:00.000Z',
      endTs: '2026-08-28T12:00:00.000Z',
      currentStage: 'executor',
      currentType: 'item_completed',
      lastEventTs: '2026-08-28T12:00:00.000Z',
      timeline: [{
        ts: '2026-08-28T12:00:00.000Z', stage: 'executor', type: 'item_completed',
        attempt: 1, pass: null, verdict: null, itemType: 'agent_message', command: null,
        exitCode: null, output: null, outputEncoding: null, outputTruncated: false,
        errorMessage: null, text: 'Golden message.', textEncoding: 'plain',
        textTruncated: false, file: null, questions: [], answers: [], author: null,
        askedBy: null, answeredBy: null,
      }],
      review: null,
      gateCommands: [],
      gateResult: 'pending',
      diff: {
        path: null, text: '', byteCount: 0, renderedByteCount: 0, capped: false,
        message: 'CHANGES.diff is not available yet.',
      },
    }],
  };
  const html = renderDashboardContent(snapshot);
  const golden = readFileSync(new URL('./golden/dashboard-transcript.html', import.meta.url), 'utf8');
  assert.equal(html, golden);
  assert.equal(renderDashboardContent(snapshot), html,
    'positive control: rendering the identical snapshot twice remains byte-identical');
});
