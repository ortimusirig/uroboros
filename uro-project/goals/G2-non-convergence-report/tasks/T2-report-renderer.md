## Title
T2: A pure renderer turns a non-converged terminal into the report, and tells the truth about recurrence

## Provenance
Read `../non-convergence-report.md` first — it is both the specification of the
output shape and a worked example produced by hand from a real run. The renderer's
output must be recognizably the same document. Two of its unsettled objections
(codex S6) and one documented trap (the ID-reuse table) are requirements here.

## Required behavior
New file `src/non-convergence-report.js`, exporting a pure function that takes a
`finish()` result and returns a markdown string. No file writing, no I/O, no
engine changes — this unit is entirely testable in memory.

Sections, in the order the worked example uses:

1. **Terminal** — run id, tier, `reason` in the engine's own vocabulary,
   converged (always no), rounds used vs allowed, storm count, capability veto
   count, seat outages, and the line that no task units were written.
2. **Unsettled objections** — the findings live in the CLOSING round only, grouped
   by seat, each with the seat's closing state (`agree` / `disagree` /
   `stance-unreadable` / `unavailable`) and severity. This section is the spine.
   Where a seat's stance was unreadable, render its `content`, `priorContent`, and
   `reaskContent` where present. Where a seat was unavailable, render its error.
3. **Historical recurrence** — findings that appeared in more than one round but
   are ABSENT from the closing round. These are labelled historical with
   resolution unknown, and MUST NOT appear under unsettled objections. This is the
   report's codex-S6 finding, binding: recurrence proves repetition, not that a
   finding stayed unresolved.
4. **Judge assessments** — every pivot decision with its reason verbatim, and the
   closing agreement judgement's reason verbatim. Where a pivot was unjudged,
   render its raw answer complete.
5. **The plan** — from T1's `plan` field. If a fresh pivot discarded it, say so
   using T1's exact wording, `discarded by a fresh pivot`.
6. **Bounds** — self-declared per constitution rule 3: what was truncated and by
   how much, what was omitted and why, counts of anything summarized.

**The recurrence honesty requirement.** Findings are matched across rounds by
`seat + id`, and seats renumber their findings every round — in the worked
example `codex-S1` names four different objections across four rounds. The
renderer MUST NOT present ID matching as proof of a recurring objection. Either
compare finding text and report matches on that basis, or render the ID table
with an explicit statement that matching is by identifier and therefore
approximate. Whichever is chosen, the rendered output must let a reader tell
which it is.

## Invariants
- Pure: same input, same output. No clock, no filesystem, no network.
- Finding text is rendered complete unless a declared bound cuts it, in which case
  the bound appears in the Bounds section with the cut length.
- Zero runtime dependencies. Windows-first (no path assumptions; this unit
  handles no paths).
- The existing suite stays green.

## Test requirements
`test/non-convergence-report.test.js`, new:
- A `pivot-conclude` fixture with both seats disagreeing at the close: the
  unsettled section names both seats' closing findings and no others.
- A fixture where a finding recurs in rounds 1 and 3 but is absent from closing
  round 5: it appears under historical recurrence and NOT under unsettled. This
  is the positive control for codex-S6 — a test that only checks the unsettled
  section cannot see the defect.
- A fixture where the same `seat + id` carries different text in two rounds: the
  output does not claim they are one recurring objection.
- A `rounds-exhausted` fixture with no pivot at all: renders without a pivot
  section and does not fabricate one.
- An `unavailable` closing seat: its state and its error both render.
- A `stance-unreadable` closing seat: `content` renders.
- A fresh-pivot-discarded plan: the exact string `discarded by a fresh pivot`.
- A truncation fixture: the Bounds section names what was cut and by how much.
- Run: `node --test test/non-convergence-report.test.js` — all green.

## Out of scope
Writing the file to disk or wiring any production caller — that is T3, deliberately
separate so this unit lands without touching a single production code path. Adding
the report to `HARNESS_ARTIFACT_PATTERNS` (see T3's out-of-scope note for why).
