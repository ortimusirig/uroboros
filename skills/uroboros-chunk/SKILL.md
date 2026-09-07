---
name: uroboros-chunk
description: 'Use when a uroboros goal spans several behaviors or file clusters and needs bounded goal units, dependency ordering, or a queue before execution.'
---

# Chunk a wave goal into loop-sized units

Claude prepares bounded goals in the calling session using its project context. The generated
plan or decomposition then follows the same reviewed planning protocol as `plan` and `decompose`:
Claude authors, Codex reviews, and both answer the actual previous arguments.

## Mode and approval contract

Use `--mode manual` by default on `plan`, `decompose`, `queue`, `batch`, and `run`.
An unresolved planning dispute requires a human ruling in manual mode. In autonomous mode,
Codex makes the final planning decision; Claude makes the final execution decision after Codex
implements and can correct or rebut findings. Approval is tied to current goal, plan and evidence
configuration. `approved: true, converged: false` records reviewer approval with retained dissent,
not consensus. An unavailable reviewer never approves.

Provider options are `--claude-model sonnet --codex-model gpt-6-astra --codex-effort high`
(the defaults). Replace obsolete `--planner-model` and `--verifier-model` overrides with these
provider options. `--arbiter-model` and `--executor-model`/`--executor-effort` are retained
aliases and must not conflict with canonical values.

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
  command that cannot run today is a fact, not an opinion. (They record true exit codes and output; approval still requires the phase reviewer.)
- VERIFY declared structure: the dependency graph is acyclic; parallel
  units touch disjoint files. A contradiction is reported back for ONE
  bounded self-revision and correct invalid structure before handing it to the loop.

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
5. Supervise the queue using its heartbeat and retained messages. If planning needs a decision,
   preserve the pending checkpoint and mode; use the human ruling path in manual mode or the
   Codex final ruling in autonomous mode. Do not replace the pending unit with a caller-written
   task to bypass its approval. A quota failure, unreadable reply, or exhausted bound remains
   unfinished work.

Example after preparing bounded goal files:

    node bin/loop.js queue --file queue.json --mode autonomous

## Failure modes this skill exists to prevent

- One giant goal → pivot-conclude after long deliberation (measured).
- Evidence commands that collect nothing on the current tree (measured:
  pytest exit 5 read as a broken command by the retired plan gate).
- Citations in generated plans pointing at absolute paths (measured on
  Windows: /C:/... forms) — the goal files this skill writes always use
  repo-root-relative anchors so drafts inherit them.
