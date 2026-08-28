# One tab: a live, read-only run transcript

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

Replace the Triage and Detail tabs with a single live two-pane run transcript

## Context

The dashboard today opens on a tab bar with **Triage** and **Detail** views —
a fleet-level board. The operator has stated repeatedly that they do not want
two tabs; they want **one view**: a single run, read top to bottom as it
happens, with the diff beside it. Like reading a coding-agent session, but
read-only and live.

Everything needed is already present and must be reused, not rebuilt:

- `src/dashboard.js` — HTTP server, SSE push, 250 ms snapshot fingerprinting,
  15 s keepalive
- `src/dashboard-view.js` — `buildDashboardSnapshot`, `renderTimeline`,
  `renderUnifiedDiff`, `renderVerifier`, task/plan reading, diff preview
- `renderTimeline` already renders `executor/item_completed` richly: commands
  with exit codes, recorded output, and agent prose in collapsible blocks

## Required behavior

### 1. One view, and the old two are removed

- The tab bar and the **Triage** and **Session/Project** views are **deleted**,
  along with their now-unused helpers (`renderTriage`, `renderSessions`,
  `renderProjects`, `renderSessionList`, `renderProjectList`, `renderPassRow`,
  `orderCorrectionRows`, and anything else left with no caller).
- Opening the dashboard lands directly in the transcript.
- Exported functions that are genuinely dead after this must go, and their tests
  with them. Do not leave unreachable code behind.

### 2. Many runs are handled by a picker, not a second view

The transcript header carries a run selector listing discoverable runs under the
scratch root with their state, defaulting to the most recent active run.
Switching runs swaps the transcript in place. **One tab, one layout, always.**

### 3. Two panes

**Left — the transcript.** Chronological, attributed, one row per step, live.
A renderer per step type rather than one generic line:

| Step | Rendering |
|---|---|
| reasoning | muted, italic, collapsible |
| agent message | prose |
| file edit | a clickable row naming the file |
| command | the command, a colour-coded exit code, collapsible output |
| gate | a **full-width band**, not a chat row: every command and its exit code |
| verifier | one row per seat (correctness, intent) with its verdict |
| decision | the executor's question and, when present, the answer, each attributed |

**Right — the inspector.** Tabs for the unified diff, the plan (`TASK.md`), and
the verifier report. Clicking a file row on the left loads that file's diff on
the right.

The gate renders as a visible seam deliberately: it is the proof that no seat
marked its own homework. The two verifier seats render separately so a
disagreement between them is obvious at a glance.

### 4. Live and read-only

- Reuse the existing SSE channel and snapshot fingerprinting exactly as they
  are. Do not add polling and do not change the transport.
- The page issues no mutating requests. There are no controls that change a run.
- A run with no events yet, a run still executing, and a finished run must all
  render without error.

## Invariants

- **Zero external dependencies.** No React, no bundler, no CDN. Hand-written
  HTML strings exactly as the current view is built.
- **Escape every rendered value.** Executor and verifier output is untrusted
  input; keep using the existing `escapeHtml` and `oneLine` helpers.
- Reuse `buildDashboardSnapshot`, `renderUnifiedDiff` and the existing event
  parsing. Do not write a second event reader.
- Rendering stays a **pure function of a snapshot** so it can be golden-tested.
- Do not change `src/events.js`, `src/run.js`, `src/report.js`, or anything
  outside the dashboard modules. New transcript renderers belong in a new module
  rather than growing `dashboard-view.js` further.
- Truncation limits already in place for diffs and recorded output stay.

## Test requirements

1. The rendered page contains the transcript and **no Triage or Session/Project
   tab markup**.
2. Each step type renders its own shape: a command shows its exit code, a
   reasoning item is present but muted, an agent message shows prose, a file edit
   is clickable.
3. The gate renders as a full-width band listing every command with its exit
   code — not as a chat row.
4. Both verifier seats render separately, and a disagreement between them is
   visibly distinct from agreement.
5. A `decision/challenged` event renders the question; a `decision/resolved`
   event renders the answer attributed to its author.
6. The run picker lists discoverable runs and defaults to the most recent active
   one.
7. Golden-file rendering: an identical snapshot produces byte-identical HTML.
8. Untrusted content is escaped — an agent message containing `<script>` and a
   command containing quotes and newlines must not break the markup.
9. A run with zero events, one still running, and one finished all render
   without throwing.
10. **Positive control:** removing a required field from the snapshot changes the
    output, proving the assertions are not passing vacuously.

Delete tests that covered the removed views; do not delete or weaken any other
test.

## Out of scope

- Any change outside the `src/dashboard*` modules.
- New event types. The transcript renders what already exists.
- Editing, re-running, or cancelling a run from the page. It is read-only.
- Authentication, remote access, or multi-user concerns. Localhost only, as now.
