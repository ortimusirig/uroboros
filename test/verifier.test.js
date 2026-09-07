import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertNoForbiddenFlags, buildCursorArgs, classifySeatOutage,
  extractPlanArtifact, parseVerdict, parseVerdictDetail } from '../src/verifier.js';

// Historical Cursor streams remain readable after the active transport migration.
const realSamplePath = fileURLToPath(new URL('../fixtures/cursor-stream-schema-sample.ndjson', import.meta.url));
const planSamplePath = fileURLToPath(new URL('../fixtures/cursor-plan-mode-sample.ndjson', import.meta.url));

function rewriteEvents(streamText, rewrite) {
  return streamText.trim().split(/\r?\n/)
    .map((line) => JSON.stringify(rewrite(JSON.parse(line))))
    .join('\n');
}

function planArtifactStream(plan) {
  return JSON.stringify({
    type: 'tool_call', subtype: 'completed',
    tool_call: { createPlanToolCall: { args: { name: '', overview: '', plan } } },
  });
}

test('parseVerdictDetail keeps the review text, not just the verdict', () => {
  const stream = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'Line 4 drops the error.\n\nISSUES',
  }) + '\n';
  const { verdict, text, source, planText } = parseVerdictDetail(stream);
  assert.equal(verdict, 'ISSUES');
  assert.match(text, /Line 4 drops the error/);
  assert.equal(source, 'result');
  assert.equal(planText, '');
});

test('parseVerdict still returns a bare verdict string', () => {
  assert.equal(typeof parseVerdict('{"type":"result","result":"NO_BLOCKERS"}'), 'string');
});

test('forbidden write flags never appear', () => {
  assert.doesNotMatch(buildCursorArgs({}).join(' '), /--force|--yolo|(^| )-f( |$)|--approve-mcps/);
});

test('assertNoForbiddenFlags throws on a write flag', () => {
  assert.throws(() => assertNoForbiddenFlags(['-p', '--force']), /force/);
  for (const flag of ['--force=true', '--yolo=true', '--approve-mcps=true', '-f=true']) {
    assert.throws(() => assertNoForbiddenFlags(['-p', flag]), /forbidden verifier flag/,
      `${flag} must not bypass the approval guard`);
  }
});

test('parseVerdict handles the real captured cursor-agent stream without crashing', () => {
  const streamText = readFileSync(realSamplePath, 'utf8');
  const verdict = parseVerdict(streamText);
  assert.ok(verdict === 'NO_BLOCKERS' || verdict === 'ISSUES');
  // The sample is a FILEOK probe with no NO_BLOCKERS token, proving the parser
  // reads the real nested assistant/result shape rather than crashing or false-matching.
  assert.equal(verdict, 'ISSUES');
});

test('extractPlanArtifact returns the last real plan tool-call artifact and ignores interaction copies', () => {
  const streamText = rewriteEvents(readFileSync(planSamplePath, 'utf8'), (event) => {
    const planArgs = event.tool_call?.createPlanToolCall?.args;
    if (event.type === 'tool_call' && event.subtype === 'started' && planArgs) {
      planArgs.name = 'Stale started copy';
    }
    const interactionArgs = event.query?.createPlanRequestQuery?.args;
    if (interactionArgs) interactionArgs.name = 'Interaction copy must be ignored';
    return event;
  });
  const artifact = extractPlanArtifact(streamText);
  assert.equal(artifact.name, 'Diff review verdict');
  assert.match(artifact.overview, /implementation is wrong/);
  assert.match(artifact.plan, /return a - b/);
  assert.match(artifact.plan, /ISSUES$/);
  assert.equal(extractPlanArtifact(readFileSync(realSamplePath, 'utf8')), null);
});

test('parseVerdictDetail labels a conclusive real assistant fallback as assistant-sourced', () => {
  const streamText = readFileSync(planSamplePath, 'utf8').trim().split(/\r?\n/)
    .map(JSON.parse)
    .filter((event) => event.type !== 'result')
    .map(JSON.stringify)
    .join('\n');
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'assistant');
  assert.match(detail.text, /wrong implementation/);
});

test('parseVerdictDetail labels a conclusive real result as result-sourced', () => {
  const detail = parseVerdictDetail(readFileSync(planSamplePath, 'utf8'));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'result');
  assert.match(detail.text, /wrong implementation/);
  assert.match(detail.planText, /Sole assertion/);
});

test('parseVerdictDetail falls back to the real plan artifact when result is only preamble', () => {
  const streamText = rewriteEvents(readFileSync(planSamplePath, 'utf8'), (event) => {
    if (event.type === 'result') event.result = 'Review saved to the plan artifact.';
    if (event.type === 'assistant') {
      for (const part of event.message?.content ?? []) {
        if (part.type === 'text') part.text = 'Review saved to the plan artifact.';
      }
    }
    return event;
  });
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
  assert.equal(detail.text, 'Review saved to the plan artifact.');
  assert.match(detail.planText, /Sole assertion/);
  assert.match(detail.planText, /ISSUES$/);
});

test('parseVerdictDetail labels an inconclusive real stream as fail-safe none', () => {
  const detail = parseVerdictDetail(readFileSync(realSamplePath, 'utf8'));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
});

test('parseVerdict returns NO_BLOCKERS from a real-shaped result string', () => {
  const streamText = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'checking...' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All clear.\n\nNO_BLOCKERS' }),
  ].join('\n');
  assert.equal(parseVerdict(streamText), 'NO_BLOCKERS');
});

test('an empty stream is UNVERIFIED with unchanged none provenance', () => {
  const detail = parseVerdictDetail('');

  assert.equal(detail.verdict, 'UNVERIFIED');
  assert.equal(detail.source, 'none');
  assert.equal(detail.text, '');
  assert.equal(detail.planText, '');
});

test('a markerless stream with findings remains fail-safe ISSUES', () => {
  const detail = parseVerdictDetail(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'A blocking race remains in the retry path.',
  }));

  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
  assert.match(detail.text, /blocking race/);
});

test('real verdict markers remain conclusive', () => {
  for (const verdict of ['NO_BLOCKERS', 'ISSUES']) {
    const detail = parseVerdictDetail(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: `Review complete.\n\n${verdict}`,
    }));

    assert.equal(detail.verdict, verdict);
    assert.equal(detail.source, 'result');
  }
});

test('a non-blocking-notes heading does not turn a clean assistant verdict into ISSUES', () => {
  const assistantText = 'No blocking problems found.\n\nNO_BLOCKERS';
  const resultText = 'The review is clean.\n\n## Non-blocking notes (not ISSUES)';
  const streamText = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: resultText }),
  ].join('\n');

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'NO_BLOCKERS');
  assert.equal(detail.source, 'assistant');
  assert.equal(detail.text, assistantText);
});

test('a mid-paragraph NO_BLOCKERS refusal cannot hide a final blocking finding', () => {
  const streamText = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: "I can't mark this NO_BLOCKERS — there is a null dereference on line 40.\n\nThe null dereference is blocking and must be fixed.",
  });

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
  assert.match(detail.text, /null dereference is blocking/);
});

test('final-line formatting noise is ignored for NO_BLOCKERS', () => {
  const finalLines = [
    '**NO_BLOCKERS**',
    '`NO_BLOCKERS`',
    'NO_BLOCKERS.',
    'NO_BLOCKERS   \t',
    '## NO_BLOCKERS',
    '- **NO_BLOCKERS**',
    'Verdict: NO_BLOCKERS;',
    '_NO_BLOCKERS_',
  ];

  for (const finalLine of finalLines) {
    const detail = parseVerdictDetail(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: `The review is clean.\n\n${finalLine}\n  `,
    }));
    assert.equal(detail.verdict, 'NO_BLOCKERS', finalLine);
    assert.equal(detail.source, 'result', finalLine);
  }
});

test('a result token on a non-final line does not decide the verdict', () => {
  const detail = parseVerdictDetail(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'NO_BLOCKERS\n\nA blocking race remains in the retry path.',
  }));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
});

test('a plan line beginning with a formatted ISSUES token is conclusive', () => {
  const streamText = [
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Review saved to the plan.' }),
    JSON.stringify({
      type: 'tool_call', subtype: 'completed',
      tool_call: { createPlanToolCall: { args: {
        name: 'Review', overview: '',
        plan: '# Findings\n\n**ISSUES** — one blocking test bug; rest of the diff looks correct.',
      } } },
    }),
  ].join('\n');

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
});

test('the exact ISSUES/none prose line is not a plan verdict declaration', () => {
  const line = '- ISSUES/`none` vs real ISSUES: existing page test asserts distinct fail-safe vs reviewer';
  const detail = parseVerdictDetail(planArtifactStream(line));

  assert.equal(detail.verdict, 'ISSUES', 'an absent verdict must remain fail-safe');
  assert.equal(detail.source, 'none');
  assert.equal(detail.planText, line);
});

test('all observed genuine plan verdict lines remain conclusive', () => {
  const cases = [
    ['NO_BLOCKERS', 'NO_BLOCKERS'],
    ['**NO_BLOCKERS** — no correctness defects that block the requested change', 'NO_BLOCKERS'],
    ['**ISSUES** — one blocking test bug; rest of the diff looks correct', 'ISSUES'],
    ['**ISSUES** — journal campaign attribution is claimed closed but cannot work', 'ISSUES'],
  ];

  for (const [line, verdict] of cases) {
    const detail = parseVerdictDetail(planArtifactStream(line));
    assert.equal(detail.verdict, verdict, line);
    assert.equal(detail.source, 'plan', line);
    assert.equal(detail.planText, line, line);
  }
});

test('a plan artifact containing only prose mentions has no verdict source', () => {
  const detail = parseVerdictDetail(planArtifactStream([
    'The protocol distinguishes NO_BLOCKERS from ISSUES.',
    'ISSUES/none describes the fail-safe path.',
    'NO_BLOCKERS-leaning prose is not a declaration.',
  ].join('\n')));

  assert.equal(detail.verdict, 'ISSUES', 'an absent verdict must remain fail-safe');
  assert.equal(detail.source, 'none');
});

test('genuine conflicting plan verdict lines still resolve to ISSUES', () => {
  const detail = parseVerdictDetail(planArtifactStream([
    'NO_BLOCKERS — initial assessment',
    'ISSUES: one blocking defect remains',
  ].join('\n')));

  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
});

test('plan verdict tokens followed by sentence punctuation remain conclusive', () => {
  const lines = [
    'NO_BLOCKERS,no blocking defects found',
    'NO_BLOCKERS:no blocking defects found',
    'NO_BLOCKERS.',
    'NO_BLOCKERS—no blocking defects found',
  ];

  for (const line of lines) {
    const detail = parseVerdictDetail(planArtifactStream(line));
    assert.equal(detail.verdict, 'NO_BLOCKERS', line);
    assert.equal(detail.source, 'plan', line);
  }
});

test('both qualifying plan tokens resolve to ISSUES', () => {
  const streamText = JSON.stringify({
    type: 'tool_call', subtype: 'completed',
    tool_call: { createPlanToolCall: { args: {
      name: 'Ambiguous review', overview: '',
      plan: '**NO_BLOCKERS** — initial assessment.\n\nVerdict: ISSUES — blocking defect confirmed.',
    } } },
  });

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
});

test('an inconclusive synthetic stream remains fail-safe with no verdict source', () => {
  const detail = parseVerdictDetail(JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Review could not be completed.' }] },
  }));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
});

test('parseVerdict is fail-safe: an errored result yields ISSUES even if text contains NO_BLOCKERS', () => {
  const streamText = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'NO_BLOCKERS' }] } }),
    JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'NO_BLOCKERS' }),
  ].join('\n');
  assert.equal(parseVerdict(streamText), 'ISSUES');
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.source, 'none');
  assert.equal(detail.text, '', 'errored result must keep suppressing assistant text');
});

test('a conclusive result ISSUES is not overridden by a NO_BLOCKERS plan artifact', () => {
  const streamText = rewriteEvents(readFileSync(planSamplePath, 'utf8'), (event) => {
    const args = event.type === 'tool_call'
      ? event.tool_call?.createPlanToolCall?.args
      : null;
    if (args && typeof args.plan === 'string') args.plan = args.plan.replaceAll('ISSUES', 'NO_BLOCKERS');
    return event;
  });
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'result');
  assert.match(detail.planText, /NO_BLOCKERS$/);
});


test('every assistant part is retained — no last-part-wins head loss', () => {
  // Dogfood run 2: the stance lived in an early assistant part and only the
  // last part survived assembly, so three rounds of votes were never seen.
  // A consecutive identical part is a streamed resend and is kept once.
  const part = (text) => JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text }] },
  });
  const stream = [
    part('AGREE: no\nS1 P0: head part'),
    part('AGREE: no\nS1 P0: head part'),
    part('S2 P1: tail part'),
  ].join('\n');
  const detail = parseVerdictDetail(stream);
  assert.equal(detail.text, 'AGREE: no\nS1 P0: head part\nS2 P1: tail part');
});

test('a free-plan model refusal is config, not quota, and names the flag that fixes it', () => {
  const outage = classifySeatOutage(
    'cursor draft seat failed to launch: ActionRequiredError: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.',
  );
  assert.equal(outage.kind, 'config-refusal');
  assert.match(outage.remedy, /--verifier-model auto/);
});

test('an exhausted account is quota, not config, and names renewal — never a flag', () => {
  const outage = classifySeatOutage("ActionRequiredError: You've hit your usage limit");
  assert.equal(outage.kind, 'quota-exhausted');
  assert.match(outage.remedy, /renew/i);
  assert.doesNotMatch(outage.remedy, /--verifier-model/,
    'a flag cannot buy quota; offering one would send the caller down a dead end');
  assert.equal(classifySeatOutage('the account is out of usage').kind, 'quota-exhausted');
});

test('the shared ActionRequiredError prefix alone is an account action, not a diagnosis', () => {
  const outage = classifySeatOutage('cursor draft seat failed to launch: ActionRequiredError');
  assert.equal(outage.kind, 'account-action');
  assert.match(outage.remedy, /doctor --deep/);
});

test('an unclassifiable failure returns null — no invented remedy', () => {
  assert.equal(classifySeatOutage('spawn ENOENT'), null);
  assert.equal(classifySeatOutage(''), null);
  assert.equal(classifySeatOutage(undefined), null);
  assert.equal(classifySeatOutage(null), null);
});

test('the discriminating substring decides, never the shared prefix', () => {
  // Positive control on the discrimination itself: the same prefix in front of
  // each text must still reach three different kinds.
  const prefix = 'cursor review seat failed to launch: ActionRequiredError: ';
  assert.equal(classifySeatOutage(`${prefix}Named models unavailable`).kind, 'config-refusal');
  assert.equal(classifySeatOutage(`${prefix}You've hit your usage limit`).kind, 'quota-exhausted');
  assert.equal(classifySeatOutage(`${prefix}please sign in again`).kind, 'account-action');
  // A config refusal that never mentions ActionRequiredError is still a config
  // refusal — the prefix is not load-bearing in either direction.
  assert.equal(classifySeatOutage('Free plans can only use Auto').kind, 'config-refusal');
});
