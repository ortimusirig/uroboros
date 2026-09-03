## Title
T3: The writer activates and every production tier is wired in the same landing

## Provenance
Read `../non-convergence-report.md` first. **This unit exists in this shape
because of the objection that ended the debate.** Codex S1 and cursor S3 found it
independently, against two different vendors' models, and nobody answered it:

> Making `writeNonConverged` mandatory while the production callers in
> `src/decompose.js` and `src/plan.js` lack the hook means the full-suite gate
> fails on existing non-converged tests.

The debate's plan split activation from wiring across four tasks and broke on
exactly that seam, twice. This unit does both together. **Do not split it.** A
reviewer who proposes splitting activation from wiring should be shown this
paragraph and the report's cross-vendor confirmation note.

## Required behavior
In one landing:

- `src/conversation.js` `finish()` calls a `writeNonConverged` strategy hook on
  every non-converged terminal, passing the completed result object (T1's `plan`
  included) and receiving back the path it wrote.
- **All three production call sites gain the hook in this same unit:**
  `src/plan.js:916`, `src/decompose.js:1010`, `src/decompose.js:1480`. Each writes
  `non-convergence-report.md` beside where that tier's converged artifacts would
  have gone, using T2's renderer. No call site is left without it.
- **Verify before claiming.** Before setting `recordWritten: true`, confirm the
  returned path names a readable file — not merely a non-empty string. Codex S2:
  a placeholder that returns a path without writing one would otherwise be
  reported as written, violating standing law rule 2 (trust no completion signal)
  and the goal's requirement 6 (never silently absent).
- **Copy, never spread.** Take only the validated report path from the hook's
  return. Codex S3: an unrestricted spread lets a writer overwrite `converged`,
  `reason`, `plan`, or the histories — the canonical terminal decision. Reject or
  ignore any other key the hook returns.
- **Exactly one `plan/finish` event per terminal.** The existing unconditional
  emit at `src/conversation.js:381-387` is branched, not left standing beside a
  new one (cursor S10). A non-converged terminal's event carries `recordWritten`;
  a converged one does not carry the field at all.
- **Failure is loud.** If the report cannot be written, the run says so — an
  unwritable report is itself a failure (goal requirement 6). It must not be
  swallowed, and it must not be reported as written.

## Invariants
- Every intermediate state of this unit's own commits keeps the suite green; the
  hook is never mandatory while a production call site lacks it.
- The terminal decision is immutable to the writer: no writer return value can
  change `converged`, `reason`, `plan`, `rounds`, or any history.
- No runnable task unit is generated from a non-converged debate. This unit adds
  a document and nothing else (constitution rule 9, first sentence).
- Zero runtime dependencies. Windows-first: the report path must resolve under
  win32 for all three tiers.

## Test requirements
- `test/conversation.test.js`: a non-converged terminal calls the hook and the
  result carries the validated path; a converged terminal does not call it.
- A hook returning a path to a **missing** file, a **directory**, and an
  **unreadable** file: each fails validation and none sets `recordWritten: true`.
- An adversarial hook returning `{ nonConvergenceReport: p, converged: true,
  reason: 'converged', plan: 'x' }`: the terminal fields are unchanged. This is
  the control for codex S3 — a test that only checks the happy path cannot see it.
- Exactly one `plan/finish` event on each of a converged and a non-converged
  terminal; `recordWritten` present on the latter, absent on the former.
- `test/plan.test.js` and `test/decompose.test.js`: the existing non-converged
  cases (`storm-exhausted` ~276, `arbiter-unavailable` ~296, `rounds-exhausted`
  ~435 in plan; silent proposer ~107 in decompose) still pass, now writing a real
  report to a temp directory.
- A write failure surfaces rather than being swallowed.
- Run: **`node --test`** — the whole suite, from the repository root. This unit
  changes shared engine behavior; a per-file gate cannot prove constitution
  rule 6 holds.

## Out of scope
**Registering the report in `HARNESS_ARTIFACT_PATTERNS`.** The debate's plan did
this and codex S4 proved it self-defeating: adding the filename causes
`restoreWorktreeSnapshot` to filter it OUT of restoration at
`src/worktree-snapshot.js:119-122`, so the registration undoes the protection it
claims to add. Protecting the report from executor or reviewer mutation is a
separate problem with an unresolved design, and it is not attempted here. A
future unit may take it up with that contradiction as its starting requirement.
