## Title
T1: The terminal record keeps the plan it judged, and an outage names its whole cause

## Provenance
Read `../non-convergence-report.md` first — the debate that designed this goal
ended without convergence, and its unsettled objections bind this unit. This task
answers the report's "What the plan was" section, which records the final plan as
absent because the engine discards it.

## Required behavior
In `src/conversation.js`:

- `finish()` (line ~362) gains a `plan` field carrying the last successfully
  rendered proposal as a string. It is the plan the closing judges actually saw.
- A `PIVOT_FRESH` at the last allowed round must not null it. The report's round-2
  codex-S1 finding is explicit: a fresh pivot at the final round would leave
  `plan: null`, making a report falsely state that no plan existed. Preserve the
  last rendered proposal across a fresh pivot; if a fresh pivot discarded a plan
  and no later proposal was composed, the field carries the discarded plan and the
  result says it was discarded by a fresh pivot.
- The exact wording for that state is `discarded by a fresh pivot` — a later task
  renders it and its test asserts this string. Do not invent a variant.
- `seatLaunchFailure` (line ~65) currently truncates stderr at 200 characters
  (`.slice(0, 200)`). Remove the slice. This cap is undeclared, and constitution
  rule 3 forbids hidden bounds; the string reaches `unavailableSeatReview.error`
  and the terminal outage summary, both of which promise complete cause text.
- `reviewRow` (line ~486) drops an unavailable review's `error`. Retain it, so a
  seat's closing stance carries its reason — the goal's requirement 2 demands
  "each seat's closing stance with its state and its reasons," and an unavailable
  seat's reason is its error.

## Invariants
- No behavior change for converged terminals beyond the added `plan` field.
- No new bound introduced. If removing the 200-character slice exposes an
  unbounded string, it is bounded only by what the seat's stderr already was;
  do not add a replacement cap without declaring it in the audit table.
- Zero runtime dependencies. Windows-first.
- The existing suite stays green (constitution rule 6).

## Test requirements
- `test/conversation.test.js`: a non-converged terminal carries `plan` as the
  rendered proposal text; a converged terminal carries it too.
- A fresh pivot at the final allowed round: `plan` is the discarded proposal, not
  null, and the result declares it was discarded by a fresh pivot.
- A launch failure whose stderr exceeds 200 characters: the full text reaches
  `seatLaunchFailure`'s return, `unavailableSeatReview.error`, and the terminal
  outage summary. Assert on a stderr fixture longer than 200 characters and
  compare the whole string — a length-only assertion cannot see a mid-string cut.
- An unavailable closing review: `reviewRow` retains its `error`.
- Run: `node --test test/conversation.test.js` — all green.

## Out of scope
Writing any report (T2 renders, T3 wires). Any change to the convergence law.
