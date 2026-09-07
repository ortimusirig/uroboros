# Shared memory and issue-driven coworker dialogue

Date: 2026-09-07

Status: user approved the eight-point design in conversation; revised written specification awaiting final review

Source baseline: `9501282aedd6901d69bb568d93a444acf14a865c`

This revision supersedes the earlier three-round controller proposal in this file. Its historical text remains in commit `3466247`. It does not replace the approved two-agent roles or existing operational checkout.

## Plain-language agreement

Claude and Codex work as independent coworkers with one project notebook. Both receive the relevant problem, constraints, evidence and history. Each can investigate further than the other did, challenge an assumption, answer a question, concede an error or rebut an incorrect finding with evidence.

Planning starts with one Claude draft and an independent Codex review. Thereafter, discussion follows actual issues, not a mandatory three-round ritual. A question does not automatically cause a complete new plan. Execution uses the same conversation model with Codex as implementer and Claude as reviewer.

Autonomous final authority remains Codex for planning and Claude for execution. Humans settle unresolved manual disputes. Delivery is not agreement, consensus is not proof of correctness, and resource exhaustion is never approval.

## Scope and delivery order

1. Application-owned shared working context and a basic persistent project notebook.
2. Issue-driven conversation used by both planning and execution, integrated with existing approval, evidence, queue and continuation facilities.
3. Documentation, reports and fake-provider integration coverage for those boundaries.

These are one coordinated first implementation, with small separately testable modules. Engram search and acpx session transport remain optional later pilots, not dependencies or prerequisites. No new external database, daemon, model provider, global MCP registration, CLI authentication change or replacement orchestrator is included. Existing executable/plugin paths remain stable.

Keep Uroboros on its existing Node runtime and Claude/Codex transports. Required context is supplied explicitly on each call; persistent provider sessions may optimize later but are not relied upon for correctness.

## 1. Shared context and independent investigation

Every author and reviewer receives a versioned shared grounding snapshot for the artifact under discussion. Role prompts differ, but neither may silently lose relevant facts supplied to the other. Required content includes:

- Original user requirements, constraints, acceptance criteria and relevant explicit decisions.
- Current plan/gate identity, assumptions, unresolved questions and dissent.
- Project constitution, repository survey and pinned source/evidence references.
- Previous plans, failed approaches, failure ledger and pivot reasons supplied to a planning seat.
- During execution: approved planning context, actual diff, discoveries, attempted corrections, command evidence and review findings.

Author rationale is labeled as an attributed position, not established truth. Both roles may inspect other authorized files, callers, dependencies and tests from the same review snapshot. Share material additional findings back into the notebook and conversation. Neither role's reading list limits the other's investigation.

The host cannot automatically recover an outer chat, hidden model state or every tool observation. Relevant outer-chat information must enter a deliberate briefing. Do not ingest global conversation histories or credentials. Share concise reasons, assumptions, findings and verifiable evidence, not private reasoning traces. Uncaptured information cannot be reported as shared.

## 2. Two-layer memory

### Current-work snapshots

Use a provider-neutral envelope with schema version, stable snapshot ID, digest, optional parent digest, project/unit/run lineage, phase, source revision and typed entries.

Each entry has a stable ID, content or immutable artifact reference, provenance, source identity, status and optional supersedes relationship. Distinguish requirements, observed facts, attributed claims, assumptions, proposed decisions, approved decisions, disputed material and superseded entries. Conflicting observations remain visible rather than being silently averaged or overwritten.

Canonical digests exclude their own digest field and mutable delivery metadata. A digest proves byte identity, not truth or comprehension. Redact sensitive values before creating a common snapshot. If redaction or inaccessible evidence makes review impossible, mark context incomplete.

Persist immutable snapshots beside durable run artifacts. Preserve original inputs and evidence as the audit source. Required small context is inlined; larger material is retained under pinned, accessible references. Summaries orient the reader but do not replace required evidence or silently truncate judged content.

### Project notebook across runs

Store curated decisions, failed approaches, lessons and evidence references under the configured durable artifact root, separated by logical project identity. A registry binds project identity to verified repository identity; linked worktrees share their verified common repository, while unrelated clones/projects remain separate by default. Matching remote URLs alone do not merge memories. Moving/rebinding a project requires explicit validated mapping.

V1 provides project-scoped listing and deterministic text/tag lookup through a small internal memory interface. At a new work item, retrieve relevant entries as attributed historical context, freeze selected entries into the shared snapshot and show the selection manifest. Do not automatically inject an entire project's history. Required user constraints do not depend on search ranking.

Both agents propose memory updates; Uroboros validates scope/provenance and is the sole writer for a run. Serialize project-level notebook updates with a lock and immutable entry versions. Multiple runs cannot overwrite each other's findings; unresolved conflicts remain separate entries. Do not infer permission to break a live lock or to coordinate simultaneous writers on different machines through OneDrive.

Promote approved decisions and evidenced lessons after their disposition is recorded. Unsupported or disputed claims may be retained with that status, never promoted to verified facts. Recalled evidence is checked against current code before becoming a current fact. Notebook availability is optional for historical recall; required current-work context and its durable conversation journal are not optional.

The project notebook stores no account credentials and grants no execution permission. Normal exports/backups contain project records and evidence references; a future external index must be rebuildable from these records.

## 3. Issue and message contracts

Introduce a versioned, append-only dialogue journal whose correctness-critical writes are distinct from best-effort progress events. Each issue has a stable ID, title, phase, opener, affected artifact/context identities, related issue IDs, severity/blocking status and explicit disposition history.

Messages have stable IDs and sequence, sender/recipient bound by the harness seat, reply-to, issue IDs, artifact/context digests, ordinary-language content and evidence references. An agent cannot impersonate the human or the other seat by emitting a sender field.

Supported conversational actions are:

- Ask for clarification or missing evidence.
- Answer with an explanation or evidence.
- Raise/challenge a finding.
- Rebut or withdraw an objection with reasons.
- Propose a revision, then deliver the actual revised artifact.
- Request verification or a final authority decision.
- Record a validated disposition or current-artifact approval.

Use a machine-readable envelope around natural-language messages. A response can address several related issues. Do not force one tiny call per question, impose round-robin full-document rewriting, or require agents to invent objections when the first independent review is clean.

Issue states distinguish open discussion, awaiting evidence/answer, revision requested, awaiting verification, resolved and needs-decision. Resolution records distinguish verified correction, objection withdrawn, false-positive/duplicate/pre-existing classification with justification, and authority-imposed disposition. A blocking issue cannot be silently parked; the authorized decision-maker must explicitly resolve its blocking status and record why. Mandatory safety and permission checks are not overridden by an agent's decision.

Legacy stance/review outputs remain readable. A new-mode response with no valid envelope, incomplete required fields or stale identities is not consent. One format-only repair is allowed per malformed envelope; further failure preserves the state and reports the response unreadable. Existing artifact-repair controls remain separate, and every provider attempt is resource-accounted.

## 4. Delivery, dispatch and authoring

Before each call, durably prepare the operation ID, recipient, shared snapshot, exact rendered input digest, evidence manifest and unread-message IDs. Finalize delivery status only from observed transport evidence. Prepared input and a model echoing a digest do not establish successful delivery or comprehension.

Supply required common context, issue history and pending messages through the actual CLI launch input. Receipt/acknowledgment is distinct from approval. A mailbox or MCP tool installed in the outer application does not establish subprocess delivery; preserve the existing restricted MCP boundary.

V1 serializes turns inside Uroboros. A question goes to the counterpart capable of answering it. An author response or updated artifact returns to the reviewer for verification. Agents identify the useful next action and why; the controller validates seat, scope, version and budget before dispatch. No extra third model is needed merely to choose the next speaker.

Conversation-only turns are read-only for the project artifact. Only the designated author/executor can change it during an explicit revision/implementation step. Reviewers can independently inspect and run permitted checks in an isolated review environment; they do not modify the implementation under review. Harness-owned evidence/output sidecars are separate from project edits.

Planning integrates the snapshot through drafting, optional candidate selection, discussion, revision and final Codex decisions. Information supplied only to a selector does not count as delivered to the final reviewer. Material author discoveries become context deltas before review.

Execution begins from approved planning context. Codex's findings and command evidence extend it, and Claude receives that inherited context plus current implementation evidence. Pure explanation does not launch another coding step. Substantive plan changes return to Claude planning and Codex review before implementation; ordinary corrections within the approved plan remain execution work.

## 5. Completion and decision authority

A clean first review can finish without further discussion. Otherwise, dialogue continues while an unresolved material issue has a useful next question, check, rebuttal or correction.

Models judge issue validity and whether further investigation can help. The controller enforces identities, permitted operations and explicit resource limits. Detect repeated identical issue state/messages without new evidence; before repeating that same exchange again, route the recorded positions to the established final authority. Do not declare semantic novelty merely because a string or hash changed.

An author may challenge a review and explain why another investigation is useful, but cannot veto the designated final reviewer indefinitely. Autonomous planning decisions belong to Codex; autonomous execution decisions belong to Claude. Manual unresolved decisions use human checkpoints. Preserve disagreement in reports when authority decides without consensus.

Approval binds the exact plan/gate or code/evidence identity and material shared-context snapshot. New substantive artifact or context changes invalidate prior approval. A conversation acknowledgment or adding audit metadata does not itself change artifact identity. Before phase completion, all blocking issues have explicit validated dispositions, required checks have acceptable recorded outcomes, and current-artifact approval is valid. An authority decision that requires changes is not approval of changes that have not happened yet.

Missing required context, unavailable providers, invalid responses or exhausted resources end or pause unapproved with retained work and an actionable reason.

## 6. Resource safeguards and compatibility

No default three-round limit is introduced. Initial candidate breadth defaults to one; explicit alternative exploration remains supported.

Retain existing controls as separate concepts:

| Existing control | V1 compatibility |
| --- | --- |
| Planning/decomposition --rounds N | Preserve any positive safe integer as an explicit proposal/review-cycle limit; omission adds no such cycle cap. Question/answer-only turns do not consume a proposal cycle. |
| --candidates and --pivot-candidates | Preserve explicit supported breadth; alternative drafting/selection is reported and resource-accounted separately. |
| Execution URO_DEBATE_ROUNDS / debateRounds | Preserve the explicit execution correction/review limit; do not repurpose it as a dialogue-message cap. |
| Internal challengeRounds | Preserve its existing bounded executor-challenge semantics; ordinary dialogue is not a back door to retry that same exhausted challenge. |
| Batch --rounds and per-task --round | Preserve campaign refinement meanings and existing validation. |
| Existing token budgets and stage timeouts | Preserve their scope and results; pass remaining relevant budgets into child launches instead of silently resetting them. |

For an explicit planning --rounds 1, explanation and evidence exchange may continue on the first artifact within resource bounds. A second proposal cycle is forbidden. If the final decision requires such a revision, return unapproved with the limit explained.

New proposed safety default, made explicit for written-design approval: at most **24 provider launches per work-item lineage**. This is an emergency resource ceiling, not a target conversation length or a limit of 24 rewrites. It covers initial drafting, candidates/selection, discussion, review, implementation, repairs, final-decision calls and fresh planning within that work item. Expose --max-provider-calls N on planning, decomposition, execution and queue entry points; queue applies it to each unit, and all values must be positive safe integers. The limit is shown before work starts and in reports; neither agent can raise it.

Add --active-time-budget-ms N to the same entry points, disabled unless configured with a positive safe integer; existing per-stage timeouts remain effective. Active-time accounting excludes time awaiting human input or a process being offline, survives continuation, and is checked before launching new work. It is a dispatch budget, not a promise to kill an in-flight write at the deadline. Report any overrun by a call already in flight. Token/call/time limits are distinct; missing provider token accounting is unavailable, not zero.

Reserve a call budget slot durably before launch. A failed or uncertain attempted launch consumes the slot rather than allowing infinite free retries. A failure proven to occur before launch can be recorded as not attempted. Parent queue/campaign constraints and per-item constraints both apply; nested operations cannot bypass whichever budget is tighter.

A newly queued unit has its own work-item allowance while remaining under parent limits. Resume, issue reopening, fresh replanning and phase changes within a unit do not reset that unit's accounting. Existing saved explicit limits are preserved. A budget stop retains state but never spends another unbudgeted call to obtain a final verdict.

## 7. Execution discoveries and reopened planning

When execution evidence materially changes a planning assumption or invalidates the approach, Claude may request focused fresh planning using the existing amend/fresh/conclude vocabulary. Record the affected issue/assumption, source/evidence, parent discussion and a concrete novelty explanation.

Retain completed work, prior decisions and consumed budgets. New planning starts from that accumulated notebook; it does not erase earlier discussion or create another three-round allowance. Codex must approve the revised plan before implementation resumes.

The harness validates evidence scope, identity and prior consumption; the reviewer judges material novelty. Repeating an old dispute, changing a filename or restarting a process is not a fresh discovery. New evidence may legitimately reopen a resolved issue; preserve its previous resolution and explain why it no longer suffices.

Manual authority and original run mode remain intact. Permission to replan does not authorize deployment, destructive cleanup or production access.

## 8. Durability, queue handoff and migration

Persist dialogue state before side effects: snapshot references, ordered messages, pending deliveries, issue dispositions, artifact identities, resource counters, next action and operation/result receipts. A single run controller owns mutations. Replay verifies sequence and integrity; corruption cannot be ignored because progress-event readers happen to tolerate partial tails.

Use operation IDs and saved outcomes to prevent replaying completed edits, provider calls or landing commits. A crash after an external action but before its result is durable has an uncertain outcome; reconcile available evidence and stop for attention when necessary. Do not promise exactly-once external execution or automatically repeat an uncertain mutation.

Queue handoffs carry approved context, planning conversation references, project/work-item identity and applicable remaining budgets into execution and fresh planning. Archive required records outside disposable worktrees before cleanup. Required dialogue persistence failure pauses before further mutation; an optional long-term-search outage may visibly fall back to available records.

Version existing checkpoints explicitly. Validate version-1 digest/answer receipts before migration, retain the original envelope, and issue a new revision/digest for changed semantic state. Preserve manual/autonomous mode, role authority, consumed rounds/usage, candidate selection, findings, pending decisions and queue position. Never fabricate old context-delivery receipts. Reconstruct legacy context and require fresh appropriate review before new approval; missing evidence remains an actionable incomplete state.

Preserve public resume --run ... --decision-file ... for human decisions and reject stale or replayed answers according to existing receipt semantics. Add a mutually exclusive --continue form only for resumable technical interruptions with no pending human decision and unchanged saved limits/mode. It cannot bypass a human checkpoint, change authority, raise an exhausted budget or replay an uncertain operation. Budget exhaustion returns unapproved; changing limits requires a separate explicit user-approved continuation workflow, which is not included in v1.

Legacy historical completed runs remain readable and unchanged. Preserve existing integer rounds results for queue consumers, and add separate dialogue-message/provider-launch/resource counters rather than changing the old field's type or meaning. Reconstruct legacy launch accounting only from actual receipts/history, not by equating rounds with calls. If consumed resources cannot be established sufficiently to enforce the saved allowance, preserve the known counts and report accounting incomplete before further unattended launches; never initialize unknown past usage to zero.

## 9. Reports, boundaries and verification

Keep focused modules for shared context, project notebook and dialogue state/dispatch. Integrate them at existing planning/decomposition seats, execution/reviewer prompts, artifact retention, checkpoints/resume, queue and report boundaries. Do not restructure unrelated runtime folders or replace existing review isolation.

Reports show the shared-context version, recalled memory manifest, issue threads and evidence, delivery versus agreement, changes and their reasons, unresolved matters, authority decisions, resource consumption/limits and the next actionable status. Provide a readable conversation view using existing report surfaces, not a new dashboard subsystem.

Required acceptance cases:

1. Former author-only planning constraints, failure history and pivot context reach the final reviewer with the same snapshot identity, including candidate selection/revision paths.
2. Execution discoveries and actual command evidence reach Claude review; planning history is preserved.
3. Both roles independently inspect an additional relevant source, exchange evidence and correct or rebut an issue without automatically rewriting the whole artifact.
4. A clean first review stops; a clarification-only exchange leaves artifact bytes unchanged; a real revision receives current-artifact re-review.
5. Contradictory or stale memory remains attributed; missing required context and cross-project references cannot produce approval.
6. Explicit planning rounds, campaign rounds, candidate breadth, execution debate and challenge limits retain their separate behavior.
7. Autonomous final authority and unresolved manual authority stay unchanged; delivery acknowledgment, silence or malformed output never becomes agreement.
8. Changed artifacts/material context invalidate approval, while ordinary audit-log growth does not; a revision-required verdict cannot approve an unapplied change.
9. Queue, phase changes, reopened planning and process restarts preserve context, issue history, operation identity and consumed budgets.
10. Failed/uncertain launches, repeated clarification/repair loops and explicit resource exhaustion terminate visibly without approval or unaccounted retries.
11. Version-1 manual checkpoint migration preserves pending questions and prior receipts; version-2 technical continuation cannot bypass a human decision, scope validation or exhausted budget.
12. A replayed completed operation or accepted answer does not repeat inference, edits, queue accounting or landing commits; uncertain outcomes remain explicit.
13. Concurrent notebook writes serialize without lost updates; live-lock conflicts, journal corruption and storage failure fail visibly. Optional historical search failure does not silently drop required current context.
14. Reports preserve natural-language questions, answers, rebuttals, evidence and dissent, without exporting private reasoning or credentials.
15. All controller/delivery acceptance paths use fake providers and isolated Windows fixtures. A later bounded live CLI smoke test is separately authorized and labeled; no test proves identical understanding inside two models.

Run the affected unit/integration suites and full existing suite during implementation, then independent code review and packaging/documentation checks. Prior test counts and CI results are historical, not verification of this feature.

## Review and implementation boundary

The user approved the high-level design. This revised written contract adds explicit compatibility, persistence and safety details for review, notably the proposed 24-call work-item safeguard and restricted technical continuation form. These details are not represented as already individually approved.

Superpowers brainstorming requires written-design review before writing-plans. Saving and locally committing this specification does not implement the feature, install a memory/transport component, change an operational plugin, push, merge or release. The existing PR5 branch and operational checkout remain preserved.
