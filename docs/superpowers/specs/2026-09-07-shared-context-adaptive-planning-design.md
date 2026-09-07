# Shared working memory and adaptive planning design

Date: 2026-09-07

Status: approved direction, detailed design awaiting user review

Source baseline: `9501282aedd6901d69bb568d93a444acf14a865c`

## Plain-language agreement

Both coworkers need the same project notebook. Claude must not plan using important information missing from Codex's review, and Codex must not implement using important information missing from Claude's review. They share the facts and history, but form independent judgments.

Start with one Claude draft and one Codex review. Claude decides whether another planning discussion is useful, with a maximum of three rounds per cycle. A genuinely new execution discovery may justify another bounded planning cycle even after the original three rounds were used. Repeating an old disagreement or restarting a process does not qualify.

The user explicitly agreed to the fresh-cycle recommendation, then clarified that shared context is the reason for wanting shared memory, for both planning and execution review. Shared working memory is therefore a core requirement, not an optional later convenience. Engram is an optional storage/search implementation for longer-term recall; it is not a substitute for delivering the current context.

## Scope and delivery order

1. Shared working-memory snapshots and verified handoffs across both phases.
2. Adaptive planning and evidence-backed reopening using those snapshots.
3. Separately approved, pinned Engram integration for curated cross-session search.

The first two items are one coordinated design with independently testable deliverables. The third is a separate subsystem and will get its own implementation plan and Windows acceptance tests. This design does not install Engram, change global CLI configuration, enable broad MCP servers, add a model provider, or replace Uroboros with Omnigent. Runtime/plugin paths and the chosen Claude/Codex models remain unchanged. Memory data stays project-scoped in existing artifact storage; no external database or new live-data location is required for the working-memory foundation.

## 1. What context parity means

Every author and reviewer receives the same versioned **shared grounding context** for the artifact being judged. Role instructions still differ: authors propose/implement; reviewers challenge/check. Equal grounding does not mean identical prompts, agreement, or access to hidden model reasoning.

The context must include:

- Original user requirements, explicit constraints, acceptance criteria and relevant prior decisions.
- Plan/gate versions, approved assumptions, unresolved questions and recorded dissent.
- Relevant project constitution, repository survey and pinned source/evidence references.
- Previous plans, failed approaches, failure ledger and pivot reasons when supplied to any planning seat.
- During execution: the approved planning context, actual implementation changes, relevant discoveries, attempted fixes, command/test output references and current review findings.

The host cannot automatically recover an outer chat, private provider memory or every independent tool observation. Relevant outer-chat information must be deliberately exported as a supplied briefing. No automatic ingestion of global histories or credentials is permitted. Facts not captured in the notebook cannot be claimed as shared.

## 2. Shared working-memory record

Introduce a provider-neutral, versioned context envelope with these semantic fields:

- `version`, stable `id`, content `digest` and optional `parentDigest`.
- Logical project and unit identity, run lineage, phase and source revision.
- Typed entries for requirements, decisions, assumptions, findings, observations and evidence.
- Each entry has a stable ID, content or pinned artifact reference, provenance, source digest where available, status and optional `supersedes` link.
- Status distinguishes user requirements, observed facts, agent proposals, approved decisions, unresolved disagreement and superseded information.

A digest identifies bytes; it does not prove truth or comprehension. Compute it from canonical context content and source identities, excluding the digest itself and mutable delivery metadata. Project identity must survive isolated-worktree path changes without mixing unrelated projects. Sensitive values are excluded before constructing the common snapshot, so both seats see the same redacted context. A redacted or unavailable requirement that prevents review must be surfaced as missing, not silently guessed.

Persist immutable snapshots beside the existing run artifacts. Keep original inputs, evidence and raw delivered responses as the audit source; the notebook is an organized view of them, not a replacement. Required small context is delivered directly. Large evidence is retained under stable references with a manifest; a summary may help orientation but cannot replace required evidence.

## 3. Delivery and discovery protocol

Before each role call, the harness prepares a receipt identifying the role, phase, snapshot digest, exact rendered input digest and supplied evidence manifest. Finalize its delivery status from actual transport evidence: prepared input is not successful delivery, and a failed launch cannot be reported as context received. Keep the original input record even when a call never runs. A successful receipt identifies what was supplied, not that the model understood it.

For planning, propagate shared context through initial drafting, alternative selection when explicitly requested, revisions, final Codex review and final-decision calls. Selection is a separate process: information sent only to the selector does not count as delivered to the final reviewer.

Before Codex review, any material new information Claude used must become a sourced context delta. A delta records what changed, where it came from and which assumption or decision it affects. Independent reviewer discoveries are shared back before Claude's next continuation/revision judgment. Both roles are instructed to surface missing or unrecorded context. Provider tool traces are attached when actually available; unavailable traces are reported, never fabricated.

For execution, Codex receives the approved plan and its exact context snapshot. Its discoveries and command evidence extend the record. Claude reviews the resulting implementation against that same inherited context plus the captured execution deltas. Changed code/test evidence does not overwrite the planning history.

A claimed observation without captured evidence remains an attributed claim. Reviewers can request additional context or independently verify it. Missing required context returns an explicit context-incomplete state, retaining work and evidence. It is not a clean review.

## 4. Approval binding, resume and queue handoffs

Planning approval binds requirements, proposal/gate identity and shared-context digest. Execution approval binds the implementation/evidence identity and execution-context digest in addition to existing current-diff checks. An approval for one snapshot does not approve a changed snapshot.

Carry the context reference and planning-cycle receipt through queue launch, manual checkpoints, resume, execution and fresh replanning. Resume validates pinned artifacts/digests and reuses the saved counter; it does not silently retrieve newer memory or substitute current file contents for historical evidence. Growing the audit log does not mutate a prior input snapshot. A material context change creates a new snapshot and requires approval bound to that version.

Legacy records lacking shared-context receipts remain readable as historical evidence. Do not manufacture verified-parity receipts. A legacy in-progress run requires reconstructed context and a fresh phase-appropriate review before new approval; if reconstruction is incomplete, report what is missing and retain the checkpoint. A saved unbounded planning limit migrates to three without erasing used rounds; an already exhausted cycle cannot draft again without an eligible fresh-cycle decision. Old completed records are not rewritten.

Existing human authority and explicit immutable manual mode remain intact. Retrieved memories never grant permission, approve an artifact, change sandbox settings or authorize external writes.

## 5. Adaptive planning cycle

Definitions:

- One substantive round is a Claude proposal followed by Codex review.
- Default initial candidate breadth is one, not three. Explicit alternative exploration may remain available and must be reported separately.
- Default and maximum substantive rounds per cycle are three; callers may request one or two. Explicit values above three are rejected with a clear message.
- The first round is mandatory. Rounds two and three are used only after Claude chooses to continue.

After each completed draft/review exchange, obtain a separate read-only Claude continuation judgment containing `continuePlanning`, a concrete `reason`, `artifactDigest` and `contextDigest`. It explains what an extra discussion will resolve; it does not rewrite the plan or set approval. Route it through the Claude planning transport with the configured Claude model. Record this control call separately from substantive rounds and include its usage.

A missing, stale or malformed continuation cannot authorize another round. Permit one format-only repair, then report the judgment unavailable/unreadable while preserving state. Existing bounded artifact/review format repairs stay distinct from substantive rounds; they are recorded and cannot reset the cycle. A three-round limit is not a three-model-call or fixed-time promise.

Decision outcomes:

| Current situation | Result |
|---|---|
| Valid current plan approval and Claude chooses to finish | Proceed with that exact approved artifact/context |
| Claude requests another round and a round remains | Revise, then obtain fresh Codex review |
| Claude requests another round at round three | No fourth round; final authority may approve the current valid artifact or stop unapproved |
| Codex rejects and Claude declines more discussion | Unresolved; use existing human/manual or Codex/autonomous final-decision route, never automatic approval |
| Final authority requires revision but no permitted continuation remains | Stop unapproved with the reason and retained work |
| Required context, model response or approval is missing | Report incomplete/unavailable; do not execute an unapproved plan |

Do not force a second substantive round merely to reach a dispute-routing branch. Codex remains autonomous planning authority; Claude remains autonomous execution authority; humans settle unresolved manual disputes. Broad execution debate/challenge/campaign limits are separate and remain unchanged.

## 6. Execution-triggered fresh cycle

Claude may request focused replanning when actual execution evidence materially changes a planning assumption, reveals a missing requirement or invalidates the current approach. Retain the existing amend/fresh/conclude decision vocabulary, adding a structured reopening explanation.

The reopening record contains parent cycle identity, affected finding/assumption IDs, retained evidence references and a novelty explanation. The harness validates source scope, evidence identity and prior consumption. Claude judges whether the evidence is materially new; a different hash, timestamp, filename or paraphrase alone does not establish novelty.

An accepted fresh cycle:

- Starts with one draft/review round and has its own maximum of three.
- Inherits relevant context, prior decisions, completed work and the reason the prior plan no longer suffices.
- Links to the prior cycle, preserving used rounds and history.
- Requires current Codex approval before implementing a changed plan.
- Cannot be reopened again from the same consumed evidence/reason merely by changing IDs or restarting.

A retry/resume is not a fresh cycle. Ordinary execution correction remains execution; a substantive plan change cannot bypass planning review by being called an amendment.

No new numeric project-wide cycle ceiling is introduced by this design. Existing configured run/cost/time budgets continue to apply and must be shown in the report; the implementation must not claim that three rounds per cycle bounds the total work of a multi-goal project. Further global budget policy is outside this approved behavior.

Manual fresh planning retains human decision authority but still records context, provenance and the new cycle. Destructive cleanup, deployments and production-database access are not implied by permission to replan.

## 7. Shared memory versus Engram

The required working notebook is application-owned and delivered explicitly, so correctness does not depend on an agent remembering to search a memory tool. Longer-term recalled entries can be proposed for inclusion, then frozen into the same snapshot delivered to both seats.

A future Engram adapter should be optional, project-scoped and replaceable. Use the reviewed Gentleman-Programming project, a pinned artifact, ordinary storage/search and a single application-owned write path. Do not silently enable its optional extra-model semantic scan or broad CLI setup helper. Validate Windows startup, concurrency, provenance, export/restore and unavailable-store behavior before enabling it. Do not treat an arbitrary search hit or an old approval as current authority.

An optional search-store outage can fall back visibly to existing artifacts. Missing required current context or approval cannot. The reviewed research remains the basis for selecting a backend; no performance or token-saving guarantee is assumed.

## 8. Code boundaries and verification

Keep context construction/validation/persistence in a focused module, separate from planning policy. Integrate at the existing planning seats, decomposition, execution/reviewer prompt assembly, queue runtime, checkpoints/resume and report/event boundaries. Do not restructure unrelated runtime folders.

Required acceptance cases:

1. A constraint supplied only in Claude's former drafting input appears in the final Codex review input with the same snapshot digest.
2. Candidate selection and later revisions cannot drop failure history, prior-plan context or assumptions.
3. A Codex execution discovery and its actual command evidence reach Claude's review input.
4. Both directions preserve source versions, unresolved disagreement and supersession without copying a model's private reasoning.
5. Missing/stale context cannot produce approval; new context invalidates old receipts.
6. Queue, restart and manual resume preserve context/cycle identity, consumed evidence and round counts.
7. One-round completion, Claude continuation, round-three exhaustion and Claude-stop/Codex-reject have the outcomes specified above.
8. New execution evidence can start a fresh three-round cycle after an exhausted one; replayed evidence cannot.
9. Model/provider settings, manual/autonomous authority and unrelated execution/campaign limits remain unchanged.
10. Failed launches remain undelivered; missing required evidence, cross-project references and changed source identities cannot masquerade as shared context.
11. Fake-provider tests prove the delivery/controller invariants without live inference. A later bounded real-provider acceptance run is separately labeled; no test proves identical understanding inside both models.

## Review and implementation boundary

This specification records the agreed behavior plus the user's subsequent context-parity requirement. It is not an implementation-completion claim. The main agent self-checks scope, ambiguity, placeholders and contradictions, then asks the user to review this written design before creating the implementation plan, as required by Superpowers brainstorming.

No push, merge, release, installation or runtime change is part of saving this design. PR5's existing branch and the user's operational checkout are preserved.
