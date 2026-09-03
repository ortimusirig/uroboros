## Title
T4: The report travels with the work, and the docs say it exists

## Provenance
Read `../non-convergence-report.md` first. This unit satisfies the half of
constitution rule 9 the other three tasks do not reach: *"That report travels with
whatever work the supervisor authors from it, so an objection the seats raised and
never settled is visible during execution rather than rediscovered as a surprise
when the code misbehaves."*

A report nobody encounters during execution is the shelfware risk the owner
weighed when ruling. This unit is what makes the ruling more than an archive.

## Required behavior
- The queue log row for a run carries a pointer to the non-convergence report of
  the debate its task unit came from, where one exists. The report's own
  provenance section is the model: a reader holding a queue log can reach the
  objections that were live when the work was authored.
- The pointer survives the failure path. The report's round-1 codex-S7 finding is
  binding: a task-unit launch failure or a facts-read failure uses an earlier
  catch-path log row, and a pointer added only to the normal post-facts row is
  silently absent exactly when a run went wrong — which is when a reader most
  needs the objections. Both paths carry it.
- `docs/usage.md` and `README.md` state that a debate ending without convergence
  writes `non-convergence-report.md` beside where its runnable artifacts would
  have gone, and that no task units are produced from such a debate.
- Any bound this unit introduces joins the determinism-and-caps audit table in
  `docs/superpowers/specs/2026-09-01-decomposition-spine-design.md`, per that
  table's closure clause and constitution rule 3.

## Invariants
- The pointer is a pointer. This unit does not copy, archive, or duplicate the
  report — the goal's ruling is explicit that it is not an archive.
- A run whose debate converged carries no pointer and no empty field.
- Zero runtime dependencies. Windows-first.
- The existing suite stays green.

## Test requirements
- A queue log row for a unit authored from a non-converged debate carries the
  report pointer; one from a converged debate does not.
- **The catch-path control**: a run whose task-unit launch fails, and a run whose
  facts read fails, each still carry the pointer in the log row they actually
  write. A test that exercises only the normal path cannot see codex-S7.
- A docs test or grep-level assertion that the usage and README wording exists,
  in whatever form this repository already uses for documentation assertions.
- Run: `node --test` — the whole suite.

## Out of scope
Rendering (T2), writing (T3), any change to what the report contains. Enforcing
that a supervisor actually reads the report — that is a human obligation the
constitution states and code cannot check.
