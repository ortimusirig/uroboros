# Make the board answer "what needs me?" instead of listing everything

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

Filters and a useful default for the board and the run picker

## Context — the defect

The board renders **every run under the scratch root, with no limit**. On this
machine that is 181 cards, the great majority of them finished days ago and
requiring nothing. The signal — which run is running, which stopped and needs a
decision — is buried in history.

The run picker in the transcript header has the same problem: 181 entries in a
dropdown.

An earlier change deleted the Triage view and, with it, `runNeedsAttention` and
the `attentionOnly` filtering it supported. Those views were rightly removed —
they were session-inference and project-grouping tables — but the **idea** of
"show me only what needs me" went with them and was not replaced. This restores
the idea, not the views.

## Required behavior

### 1. A useful default

The board opens on **runs that need attention, plus anything still running** —
not on everything.

A run needs attention when it is:

- still running or waiting; or
- stopped in a state requiring a person: `needs-decision`, `needs-pivot`,
  `gate-failed`, `executor-failed`, `timed-out`, `conflicting-intent`; or
- **finished with the two verifier seats disagreeing** — the board already
  computes `data-verifier-consensus`, and a disagreement is precisely the case a
  human should look at.

A clean `review-ready` with both seats agreeing does not need attention. Neither
does a `no-op`.

### 2. Filters, with counts

A filter row above the columns, each showing how many runs it matches so nothing
is hidden silently:

| Filter | Shows |
|---|---|
| **Needs attention** *(default)* | the set above |
| **Active** | running or waiting only |
| **Today** | runs whose first event falls on the current date |
| **All** | every discovered run |

Selecting a filter re-renders the columns from the same snapshot. **The columns
themselves do not change** — a filter narrows which cards appear, never which
columns exist. An empty column still renders its heading, as it does today.

The chosen filter persists across SSE updates so a live refresh does not reset
it.

### 3. The run picker obeys the same filter

The transcript's run picker lists the **same filtered set**, so the two views
agree about what is worth looking at. It continues to default to the most recent
active run, and if the current run is filtered out it remains selectable rather
than vanishing mid-view.

### 4. Say what is hidden

When a filter is narrowing the set, state it plainly — for example
`showing 6 of 181`. A view that quietly omits most of its data is the same
failure as a check that passes on weak evidence.

## Invariants

- **Zero external dependencies.** Hand-written HTML and CSS, as the rest of the
  dashboard is built.
- Filtering is presentational: it changes which cards render, never the
  underlying snapshot, and never issues a request.
- The board stays read-only.
- Rendering remains a pure function of a snapshot plus the selected filter, so it
  stays golden-testable.
- Escape every rendered value; task titles are untrusted.
- No change to the transcript's own rendering beyond the picker's contents.

## Test requirements

1. The default filter shows a running run, a `needs-decision` run, and a
   `review-ready` run **whose seats disagreed** — and omits a clean
   `review-ready` and a `no-op`.
2. **Active** shows only running and waiting.
3. **Today** includes a run dated today and excludes one dated earlier.
4. **All** shows every run — the control proving the others genuinely narrow.
5. Each filter reports a count, and the counts match the cards rendered.
6. The "showing N of M" line appears whenever the set is narrowed, and not when
   it is not.
7. Columns render with their headings even when a filter empties them.
8. The run picker lists the filtered set; a currently-selected run that falls
   outside the filter remains selectable.
9. The selected filter survives a snapshot update — assert it is not reset by a
   re-render.
10. Golden rendering: an identical snapshot and filter produce byte-identical
    HTML.
11. **Positive control:** changing a run's outcome moves it between filters,
    proving the classification is real and not hardcoded.

Do not delete, skip, or weaken any existing test.

## Out of scope

- Reviving the Triage or Session/Project views. This restores filtering, not
  those tables.
- Search, sorting, or pagination.
- Any control that starts, stops or alters a run.
- Multi-repo or project grouping.
