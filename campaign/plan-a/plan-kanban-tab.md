# A Kanban board as the dashboard's second tab

## IMPLEMENT THIS NOW

This design is **APPROVED**. Do not stop to ask for design approval, do not
propose an alternative and wait — write the code, add the tests, run the gate.
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

Add a Kanban board tab beside the transcript, showing every run as a card in an
outcome column

## Context

The dashboard is currently a single view: the live run transcript, which replaced
the old Triage and Session/Project tabs. That transcript answers *"what is this
one run doing?"*

It cannot answer *"what is the state of everything?"* — which run needs a
decision, which failed its gate, which is ready to review. The operator has asked
for a Kanban board to cover that.

These are deliberately different jobs and both are wanted:

| Tab | Question it answers |
|---|---|
| **Transcript** (default) | what is this one run doing, right now |
| **Board** (new) | what is the state of every run |

This is **not** a return of the deleted Triage/Session/Project views. Those were
session-inference and project-grouping tables. This is one board, columns by
outcome, one card per run.

## Required behavior

### 1. Two tabs, transcript first

- A tab strip with exactly two entries: **Transcript** and **Board**.
- **Transcript is the default** and is what loads on open. The board is opt-in.
- Switching tabs must not lose the selected run or drop the SSE connection.

### 2. The board

Columns, left to right, in pipeline order:

| Column | Runs whose outcome is |
|---|---|
| **Running** | not yet finished (no outcome recorded) |
| **Needs decision** | `needs-decision`, `needs-pivot`, `conflicting-intent` |
| **Failed** | `gate-failed`, `executor-failed`, `timed-out`, `verifier-failed` |
| **Review ready** | `review-ready` |
| **No change** | `no-op` |

An empty column still renders with its heading and an honest empty note, so the
board's shape is stable.

### 3. The card

Each run is one card carrying:

- short run id, and the task title when one is available
- outcome, with the same colour treatment the transcript uses for pass/fail
- gate result, and **both verifier verdicts shown separately** — a disagreement
  between the seats must be visible on the card, not flattened into one badge
- round count when a debate ran
- elapsed time, from first to last event
- token total

Clicking a card **switches to the Transcript tab with that run selected**. The
board is a way in, not a dead end.

### 4. Live and read-only

- Reuse the existing SSE channel and snapshot fingerprinting. Do not add polling,
  do not open a second stream, do not change the transport.
- The board issues no mutating requests. No buttons that start, stop, or alter a
  run.

## Invariants

- **Zero external dependencies.** No React, no bundler, no CDN, no drag-and-drop
  library. Hand-written HTML strings and CSS grid, as the rest of the dashboard
  is built.
- **Escape every rendered value.** Task titles come from `TASK.md` and are
  untrusted; keep using the existing `escapeHtml` and `oneLine` helpers.
- Reuse `buildDashboardSnapshot` and the existing event parsing. Do not write a
  second event reader or a second run discoverer.
- Board rendering is a **pure function of a snapshot**, so it can be
  golden-tested like the transcript.
- The board lives in its own module, as the transcript does. Do not grow
  `dashboard-view.js`.
- The transcript's behaviour, markup, and tests are unchanged.
- Cards are ordered newest first within each column, so the board is stable and
  predictable.

## Test requirements

1. Both tabs render; **Transcript is the default** on load.
2. A run in each of the five outcome groups lands in the correct column.
3. An empty column still renders its heading and an empty note.
4. A card shows outcome, gate result, **both verifier verdicts separately**,
   elapsed time and token total.
5. A run where the two seats disagree renders visibly differently from one where
   they agree — assert the disagreement is distinguishable, not merely present.
6. Cards are ordered newest first within a column.
7. A card carries the run id needed to select that run in the transcript.
8. Golden-file rendering: an identical snapshot produces byte-identical HTML.
9. A task title containing `<script>` and quotes is escaped and does not break
   the markup.
10. A snapshot with zero runs renders the board without throwing.
11. **Positive control:** changing a run's outcome moves its card to a different
    column, proving the grouping is real and not hardcoded.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Drag-and-drop, or any reordering by the user.
- Starting, stopping, retrying or editing a run from the board. Read-only.
- Multi-repo or project grouping. One scratch root, as now.
- Pull requests, CI status, or any GitHub integration.
- Any change to the transcript beyond being reachable from a card click.
