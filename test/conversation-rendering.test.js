import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildRunFacts, buildReportMarkdown } from '../src/report.js';
import { renderRunTranscript } from '../src/dashboard-transcript.js';
import { encodeRecordedText } from '../src/execution-record.js';

for (const shape of ['normal', 'historical', 'historical-truncated', 'oversize']) test(`conversation ${shape} views disclose shortening and retain inspectable raw facts`, () => {
  const content = shape === 'oversize' ? randomBytes(350000).toString('hex') + 'FULL MESSAGE END' : 'Complete retained argument';
  const message = { speaker: 'codex', role: 'reviewer', phase: 'planning', content };
  if (shape.startsWith('historical')) {
    message.recordedContent = shape === 'historical-truncated'
      ? { text: 'Historical excerpt', encoding: 'plain', truncated: true } : encodeRecordedText(content);
    delete message.content;
  }
  const facts = buildRunFacts({ runId: 'rendering', iterations: [], messages: [message], dissent: [message],
    phase: 'planning', interactionMode: 'manual', approved: false, converged: false });
  const markdown = buildReportMarkdown(facts);
  const html = renderRunTranscript({ runId: 'rendering', state: 'finished', timeline: [], messages: facts.messages,
    decision: { phase: 'planning', interactionMode: 'manual', approved: false, converged: false } }, () => '');
  if (shape === 'oversize') {
    assert.equal(facts.messages[0].recordedContent.truncated, true);
    assert.equal(JSON.parse(JSON.stringify(facts)).messages[0].content, content);
    for (const rendered of [markdown, html]) {
      assert.match(rendered, /truncated/i);
      assert.match(rendered, /uro-runfacts\.json/);
      assert.match(rendered, /content/);
    }
  } else if (shape === 'historical-truncated') for (const rendered of [markdown, html]) {
    assert.match(rendered, /Historical excerpt/);
    assert.match(rendered, /truncated/i);
    assert.match(rendered, /original.*not.*retained/i);
  } else for (const rendered of [markdown, html]) {
    assert.match(rendered, /Complete retained argument/);
    assert.doesNotMatch(rendered, /view was truncated/);
  }
});
