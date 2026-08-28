# Declare the decision event vocabulary

## IMPLEMENT THIS NOW

This design is **APPROVED**. Do not stop to ask for design approval, do not
propose an alternative and wait — write the code, update the tests, run the gate.
Producing no diff is a failed pass.

If you genuinely cannot proceed without a decision from the operator, write
`DECISION.md` in the worktree root using this exact shape and stop:

```
## Q1
Kind: technical | product | authority
Question: <one line>
Options: <one line>
Recommendation: <one line>
```

## Title

Declare the `decision` event stage so the challenge channel stops being swallowed

## Context — the defect

`src/run.js` already emits two events when the executor pushes back on a plan:

```js
run.js:424   reportEvent(eventReporter, runId, 'decision', 'challenged', { questions });
run.js:445   reportEvent(eventReporter, runId, 'decision', 'resolved', { answers });
```

`src/events.js` declares a **closed** vocabulary. `EVENT_STAGES` does not contain
`decision`. `EVENT_TYPES` contains neither `challenged` nor `resolved`. So
`createEvent` throws `unknown event stage: decision` at `events.js:124`, and
`reportEvent` swallows the throw:

```js
} catch {
  // An event is disposable. The run is not.
}
```

That catch is correct and must stay. Its consequence today is that **every
decision event is silently discarded** — never written to `events.jsonl`, never
visible to the dashboard, never available to the operator. A working challenge
channel is invisible.

## Required behavior

Declare the missing vocabulary in `src/events.js` so these events are constructed
and recorded instead of thrown away.

1. Add `'decision'` to `EVENT_STAGES`, positioned **between `'diff'` and
   `'verify'`** so the list continues to read in pipeline order.

2. Add `'challenged'` and `'resolved'` to `EVENT_TYPES`.

3. Add `'decision/challenged'` and `'decision/resolved'` to `EVENT_PAIRS`.

4. Add a `detailFor` branch for the `decision` stage so
   `formatEventSummary` renders these events as readable one-line summaries
   rather than falling through to a bare stage/type. Follow the existing branches
   (`events.js:275` onward) for shape and tone.
   - `decision/challenged` should surface how many questions were raised and
     their `id`s.
   - `decision/resolved` should surface how many answers were supplied.
   - Respect the existing `oneLine` sanitisation used by the other branches;
     question text is untrusted executor output and may contain newlines or
     control characters.

## Invariants

- **Do not remove or weaken the `try`/`catch` in `reportEvent`.** Observability
  must never be able to fail a run. The fix is to declare the vocabulary, not to
  let the throw escape.
- **Do not change `CAMPAIGN_EVENT_PAIRS`.** The aggregate campaign stream is
  deliberately smaller than a unit stream; `decision` is a unit-level concern.
- The existing guard must keep rejecting genuinely unknown stages and types. A
  test proving an undeclared stage still throws must remain (or be added).
- `MAX_EVENT_SUMMARY_LENGTH` truncation behaviour is unchanged.
- Zero external dependencies. ESM style matching the rest of the codebase.
- Do not modify `src/run.js`. Its emitters are already correct — this task makes
  them work.

## Test requirements

Update `test/events.test.js`:

1. Assert `createEvent` accepts `decision/challenged` and `decision/resolved`
   **without throwing**, and that the resulting events carry their stage, type,
   and stage-specific fields.

2. Assert `formatEventSummary` renders both pairs to a non-empty, single-line
   summary that mentions something specific (question count or ids for
   `challenged`; answer count for `resolved`) — not merely the stage name.

3. **Positive control:** assert that an undeclared stage (for example
   `createEvent` with stage `'nonsense'`) still throws `/unknown event stage/`,
   and an undeclared type still throws `/unknown event pair/`. Without this, the
   first assertion could pass because the guard was removed rather than because
   the vocabulary was declared.

4. The conformance ratchet in `test/events.test.js` (the
   `deliberatelyUncovered` block, currently asserting exactly **7** entries)
   will now fail, because the two new pairs are declared but not emitted by the
   healthy campaign that test exercises. Resolve it **honestly**:
   - Add `'decision/challenged'` and `'decision/resolved'` to
     `deliberatelyUncovered`, each with a substantive reason of at least 24
     characters explaining that the exercised campaign contains no executor
     challenge.
   - Update the count assertion from `7` to `9`.
   - Do **not** weaken `assertEventConformance`, and do not delete the ratchet's
     own negative control (the `future-stage/start` assertion that proves the
     ratchet still fires).

5. Do not delete, skip, or weaken any existing test.

## Out of scope

- `src/run.js` — its emitters already exist and are correct.
- The `debate` stage and `resist` type. Those belong with the debate loop
  implementation, whose own tests will emit them.
- `executor/extended`, `verify/item_completed`, or any other new event from the
  wider design. This task is the `decision` stage only.
- Dashboard rendering of decision events.
- Any change to `reportEvent`'s signature or error handling.
