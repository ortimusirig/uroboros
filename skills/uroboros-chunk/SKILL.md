---
name: uroboros-chunk
description: 'Decompose a wave-scale goal into small, independently plannable uroboros units BEFORE spending loop tokens; use when a goal spans more than one file-cluster or names several distinct behaviors. Runs in the CALLING session so the chunker keeps its accumulated project context.'
---

# Chunk a wave goal into loop-sized units

Measured motivation (2026-08-31, one machine, one day): six wave-scale goals
produced zero converged plans across three planner generations — the final
judged-convergence build honestly returned pivot-conclude — while five small
units shipped to completion in this repository the same day. Plan convergence
decays with goal scope for context-free drafting seats. Decomposition belongs
UPSTREAM of the loop, in the session that holds the project's context.

## Where this skill runs — and why that is the design

This skill executes in the calling Claude Code session, not in a spawned
seat. Two measured reasons:

1. A spawned seat is stateless; cold-reading a repository at wave scale is
   exactly the failure mode above. The caller holds the dissections, owner
   rulings, and memory that make chunk boundaries correct.
2. Spawned seats hit capability walls the caller does not (measured:
   Cursor's command runner refuses execution in -p mode — RAN_TESTS: no),
   which is the same lesson that made the harness the evidence runner.

## The contract: reasoning decides, determinism verifies and advises

The MODEL decides — from understanding, never from rules:
- chunk boundaries, chunk count, and granularity (no size caps, line
  budgets, or keyword splitters anywhere);
- ordering and parallelism, from real dependency reasoning ("unit 2 edits
  the file unit 1 creates");
- whether the goal is even worth a campaign (one piece, or hand-build, are
  both legitimate answers).

Determinism keeps its two honest jobs, and only those:
- RUN each unit's evidence commands now and report what happened — a
  command that cannot run today is a fact, not an opinion. (Terminology per
  the no-green-no-red direction: these are evidence commands, not gates;
  read no verdict field.)
- VERIFY declared structure: the dependency graph is acyclic; parallel
  units touch disjoint files. A contradiction is reported back for ONE
  bounded self-revision — never silently rejected, never gating.

Advisory-only observations are welcome ("unit 3 touches 14 files; units
this wide historically did not converge") and must never gate.

## Procedure

1. Read the goal and the relevant code until the cut points are understood —
   not skimmed. Each unit should be one file-cluster / one coherent
   behavior, small enough that a cold drafting seat can plan it.
2. Write one goal file per unit. Each carries: precise file anchors, the
   project contract the implementation must follow (helpers to reuse, test
   style exemplars BY PATH), explicit Test requirements in prose (the
   durable verification form), and evidence commands that are runnable on
   the CURRENT tree (pair any -k keyword for new tests with an existing
   green module so collection is non-empty today).
3. Declare dependencies and parallel groups from reasoning; run the
   structure verification; fold any contradiction back once.
4. Emit the queue/campaign file. Sequential unless parallelism was
   affirmatively reasoned; landings are always serialized by the loop.
5. Babysit: the loop's heartbeat advises, the SESSION decides. If a unit's
   debate stalls, degrade THAT unit to a task unit with a caller-written
   plan; the campaign keeps moving. No hard timeout kills anything.

## Failure modes this skill exists to prevent

- One giant goal → pivot-conclude after long deliberation (measured).
- Evidence commands that collect nothing on the current tree (measured:
  pytest exit 5 read as a broken command by the retired plan gate).
- Citations in generated plans pointing at absolute paths (measured on
  Windows: /C:/... forms) — the goal files this skill writes always use
  repo-root-relative anchors so drafts inherit them.
