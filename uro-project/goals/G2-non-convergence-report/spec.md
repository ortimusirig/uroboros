# G2 — The non-convergence report

**Status:** owner-ruled 2026-09-03. Constitution rule 9 is the governing text.

## The ruling

The owner ruled **A + C** on the "best available plan" question:

- **A stands.** The convergence law is unchanged. A debate that does not converge
  produces no runnable units. Silence is never consent; neither is a good plan the
  seats declined to agree on. The supervisor reads the record, authors task units
  by hand, and signs for them — as happened for G1.
- **C is added.** The engine must leave a durable report behind. Not an archive:
  a risk register that travels with the work the supervisor authors from it, so
  an objection the seats raised and never settled is visible during execution
  rather than rediscovered as a surprise when the code misbehaves.

## Why this is needed

Nine decompose debates on uroboros and eight on EULR produced zero natural
convergences on complex goals — while producing excellent critique every single
time. Run 8's pivot judge praised the plan it then had to conclude on
("well-scoped… nothing indicates the design is unsound") because the seats kept
finding genuinely new detail rather than cycling on old detail.

Under A alone, that critique lives only in the run's raw event stream. G1's five
task units were authored from nine debates' worth of findings that now exist
nowhere a reader can follow — the supervisor's transcription is the only surviving
trace, and it recorded what was SETTLED, not what was still contested. When T5
landed with a tautological coverage check, the landing judge caught it fresh; the
debates may well have flagged that shape earlier, and nobody could check.

## What the engine already carries

This is a rendering problem, not a collection problem. `runConversation`'s
`finish()` result (src/conversation.js:362) already carries every field the
report needs:

- `reason` — the terminal state (`pivot-conclude`, `rounds-exhausted`,
  `proposal-irreparable`, `verifier-unlaunchable`, …)
- `storm` / `stormHistory` — per-round draft attempts with per-seat ok/error
- `roundHistory` — per round: each seat's `reviewRow` (agree, readable,
  suggestions, questions, unavailable, stanceReasked, stanceRepaired, and the
  raw content when a stance was unreadable), the agreement judgement, and
  whether that round converged
- `pivotHistory` — each pivot decision, its reason, whether it was unjudged,
  and the raw answer when the engine's own ladder had to decide
- `capabilityVetoes` — capability findings per round
- `seatOutages` — a capped or refusing seat, named at every terminal
- `tokens` — the conversation's usage

Nothing new needs to be measured. What is missing is a writer.

## Required behavior

1. **A report is written on every non-converged terminal**, for both tiers, into
   the goal or project directory the debate was working in — beside the artifacts
   a converged debate would have written, so a reader finds it where they would
   look for the plan.
2. **The report names, at minimum:** the terminal reason in the engine's own
   vocabulary; the final plan as it stood; each seat's closing stance with its
   state (agree / disagree / stance-unreadable / unavailable) and its reasons;
   every finding that recurred across rounds, marked as recurring; the pivot
   judge's assessment verbatim where one was given; any capability veto; any seat
   outage with its remedy.
3. **Unsettled objections are the report's spine**, not an appendix. A reader
   scanning it must be able to answer "what did the seats object to that nobody
   resolved?" without reading the whole document.
4. **The report is self-declaring about its own bounds** (constitution rule 3).
   If it truncates a long finding list or a long raw answer, it says so and says
   by how much.
5. **The supervisor's hand-authored units reference the report.** A task unit
   authored from a non-converged debate carries a pointer to the report that
   debate produced.
6. **Never silently absent.** If the report cannot be written, the run says so
   loudly — a non-converged terminal that produced no record is itself a failure.

## Invariants

- No runnable unit is generated from a non-converged debate. This goal adds a
  document, never an execution path. (Constitution rule 9, first sentence.)
- Zero runtime dependencies. Node built-ins only.
- Windows first: the report path must work under win32.
- Existing suite stays green.
- Any bound the report introduces joins the determinism-and-caps audit table.

## Out of scope

- Consent gates, "best available plan" terminals, or any path from a
  non-converged debate to runnable units. That was option B; the owner ruled A.
- Changing the convergence law itself.
- Retroactive reports for runs whose event streams are already gone.
