# Shared Context and Coworker Dialogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make Claude and Codex evidence-sharing coworkers throughout planning and execution, with durable issue conversations and reviewer-controlled completion.

**Architecture:** Add focused context, evidence, notebook, journal and dialogue modules around existing CLI transports and phase controllers. Deliver immutable grounding and issue history explicitly to both seats, separating conversation from artifact mutation. Reuse existing manual checkpoints, queue, isolated reviews and landing paths.

**Tech Stack:** Node.js >=24, ESM, built-in fs/crypto/path/child_process, node:test; zero new runtime dependencies; existing Claude and Codex CLIs.

**Spec:** docs/superpowers/specs/2026-09-07-shared-context-adaptive-planning-design.md (approved after end-to-end flow review, 2026-09-07).

## Global Constraints

- "No default round, provider-call or elapsed-conversation ceiling is introduced."
- "Initial candidate breadth defaults to one; explicit alternative exploration remains supported."
- "Autonomous final authority remains Codex for planning and Claude for execution. Humans settle unresolved manual disputes."
- "No separate final-review provider call is mandatory. Conversation remains possible during final review in both phases; a question does not restart the entire review."
- "Every substantive factual claim must identify the evidence supporting it."
- "Receipt/acknowledgment is distinct from approval."
- "Conversation-only turns are read-only for the project artifact. Only the designated author/executor can change it during an explicit revision/implementation step."
- "Required dialogue persistence failure pauses before further mutation; an optional long-term-search outage may visibly fall back to available records."
- "Do not restructure unrelated runtime folders or replace existing review isolation."
- "All controller/delivery acceptance paths use fake providers and isolated Windows fixtures."
- No external installation, live-provider smoke run, authentication/global settings change, npm release, push or merge in this local implementation plan.
- Keep existing Codex gpt-6-astra/high and Claude defaults. No silent model substitutions.
- Preserve all project/SDD objects under the user-selected persistent root; do not delete completed evidence.
- Exact runtime/plugin paths stay stable. Historical v1 records remain readable. A new-mode malformed response never falls back to legacy approval.
- Explicit proposal-cycle, candidate, correction, challenge and token controls retain their separate meanings. Q&A is not a proposal/correction cycle.
- Unknown usage is not zero. Model prose is not observed tool evidence. Digest identity is not semantic truth. Do not silently truncate required evidence.

## Workspace, test and dispatch policy

Work in the existing isolated worktree work/uroboros-two-agent on feat/shared-context-coworker-dialogue, base fcd7c481a37f80194d1c698101bcf959dcf84f47. Preserve reliability PR5, main and the operational checkout.

Reuse the existing provider-deny shims, copying them unchanged into the persistent tools/provider-deny-bin directory. Prepend that path to test PATH and set a distinct URO_TEST_PROVIDER_DENIAL_LOG. CLI/provider tests use fake executables or injected adapters; no real inference. Keep test scratch repositories on the existing non-synced OS temporary path, retain receipts under persistent outputs.

~~~powershell
$env:PATH = 'C:\Users\aiuser4\OneDrive - Applexus Technologies\Uroboros\tools\provider-deny-bin;' + $env:PATH
$env:URO_TEST_PROVIDER_DENIAL_LOG = 'C:\Users\aiuser4\OneDrive - Applexus Technologies\Uroboros\outputs\coworker-task-1-provider-denials.log'
node --test --test-reporter=tap test/shared-context.test.js
~~~

Each task: failing behavioral test first, observed RED, minimal implementation, GREEN affected files, self-review, commit, independent task review. Run a full suite before committing changes to existing production behavior; do not repeat full suites on unchanged code for reviewers. Record precise commands, exit codes, counts and commit ranges. Controller creates each extracted task brief with the skill script; supply this Global Constraints and Shared Contracts section as a separate common-contract file, so workers need not read the full plan.

## File responsibilities and shared contracts

New focused production modules:
- shared-context.js: canonical versioned grounding, material identity, complete common rendering.
- context-evidence.js: captured source identity, scoped references, linked claims and inspection receipts.
- project-memory.js: verified logical project identity, immutable notebook, lock and deterministic recall.
- dialogue-journal.js: correctness-critical append-only journal, operation intent/results and accounting.
- dialogue.js: envelope validation, issue reducer, role/current-version approval.
- dialogue-dispatch.js: serial action dispatch, source inspection, resource checks and one format repair.
- planning-dialogue.js: planning/decomposition adaptation without replacing legacy readers.
- execution-dialogue.js: safe execution questions, read-only conversation, corrections and replanning.
- dialogue-report.js: readable projections for current reporting surfaces.

All function arguments below are objects. Values written to disk are serializable data only. No environment, credentials, adapter functions or private reasoning traces.

~~~js
// shared-context.js
contextDigest(value); // SHA256 canonical JSON
createSharedContext({projectId,runId,unitId,phase,sourceRevision,entries,evidence:[],parent:null,recalled:[]});
extendSharedContext({snapshot,entries:[],evidence:[],phase,sourceRevision});
validateSharedContext({snapshot,projectId}); // snapshot or throws
renderSharedContext({snapshot}); // full common input string
persistSharedContext({directory,snapshot}); // immutable path

// context-evidence.js
captureEvidence({projectId,root,directory,evidence}); // immutable captured Evidence
validateEvidence({evidence,projectId,roots}); // {valid,reason?,evidence}
validateClaims({claims,evidence,projectId,roots,verifications:[],seat}); // {valid,errors}
createInspectionReceipt({operationId,seat,evidence,inspected,result}); // Receipt

// project-memory.js
resolveProjectIdentity({target}); // {projectId,repository,root}
openProjectMemory({artifactRoot,project}); // {list,search,append}
// list() -> Entry[]; search({text,tags:[]}) -> Entry[]; append({entry}) -> saved Entry

// dialogue-journal.js
openDialogueJournal({directory,runId,projectId}); // journal
// read(): verified ordered events
// append({type,...data}): durable event
// prepare({operationId,seat,input,contextDigest,artifactDigest,evidenceIds,unreadMessageIds,effect})
// complete({operationId,result,usage,delivery})
// operation(operationId): null | {status:'prepared'|'completed'|'uncertain',...}
// account(): {providerLaunches,knownUsage,usageUnknown,...}
// close(): release this controller's journal ownership, never another owner's lock

// dialogue.js
createDialogueState({runId,projectId,phase,interactionMode,snapshot,artifactDigest,limits:{},continuation});
parseDialogueEnvelope({response}); // Envelope or throws
applyDialogueEnvelope({state,envelope,seat,evidence,verifications}); // new State
canApproveDialogue({state,seat}); // {approved,reason?}

// dialogue-dispatch.js
runIssueDialogue({state,journal,seats,renderInput,inspect,revise,persist,budget,reporter});
// -> {state,approved,reason,action,messages,rounds,resources}
// seats[seat]({input,action,state,operationId}) -> transport result with content,
// observed delivery and observations, usage (null when unavailable)
// revise({state,seat,operationId,response,envelope}) -> {artifactDigest,snapshot,response}
// Consumes the saved provider result; performs no provider launch.
// inspect({requests,seat,operationId,state}) -> {evidence,receipts}
// persist({state}) before effects/final transitions
// budget({state,account,nextAction}) -> {allowed,reason?}, before EVERY launch

// planning-dialogue.js
runPlanningDialogue({requirements,target,directory,tier,interactionMode,rounds,
  snapshot,journal,seats,strategy,continuation,humanRuling,reporter});
// existing runConversation-compatible result + sharedContext/dialogue/resources

// execution-dialogue.js
runExecutionDialogue({state,journal,snapshot,artifactDigest,directory,interactionMode,
  execute,review,discuss,inspect,replan,budget,reporter});
// {action:'complete'|'continue'|'correct'|'replan'|'needs-decision'|'paused'|'stop',
//  approved,state,snapshot,messages,resources,reason}

// dialogue-report.js
renderDialogueReport(state); // Markdown
renderDialogueHtml(state); // safe HTML projection
~~~

Snapshot schemaVersion:1 includes id, digest, parentDigest, projectId, runId, unitId, phase, sourceRevision, entries, evidence, recalled. Exclude digest and delivery/audit metadata from its canonical identity. Entry includes id, kind, content or pinned reference, provenance, sourceIdentity, status, optional supersedes. Validate duplicate/missing IDs. Material change produces a new parent-linked snapshot; historical/conflicting entries retain attribution.

Evidence includes id, kind (code|command|requirement|external|memory|inference), projectId, claimIds, locator, sourceDigest, sourceIdentity, capturedPath and kind-specific metadata. Code is precise relative path/line or symbol at a captured digest/revision; command is actual argv/cwd/exit/status/raw outputs/code identity; requirement is exact briefing ID/text; external includes direct URL/retrieval time/version/permitted excerpt; memory links to underlying evidence; inference links premise IDs and explanation. Native canonical path and segment containment must reject escapes before reading. Do not turn a proposed new filename into existing-code evidence or unexecuted command into a test result.

Envelope uses one <UROBOROS_DIALOGUE> JSON </UROBOROS_DIALOGUE> block beside existing plan tags/review bundle; object adapters may return a dialogue field of the same shape:
~~~json
{
  "schemaVersion":1,
  "action":"ask",
  "artifactDigest":"current-artifact-digest",
  "contextDigest":"current-context-digest",
  "replyTo":null,
  "content":"Why is another service required?",
  "claims":[],
  "issues":[{"id":"I1","title":"Reuse existing service","status":"awaiting-answer","blocking":true}],
  "evidence":[],
  "verifications":[],
  "next":{"seat":"claude","action":"answer","reason":"Explain the dependency choice"}
}
~~~
Actions: propose, ask, answer, inspect, challenge, rebut, withdraw, revise, verify, approve, decide, replan, stop. Harness binds message ID, sequence, sender, phase and operation; emitted sender cannot impersonate another seat. Claims: id, kind (fact|inference|hypothesis|question|preference), text, evidenceIds. Facts and approval/decision premises require linked evidence. Questions/hypotheses may explicitly lack proof but cannot resolve evidence-dependent blockers as verified.

Verification: claimId, evidenceIds, inspectionReceiptIds, result (supports|contradicts|insufficient), reason. Receipt IDs exist in harness-owned state for the receiving seat; a model echo is not a receipt. Collect real source/tool/command observations where transport exposes them. Explicit inspect requests can have the harness read an authorized source, journal the operation, deliver it, then receive substantive interpretation from that seat. Record observable inspection separately from semantic assessment; never claim to prove model comprehension. No mandatory extra inspection call when suitable observed evidence already exists.

State schemaVersion:2 includes run/project/phase/mode/authority, snapshot and artifact identity, messages, issues/dispositions, approval, next action, proposalCycles/correctionCycles, explicit limits, resources, pendingDecision, technicalPause and operation identities. All open blocking issues need explicit authorized dispositions. New artifact/material context clears approval; audit growth does not.

The reviewer may provide authorized issue dispositions and current-artifact sign-off in one approve envelope on the already-running review call. No extra provider call is required. A decide envelope alone settles issues but does not imply whole-artifact approval; render this explicit action distinction in protocol guidance without adding a second outcome schema.

An explicit applicable issue rejection or claim-owner withdrawal distinguishes the linked disproved claim from live approval premises without requiring a new artifact. Preserve the original claim, assessment and disposition as attributed history. An unrelated issue closure/deferment cannot retire a claim, nor can retirement hide a live disposition/approval premise or unresolved material dependency. Expose this status for notebook promotion and reporting; a retired claim cannot become a verified notebook fact.

For both propose and revise, the dispatcher owns the single provider launch. Validate the returned envelope against the operation's saved INPUT artifact/context identities before applying the result. The revise callback receives that saved transport response and envelope, launches no provider, and computes the resulting artifact/context identities from actual parsed/applied output. Its returned response, if any, is a local projection of the same outcome, not another provider reply. Durably journal any local application effect; persist the resulting identity and invalidate approval before reviewer dispatch. Q&A invokes no artifact application callback.

Optional envelope memoryProposals entries contain id, content, kind, claimIds, optional issueId and tags. The harness binds proposer/message/run/context provenance; validate referenced claims/issues and retain proposals in state. Model-supplied status cannot promote a proposal. Phase integration curates notebook records only after the relevant explicit issue disposition or current-artifact approval, retaining disputed/unsupported status rather than calling agreement a verified fact. A clean decision can be proposed for memory without inventing an objection just to obtain an issueId.

Controller scope is explicit: createDialogueState also accepts scope:{sourceRoots,evidenceRoots}, supplied from validated project/artifact roots by the harness, never inferred from a seat's evidence locator. Persist and revalidate this scope on resume. An inspect request may name an authorized source before its digest is known; capture computes identity from actual bytes, then the seat assesses that evidence. Unknown narration is not an inspection receipt.

## Task 1: Shared snapshots, scoped evidence and project notebook

**Files:** Create src/shared-context.js, src/context-evidence.js, src/project-memory.js, test/shared-context.test.js, test/context-evidence.test.js, test/project-memory.test.js. Modify src/artifacts.js only for __uro_context/ recursive retention/exclusion.

**Interfaces:** Consumes artifact-root convention, verified native Git common-directory identity and built-in fs. Produces context/evidence/memory contracts above; no phase/provider integration.

- [ ] **Step 1: Write behavioral RED tests.**
~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedContext,validateSharedContext,renderSharedContext} from '../src/shared-context.js';
test('audit growth preserves grounding while cross-project use fails', () => {
  const snapshot = createSharedContext({
    projectId:'p1',runId:'r1',unitId:'u1',phase:'planning',sourceRevision:'base',
    entries:[{id:'request',kind:'requirement',content:'Preserve offline use',
      provenance:{source:'user',id:'brief-1'},sourceIdentity:'brief-1',status:'required'}]
  });
  assert.match(renderSharedContext({snapshot}), /Preserve offline use/);
  assert.equal(validateSharedContext({snapshot:{...snapshot,delivery:{attempted:1}},projectId:'p1'}).digest,snapshot.digest);
  assert.throws(() => validateSharedContext({snapshot,projectId:'other'}), /project/i);
});
~~~
Additional literal cases: material delta invalidates old digest; duplicates/missing identities rejected; immutable overwrite refused; stale/missing/outside-root evidence rejected; actual command metadata required; false receipt cannot verify; inference without premises rejected. Create real temporary Git linked worktrees and clone to prove shared common repository identity versus separate clone. Notebook tests exercise deterministic search, attributed conflict versions, live-lock refusal, lock release, sequential competing writes without lost updates, corrupt records and optional-search outage visibility. Each test names the production break it catches.

- [ ] **Step 2: Run RED and retain expected failure.**
~~~powershell
node --test test/shared-context.test.js test/context-evidence.test.js test/project-memory.test.js
~~~
- [ ] **Step 3: Implement canonical identity, scoped capture and immutable notebook.**
~~~js
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => [key,canonical(value[key])]));
  return value;
}
function segmentInside(root,file) {
  const rel = relative(root,file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
~~~
Import relative/isAbsolute/sep from node:path in the module using segmentInside. Use realpathSync.native on Windows, fsync/atomic rename for mutable metadata, exclusive immutable versions, owner-token project locks with finally release. Never auto-break live locks. Project ID hashes verified common Git directory, or canonical target for non-Git; remote URL is not identity. Selectively capture only supplied project briefing/evidence, sanitize known credential fields/values, report required context incomplete when redaction removes necessary material. Do not ingest global chats. Safe ID-derived storage paths, no raw user path traversal.

- [ ] **Step 4: Run GREEN affected files and full suite before commit.**
~~~powershell
node --test test/shared-context.test.js test/context-evidence.test.js test/project-memory.test.js test/artifact-retention.test.js test/artifact-compat.test.js
node --test
~~~
- [ ] **Step 5: Self-review, report RED/GREEN and commit exact task paths.**
~~~powershell
git add src/shared-context.js src/context-evidence.js src/project-memory.js src/artifacts.js test/shared-context.test.js test/context-evidence.test.js test/project-memory.test.js
git diff --cached --check
git commit -m "feat: add shared grounding and project-scoped evidence memory"
~~~

## Task 2: Durable issue state and serialized dialogue dispatch

**Files:** Create src/dialogue-journal.js, src/dialogue.js, src/dialogue-dispatch.js, test/dialogue-journal.test.js, test/dialogue.test.js, test/dialogue-dispatch.test.js. Modify src/artifacts.js for __uro_dialogue/ retention/exclusion. Test helpers stay in fixtures or test support.

**Interfaces:** Consumes Task 1 and decisionAuthority; produces journal/state/dispatch contracts above.

- [ ] **Step 1: Write RED transition, disk journal and fake-transport tests.**
~~~js
test('an acknowledgment cannot approve', () => {
  const snapshot = createSharedContext({
    projectId:'p1',runId:'r1',unitId:'u1',phase:'planning',sourceRevision:'base',entries:[]
  });
  const state = createDialogueState({
    projectId:'p1',runId:'r1',phase:'planning',interactionMode:'autonomous',snapshot,artifactDigest:'a1'
  });
  const next = applyDialogueEnvelope({state,seat:'codex',evidence:[],verifications:[],
    envelope:{schemaVersion:1,action:'answer',content:'Received.',artifactDigest:'a1',
      contextDigest:snapshot.digest,replyTo:null,claims:[],issues:[],evidence:[],verifications:[],
      next:{seat:'claude',action:'answer',reason:'Clarify intention'}}});
  assert.equal(canApproveDialogue({state:next,seat:'codex'}).approved,false);
});
~~~
Import the real functions in each file; use literal requirement/evidence fixtures where approval is expected. Cover seat spoof, manual dispute, wrong authority, stale identity, missing reply target, invented disposition, unsupported fact, source contradiction, counterpart verification, and unapplied revision cannot approve. Real journal cases: tamper/truncation/order corruption, duplicate completed operation reuses saved outcome without launch, unknown prepared operation cannot replay, disk failure before next effect, ownership conflict.

Fake-provider dispatch scenarios: first clean review ends without extra call; ask-answer-verify keeps bytes/cycles; >3 valid exchanges and >2 challenges are not cut off; rounds=1 allows Q&A but refuses second proposal; reviewer progress/stop judgment retained; budget stops before even final decision; one format repair then unreadable. Track failed and repair launches, null usage and separate message/proposal counts.

Exercise either seat proposing a notebook update, unknown claim/issue references rejected, and proposal provenance bound by the harness. Task2 stores validated attributed proposals only; Tasks3-4 perform notebook recall/promotion at real phase boundaries.

Distinguish routine reviewer sign-off from final unresolved-dispute authority: decisionAuthority returns human in manual mode, but a clean evidenced review must still finish without an unnecessary human checkpoint. Add a clean-manual-review case alongside unresolved-manual-dispute routing.

Test the single-launch revision contract explicitly: the proposal envelope echoes saved input identity, revise receives the exact completed response without launching a provider, the harness installs the new identity before review, old approval becomes stale, and Q&A never invokes artifact application.

- [ ] **Step 2: Run RED.**
~~~powershell
node --test test/dialogue-journal.test.js test/dialogue.test.js test/dialogue-dispatch.test.js
~~~
- [ ] **Step 3: Implement pure state transitions and journaled effects.**
~~~js
// Reducer transaction pattern: clone, validate fully, then return.
// Local helper names belong to dialogue.js, not new public interfaces.
const next = structuredClone(state);
if (envelope.contextDigest !== state.snapshot.digest ||
    envelope.artifactDigest !== state.artifactDigest) throw new Error('stale dialogue identity');
next.messages.push({ ...envelope, sender:seat, sequence:next.messages.length + 1 });
~~~
Validate seat/action, claims, reply/issue references and current approval before returning next. Do not partially mutate saved state on rejection. Journal strict full nonempty lines with sequence/hash chain and fsync; single active controller owns lock. prepare is durable before launch/edit; complete records observed delivery/result/usage. On recovery a prepared external operation lacking a durable result is uncertain, not safe retry.

Dispatcher renders full common context, schema, issue history and pending messages on actual input. It checks budget before EVERY launch, persists intent/next action, invokes exact seat/action, saves result, validates, then persists reduced state. Exception becomes visible unapproved pause. inspect performs only scoped requested evidence reads and returns harness-owned receipts for subsequent counterpart assessment. Q&A returns to counterpart, revision to reviewer; no third model/default counter. Only explicit propose/revise consumes a proposal cycle. One format-only repair per malformed response is separate from valid dialogue.

- [ ] **Step 4: Run GREEN focused and full suite.**
~~~powershell
node --test test/dialogue-journal.test.js test/dialogue.test.js test/dialogue-dispatch.test.js test/shared-context.test.js test/context-evidence.test.js test/project-memory.test.js test/artifact-retention.test.js
node --test
~~~
- [ ] **Step 5: Commit exact task files after evidence/self-review.**
~~~powershell
git add src/dialogue-journal.js src/dialogue.js src/dialogue-dispatch.js src/artifacts.js test/dialogue-journal.test.js test/dialogue.test.js test/dialogue-dispatch.test.js
git diff --cached --check
git commit -m "feat: add durable evidence-led coworker dialogue"
~~~

## Task 3: Shared planning and decomposition conversations

**Files:** Create src/planning-dialogue.js, test/planning-dialogue.test.js. Modify src/plan.js, src/decompose.js, src/conversation.js (compatibility/prompt consistency/rendering), src/args.js (affected defaults/validation), src/run.js (pivot-default import/parameter only), src/executor.js and src/arbiter.js (observed tool receipts), src/review-protection.js and src/isolation.js (context/dialogue sidecar protections/exclusions), src/checkpoint.js and src/resume.js as needed (minimum explicit v2 planning save/load/decision-file bridge only), test/plan.test.js, test/decompose.test.js, test/events.test.js and the planning portions of test/resume.test.js, plus affected transport/args/protection/isolation and fresh-pivot default tests. New alternative/v2 behavioral coverage may live in test/planning-dialogue.test.js and test/resume.test.js; preserve and run the existing candidate-campaign/checkpoint/conversation compatibility tests without requiring cosmetic edits. Task5 still owns technical continuation, v1 migration, execution/queue recovery and the remaining resume changes; Task4 owns all other execution dialogue changes.

**Interfaces:** Consumes Tasks 1-2; produces runPlanningDialogue and existing runPlan/runPlanCandidateSet/decompose results plus sharedContext/dialogue/resources. Existing integer rounds, artifact validators/writer, output paths and legacy readers preserved.

**Narrow dependency ownership:** Task3 also owns src/dialogue-dispatch.js/test/dialogue-dispatch.test.js for material-evidence context extension and known no-application artifact repair; src/dialogue.js/test/dialogue.test.js only where trusted repair-cycle bookkeeping requires it; and src/spawn.js/test/spawn.test.js for optional observed stdin submission metadata. Preserve the reviewed foundation outside these seams.

- [ ] **Step 1: Add failing real-entry-point fake-provider cases.**
~~~js
// In existing plan candidate fixtures, author/reviewer return actual valid
// dialogue envelopes beside PLAN_MD/GATE_JSON; capture production-rendered inputs.
assert.match(reviewerInput, /Do not repeat the table rewrite/);
assert.match(reviewerInput, /offline access broke/);
assert.match(reviewerInput, /Preserve local login/);
assert.equal(reviewerSnapshotDigest, authorSnapshotDigest);
assert.equal(result.approved, true);
assert.equal(Number.isSafeInteger(result.rounds), true);
~~~
These are assertions inside the new test whose input sets failedPlan='Do not repeat the table rewrite', ledger={rounds:[{finding:'offline access broke'}]}, pivot='Preserve local login'. Use existing test fake request/CLI infrastructure, with fields populated from actual rendered requests/digests and real source evidence. Do not assert only on a mocked result. Cover initial draft, alternate selection, revision, final authority and decomposition constitution/repoMap. Both seats independently request an additional file, exchange/rebut evidence without full rewrite. Clean approval has no mandatory extra final call. Q&A never invokes writer. Missing envelope in a NEW production run fails closed.

- [ ] **Step 2: Run RED.**
~~~powershell
node --test test/planning-dialogue.test.js test/plan.test.js test/decompose.test.js test/candidate-campaign.test.js
~~~
- [ ] **Step 3: Deliver common grounding at every actual CLI input boundary.**
~~~js
const input = [rolePrompt,renderSharedContext({snapshot}),
  JSON.stringify({artifactDigest:state.artifactDigest,issues:state.issues,messages:state.messages})
].join('\n\n');
~~~
Build grounding from validated user goal/briefing, target identity, constitution, repoMap, failed/previous plans, ledger and pivot. Persist before draft/select/review. Material discoveries extend snapshot before review; author-only selector input is insufficient. Default candidate breadth becomes one; preserve explicit supported breadth. Record each alternative/selection operation and usage. Serialize journaled candidate calls unless safely independent operation accounting is established.

Wire the Task1 notebook into these actual entry points, not only unit-test its storage API. Resolve verified project identity and the existing durable artifact-root convention; retrieve relevant deterministic text/tag matches, freeze the selected attributed records and selection manifest into the common snapshot, and never make required user constraints depend on search ranking. After explicit disposition, the harness alone writes validated proposed decisions/lessons with their evidence and status. Recalled material is historical, not automatically a current fact. Cover two work items sharing one notebook, separate-project isolation and visible optional-recall failure without losing current requirements. Keep these lifecycle helpers in the planned phase/context/notebook modules; add src/project-memory.js/test/project-memory.test.js to Task3 ownership only if shared helper extraction is needed.

Author answer/rebut uses read-only seat without parsePlanProposal or writeArtifacts. Explicit propose/revise creates a new cycle. Only current plan/gate/context approval writes once through existing rollback-safe writer. Retain legacy runConversation/historical readers explicitly; do not infer legacy mode from invalid new response or injected adapters. Update stale test fixtures intentionally, not by weakening authority assertions. Transport parsers retain actual tool/source observations; narration is not a tool observation.

Newly registered material source/evidence records extend the shared snapshot and clear stale approval before the next provider launch or terminal transition. Receipt-only rereads/audit growth do not change context. A provider's returned envelope still validates against its durably prepared INPUT identity before installing the resulting delta; apply the same rule when recovering completed inspections. A new digest is not proof of semantic novelty. Record optional onInputSubmitted metadata at the actual spawnCapture stdin.end boundary, preserving default behavior without the hook and handling submission/observer errors without false acknowledgment or leaked child processes. Submitted bytes/hash are not proof of child consumption.

Preserve separate artifact-format repair: a trusted planning parser may return artifactRepair:{reason} from the local application callback only for a positively known pre-application RepairableArtifactError. Durably record the no-application outcome, then schedule the next author attempt outside that callback. Repair stays inside the same allocated proposal/review cycle, so rounds1 permits repair of its malformed first proposal. Preserve the existing cumulative MAX_ARTIFACT_REPAIRS5 count across candidates and continuation; do not reset it per candidate or revision. Bind repair markers to harness-owned operation/cycle state, budget/account every launch and retain identity on replay. Model envelopes cannot request a cycle-limit bypass. Writer/execution or uncertain failures still pause; exhausted repair never restores stale approval. Test rounds1 successful repair, exhaustion, writer-failure distinction and budget/recovery accounting.

Fresh manual planning must remain resumable through the existing decision-file entry point. Add the minimum explicitly versioned v2 planning checkpoint save/load and trusted human-ruling phase bridge now: preserve pending questions, current artifact/context/scope identity, answer identity/replay checks and no-repeat initial drafting. Keep the existing v1 checksum/answer validation and historical fields unchanged; a new run is never disguised as v1. Preserve the validated human message and explicit authority without model impersonation or converting unsupported claims to facts. Technical --continue, execution/queue recovery and v1-to-v2 reconstruction remain Task5; report the exact serialized planning bridge for that worker.
Queued planning must recognize only the exact new planning sidecar files derived from the validated current run/output identity and retained manifest. Task3 owns the minimum src/queue.js generated-sidecar provenance/allowance seam plus planning-focused queue/resume tests. Revalidate integrity and containment before use; reject escaping paths, symlinks and unrelated files. Never exempt a whole output directory or arbitrary __uro_* content. Queue migration, execution/landing replay and resource propagation remain Task5.

Preserve explicit candidates and pivot-candidates 1..5. Split DEFAULT_PIVOT_CANDIDATES from the initial default: initial becomes one, existing omitted fresh-pivot breadth remains three. This avoids changing an unspecified default merely because the old code shared one constant.

The existing run.js import and omitted pivotCandidates parameter also use DEFAULT_PLAN_CANDIDATES. Change only that import/default seam in this task so direct execution preserves the separate pivot default before Task4 integrates execution dialogue.

Reconcile the existing exactly-two-artifact-tags prompt with the extra dialogue envelope. New-mode standing instructions must not demand an extra reviewer-written test on every review. Preserve explicitly required checks. Keep context/journal sidecars out of Git changes without treating model edits to correctness-critical records as trustworthy; validate their integrity/identity before subsequent decisions.

- [ ] **Step 4: GREEN focused and whole suite.**
~~~powershell
node --test test/planning-dialogue.test.js test/plan.test.js test/decompose.test.js test/conversation.test.js test/candidate-campaign.test.js test/args.test.js test/executor.test.js test/arbiter.test.js test/spawn.test.js test/dialogue-dispatch.test.js test/dialogue.test.js test/checkpoint.test.js test/resume.test.js
node --test
~~~
- [ ] **Step 5: Report, self-review, stage only changed task files and commit.**
~~~powershell
git diff --check
git status --short
git commit -m "feat: integrate shared-context planning conversations"
~~~
Before commit explicitly git add each changed path from this task Files list. Record additions to exported optional fields for downstream workers.

## Task 4: Execution questions, review dialogue and retained-work replanning

**Files:** Create src/execution-dialogue.js, test/execution-dialogue.test.js. Modify src/run.js, src/executor.js, src/verifier.js, src/review.js, src/evidence.js, src/gate.js, src/decision-resolver.js only at dialogue seams. Extend test/run.test.js, test/review-loop.test.js, test/reviewer-gate.test.js, test/gate.test.js, test/fresh-pivot.test.js, test/claude-review-transport.test.js.

**Interfaces:** Consumes approved planning context/history/resources; produces runExecutionDialogue and serializable execution continuation. Existing landing and human authority remain.

Controller handoffs within Task4 use explicit dependent WIP slices: native execution foundation; transport/check effects and planning-budget forwarding; ordinary default-run integration; retained replanning; existing merge/stall integration. A slice may retain focused-tested code and exact producer contracts for a fresh successor, but does not complete Task4 or add a separate full-suite gate. All slices and fixture migration must finish before the initial full suite and independent Task4 review of the entire range from de8b0cbc7f01b84966bb4398ae5b2e4ed48e7594. Keep incomplete routes visibly paused in unpublished WIP, never silently routed through legacy or fabricated approval. Preserve the same outer run controller and final acceptance. The current transport/check implementer owns planning-budget forwarding only beyond its tested work; merge/stall and run replacement have separate later owners.

Task4 also owns the existing CLI fake paths fixtures/fake-codex.mjs, fixtures/fake-agent.mjs and test/cli.test.js for explicit/context-aware new-mode responses. Existing version1 review bundles are not dialogue envelopes. Preserve explicit historical-reader fixture modes; no injected-adapter or malformed-response legacy fallback. Reuse task-4-execution-fixture-map.md for actual helper/call-count boundaries.

The ordinary-run WIP slice also owns focused test/run-artifacts.test.js and the existing test/queue.test.js landing compatibility fixture for native result/retention/approval mapping; broader queue recovery remainsTask5. Reuse task-4-ordinary-run-brief.md and task-4-run-slice-map.md for dependent slice boundaries. Existing optional mutation-analysis and stall-liveness provider/effect boundaries require explicit native journal/budget/identity integration before whole-Task4 completion; while unfinished, pause before their effects, without changing the legacy readers or redesigning those subsystems.

The stall/liveness slice owns the narrow required-decision and native judge cancellation/settlement seams in existing spawn/executor/run/liveness code. An outer judge timeout/dispose must not allow late gathered work to launch another provider or write completion into a closed phase journal. Await actual launched-judge settlement or retain explicit uncertainty, without unbounded joins, fabricated cancellation or new dialogue caps; preserve legacy callbacks when required hooks are absent and contain only owned processes on sink failure. An in-flight writer's unknown usage under an enforced budget denies a concurrent paid judge; record that outcome without invented reservations or live usage.

- [ ] **Step 1: Write RED using real retained files and fake seat transports.**
~~~js
// Counter file is changed only in the first fake executor's actual write step.
// Its ask response yields safely, Claude answers, executor resumes remaining work.
assert.equal(readFileSync(counterPath,'utf8'),'1');
assert.equal(result.state.messages.some(message => message.action === 'ask'),true);
assert.equal(result.approved,true);
assert.equal(result.state.authority,'claude');
~~~
Define the scenario with actual temporary workspace and source/command evidence, not mock return-only assertions. Cases: Codex explanation invokes no coding step; Claude's cited mistake corrected by rebuttal; human product question remains pending; current artifact/context invalidation; meaningful plan change goes Claude planning->Codex approval before resume; useful work retained; review-only edits remain isolated; no hidden default two-challenge cutoff. Explicit old controls still constrain their own actions.

- [ ] **Step 2: Run RED.**
~~~powershell
node --test test/execution-dialogue.test.js test/review-loop.test.js test/fresh-pivot.test.js
~~~
- [ ] **Step 3: Integrate at normal completed CLI/safe yield boundaries.**
~~~js
const result = await runExecutionDialogue(dialogueRequest);
if (result.action === 'needs-decision' || result.action === 'paused')
  return { ...retainedResult, approved:false, reason:result.reason, checkpointState:result.state };
~~~
Adapt these local values to existing run.js stage variables. Codex returns cited ask envelope with retained partial work, process exits normally, Claude answers with shared history. No injection into arbitrary running CLI. Distinguish resume remaining execution from a new correction cycle. Pure explanation uses read-only discussion. Product/permission uncertainty cannot be invented away by autonomous mode.

Task4 owns the narrow src/dialogue-dispatch.js/test/dialogue-dispatch.test.js completed-execution-result seam: an authorized mutating request can return ask after actual partial edits. Validate its envelope against saved INPUT identity, then journal capture/adoption of the observed resulting artifact/context before the next seat. This callback consumes completed output/files only, never relaunches inference or edits, and distinguishes local capture from the provider's original mutation. Preserve the validated question/next action, clear stale approval, and retain the harness-allocated execution cycle for remaining work. Bind eligibility to prepared phase/request, never model bypass flags. Read-only requests remain read-only; uncertain outcomes pause. Test actual partial-write count, capture-failure/no-next-seat, conversation-only negatives and completed-outcome recovery. Report a concrete dependency before any reducer-bookkeeping expansion.

Task4 also owns src/dialogue.js/test/dialogue.test.js for explicit missing-user-decision requests. Retain validated issue kind technical|product|permission; a product/permission topic alone remains ordinary evidence-based coworker discussion. A validated explicit needsHuman request on an open blocking ask creates pendingDecision.authority=human in either mode. It pauses for genuinely missing user intent/permission, never grants permission, changes reviewer authority/scope or uses prose heuristics. Model relabelling cannot clear the human checkpoint. Capture completed partial edits before returning it. Test autonomous missing-decision positives and existing-evidence clarification/technical-dispute negatives; report the exact saved contract for Task5, which must retain autonomous mode while applying a validated human clarification without treating it as automatic artifact approval.

Update snapshot with actual diff and command evidence before Claude review. Retain review bundle checks/isolation; remove any new-mode requirement to fabricate an executable test for every concern or to run an automatic extra clean final pass. Required evidence and acceptable required check outcomes remain. Final discussion can reopen at any point. New code/context invalidates old approval; unperformed correction cannot land.

Task4 owns a narrow execution-only harness check/evidence effect in src/dialogue-dispatch.js and its tests. Gate commands are independently prepared/completed effects, never hidden in the replayable capture callback or provider adapter. Bind them to harness-selected current artifact and required-check-set identities. Trigger for review-ready completed work, changed required checks or explicit reviewer check requests, not every yielded ask/partial segment or Q&A. Human/technical/stop paths launch no check. Reuse completed recorded outcomes without command/provider/cycle re-debit; uncertain prepared commands or required sink failures pause. Observe pre-command code identity and actual post-command bytes. Install material evidence/check changes and invalidate old approval before accepting completion; never relabel approval to new evidence or force a duplicate clean pass when current sufficient checks already exist. Test normal-entry sink failure/no-next-effect, completed-effect recovery/counter, unchanged-evidence no-repeat and partial-question no-gate. Report exact durable effect/state contracts forTask5.

For harness-run commands, capture actual argv, cwd, exit/status, full outputs and code identity at execution time. Existing evidence.js writes and gate.js onEvidence are best-effort legacy sinks: new-mode required evidence must surface capture failure and pause before a subsequent effect, not proceed using only an excerpt or invented output. Preserve legacy behavior explicitly outside the new mode. Test a failed required sink with a second command whose real counter must remain untouched, alongside the legacy sink behavior. Partial nested provider observations remain observations; never substitute outer CLI argv/cwd for a nested command.

Task4 also owns the narrow src/spawn.js/test/spawn.test.js actual launch-metadata seam: Windows command wrappers change the argv passed to the child, so preserve requested bin/args separately from observed actual argv/cwd. Preserve Task3's stdin observation contract. Await the required evidence sink and propagate synchronous or asynchronous failure before the next command. Capture project code identity at the relevant command boundary; neither requested argv nor a nested provider narrative is proof of actual execution.

Fresh planning retains parent issue, novelty evidence, original scope, completed work and consumed budgets; Claude revises, Codex approves, then Codex executes. Reuse amend/fresh/conclude and existing decision-resolver semantics. Legacy readers remain unchanged.

The native run handoff validates structured replan metadata on the actual terminal Claude message: replan:{issueId?,claimId?,evidenceIds,novelty}. At least one affected issue/claim must exist in its registered namespace; evidence references must be trusted and scoped, and novelty must be a concrete recorded explanation. Existing message preservation carries this field; no extra reducer or assumption registry is needed. A historical/resolved affected claim retains that attribution and is not a verified current premise merely by reference. Preserve current factual claim/verification rules, pending human priority and reviewer novelty judgment; never require changed plan text/hash or another clean-review call. Invalid/missing handoff data pauses before child launch. Explicit successor phases carry saved counters/completed cycle history through trusted initialization, not arbitrary supplied-state reopening.

Task4's separate authority edge permits only the narrow src/dialogue.js/test/dialogue.test.js change adding replan alongside decide in the existing manual disputed-issue pendingDecision condition, before terminal handling. The dispatcher already prioritizes pending human state. Preserve the actual replan request/message/current identity; run() must not retrofit a decision into a closed journal. Autonomous reviewer authority and ordinary non-disputed clarification remain unchanged. Cover the actual no-child-planning human pause and paired modes. Task5 must reassess a scoped human answer under current context rather than blindly dispatch a retained stale terminal replan or treat the answer as artifact approval.

Task4 owns the narrow src/plan.js/test/planning-dialogue.test.js fresh-replan budget forwarding seam and callPlanningPreparation preflight in src/planning-dialogue.js. Use the same cumulative resource guard before every draft, selector, protocol/artifact repair and selected-dialogue launch. Exhausted or incomplete enforced accounting pauses visibly, not an author-unavailable fallback into another candidate. Preserve candidate/repair identity and separate cycle meanings; persist serializable balances/limits, not callback functions. Test actual launch counters without reset or double subtraction.

Task4 also owns a narrow harness merge-advance/conclude effect within existing run/dispatcher paths. Journal intent before initial advance and each existing conclude/advance sequence, bound to isolated workspace/base, ordered parent identities, current conflict/ledger and next-parent position. Preserve existing merge helpers/semantics, not a generic model-invocable Git hook or second controller. Persist actual outcome/post-effect artifact and merge progress/current task before each separately prepared Codex launch. Completed outcomes reuse; uncertain prepared Git effects pause without conclude/advance/ledger-clear replay. Pending merge work blocks approval; another authorized parent-conflict task is not a reviewer correction. Cover actual Git/retained files, initial intent-before-effect, completed reuse and uncertainty/no-next-provider. Native execute adapters must not hide the old executePlan stall-relaunch loop: uncertain killed-writer effects pause without blind retry.

During a partial merge replan, keep original requirements, latest exactly approved remaining plan and changing harness-owned parent-conflict task separate. Advancing later parents composes current guidance from the latest approved plan, not originalPlan or a retained stale conflict preamble. Persist current task/progress before the next separately prepared writer, without rewriting selected approval-bound planning text or charging another proposal/correction merely to continue authorized parent work. Cover actual partial-replan->next-conflict behavior and unchanged ordinary/replan controls.

Task3's planning directory/journal is durable for one run identity. Allocate distinct explicit planning phase directory/run identities for subsequent fresh/replan phases; never reuse a completed journal as a new run or reset its resource history. Reuse an existing identity only through its validated continuation path. Task5 owns technical recovery of partially prepared alternatives, using Task3's retained operation records without replaying uncertain provider effects.

Task4's retained-planning failure handoff extends runPlanCandidateSet's existing exact journal/manifest finalization beyond budget denial to unavailable/irreparable/selector failures. Preserve actual current preparation and completed/uncertain operation records, child phase identity and resource balance; do not fabricate a selected dialogue, paused operation or safe-retry authority from the presence of a manifest. Required context/manifest failure remains unapproved and non-resumable until addressed. Cover the existing producer failures and zero subsequent writer calls; technical reopening remainsTask5.

Task4 also owns the minimal src/artifacts.js/test/artifact-retention.test.js child-phase archive seam: archiveRunArtifacts accepts optional exact retainedFiles [{path,sha256}] derived from run's validated phase-chain registry. Copy only validated contained retained-phase files, not all .uro-tmp or model-supplied/enumerated paths; reject source/destination symlink ancestors, escapes, stale/missing bytes and unrelated paths, and verify copied digests. Retain closed journals and tails but no live locks. Distinguish required source-integrity loss (unapproved) from optional destination-only copy failure with intact source; preserve existing default/legacy archive behavior. Task5 retains broader recovery and pre-cleanup durability ownership.

Reuse Task3 notebook lifecycle for execution work items and execution-derived memory proposals: either seat may propose; the harness validates provenance/evidence/disposition before writing. Retain selected history in execution/replan snapshots. Do not leave notebook recall or promotion disconnected from the real run path.

Task4 may make the narrow shared-lifecycle export/integration change in src/planning-dialogue.js needed to reuse its existing openPlanningContext and private promoteMemory helper from execution. Preserve existing planning behavior and shared validation; do not duplicate weaker notebook promotion logic or invoke planning providers merely to obtain a memory write. Cover execution recall/promotion through the real execution entry point and retain the existing planning tests.

- [ ] **Step 4: GREEN focused and whole suite.**
~~~powershell
node --test test/execution-dialogue.test.js test/run.test.js test/review-loop.test.js test/reviewer-gate.test.js test/gate.test.js test/fresh-pivot.test.js test/claude-review-transport.test.js test/review-protection.test.js test/verifier-evidence.test.js test/executor.test.js test/decision-resolver.test.js
node --test
~~~
- [ ] **Step 5: Self-review/report, explicitly stage changed task paths, commit.**
~~~powershell
git diff --check
git status --short
git commit -m "feat: converse during execution and replan from retained evidence"
~~~

## Task 5: Versioned recovery, queue handoff and unchanged resource accounts

**Files:** Modify src/checkpoint.js, src/resume.js, src/queue.js, src/queue-runtime.js, src/queue-cli.js, src/campaign.js, src/args.js, bin/loop.js, src/artifacts.js and phase continuation seams from Tasks 3-4. Add test/dialogue-recovery.test.js; extend test/checkpoint.test.js, test/resume.test.js, test/queue-runtime.test.js, test/queue.test.js, test/queue-cli.test.js, test/campaign.test.js, test/artifact-retention.test.js and CLI/args tests.

**Interfaces:** Consumes stored snapshot/state/journal receipts; produces checkpoint schemaVersion:2 and mutually exclusive technical resume --continue, preserving v1 reader/answer identities.

Extend the minimum v2 planning/decision-file bridge implemented in Task3. Do not replace its fresh-run state with legacy records or discard its answer/operation receipts; this task completes the migration, technical continuation, execution, queue and resource contracts.

For Task4's explicit missing-user-decision product/permission checkpoints, retain the saved autonomous/manual mode. Distinguish these questions from legacy manual dispute approval using the validated native pending record, not answer prose. A scoped human answer is not whole-artifact approval; material clarification enters parent-linked current context and returns to the phase reviewer with stale approval invalidated. Preserve original question/answer identities, and keep --continue blocked by any human pending. Reuse task-5-human-checkpoint-map.md for exact save/validate/answer-routing seams; preserve its source-observed versus required-behavior distinction.

Preserve the actual resumeRun({runDirectory,decisionFile,...}) signature and add technicalContinue:false; map public --continue to technicalContinue:true. Keep validated scope roots in the saved state and do not infer permission from resumed model references.

- [ ] **Step 1: Write RED real-file resume and queue tests.**
~~~js
// Extend the existing resume fixture through the real exported entry point.
// With a saved manual pending question and --continue, no adapter may execute.
await assert.rejects(() => invokeResumeWithContinue(savedDirectory), /human|decision/i);
assert.equal(readFileSync(counterPath,'utf8'),'0');
~~~
invokeResumeWithContinue is a test wrapper calling the existing resume entry with the same option mapping used by bin/loop.js; define it in this task's test utility, not production. Cover v1 checksum/accepted answer receipt validation BEFORE migration, original envelope preserved, stale/replayed answers, mode/limit preservation, safe technical interruption continuation, unknown prepared external effect refusal, completed edit/landing/queue debit replay avoidance, context retention outside cleanup, corrupt journal before any provider call, optional recall outage warning.

Queue tests inspect real child launch input/options and consume the persisted context reference. Child applicable remaining budget is min(parent remaining,item remaining), with no double subtraction. Phase/replan/resume preserves explicit rounds and separate messages/launches. Unknown legacy usage under an enforced allowance pauses accounting-incomplete.

- [ ] **Step 2: Run RED.**
~~~powershell
node --test test/dialogue-recovery.test.js test/checkpoint.test.js test/resume.test.js test/queue-runtime.test.js
~~~
- [ ] **Step 3: Implement explicit validated migration and constrained continuation.**
~~~js
if (continueRequested && checkpoint.pending?.questions?.length)
  throw new Error('A human decision is pending; use --decision-file.');
if (continueRequested && checkpoint.technicalPause?.kind === 'budget-exhausted')
  throw new Error('The saved budget is exhausted; --continue cannot change limits.');
~~~
Keep v1 validation intact, then copy original envelope and create new v2 revision/digest. Never mutate old accepted answer identities or fabricate delivery/usage. V2 integrity covers continuation, questions, queue, budgets and operation receipts. Validate workspace/reference identity before effects. --continue is only for a saved technical pause with known-safe next effect, no human pending and unchanged mode/limits; uncertain external mutation/inference requires reconciliation, not automatic retry. Do not add budget-raising flag.

Queue carries validated project/run/unit context refs via existing stdin/file input, not huge argv or outer MCP. Archive context/journal recursively before disposable cleanup. Required persistence errors stop; optional historical search can visibly fall back to complete current records. Reuse completed outcomes instead of inference/edits/landing/accounting twice.

Retain notebook proposal/promotion operation identities so accepted recovery cannot append a duplicate lesson; the saved current snapshot and selection manifest remain authoritative if optional recall is unavailable on resume.

- [ ] **Step 4: GREEN affected and full suite.**
~~~powershell
node --test test/dialogue-recovery.test.js test/checkpoint.test.js test/resume.test.js test/queue-runtime.test.js test/queue.test.js test/queue-cli.test.js test/campaign.test.js test/artifact-retention.test.js test/args.test.js test/cli.test.js
node --test
~~~
- [ ] **Step 5: Self-review/report, stage exact changed task files, commit.**
~~~powershell
git diff --check
git status --short
git commit -m "feat: preserve coworker context across queues and safe resume"
~~~

## Task 6: Reports, instructions and final integrated acceptance

**Files:** Create src/dialogue-report.js, test/dialogue-report.test.js, docs/guides/coworker-dialogue.md. Modify src/report.js, src/dashboard-transcript.js, src/run-journal.js, src/cli-help.js, README.md, commands/resume.md, docs/guides/usage.md and skills/uroboros/SKILL.md. Update affected rendering/packaging/help tests. Do not reorganize runtime paths or regenerate architecture HTML.

Task6 also owns the minimal src/dashboard-view.js normalized-dialogue pass-through and actual buildDashboardSnapshot-to-render regression in existing dashboard tests. Its current curated decision drops native context/issues/resources/next-action fields before rendering. Carry only allowlisted display data using the final producer contract; preserve the separate curated client snapshot and existing dashboard, not a raw checkpoint export. Reuse task-6-report-projection-map.md for verified current sinks, escaping/privacy boundaries and dependent producer fields.

Task6 owns the deferred Task3 compatible-transcript stance correction in src/planning-dialogue.js and its focused rendering regression: questions/rebuttals/unreadable replies must not default to agreement. Derive display status from validated explicit action; conversation-only turns remain neutral. This is reporting projection, not new approval authority; retain the legacy reader contract.

**Interfaces:** Consumes stored snapshots, issue/message/disposition history, actual delivery/inspection receipts and resource accounts. Produces existing Markdown/HTML report projections, not a new dashboard.

- [ ] **Step 1: Add failing real rendering tests with literal state fixtures.**
~~~js
const html = renderDialogueHtml({
  phase:'planning',authority:'codex',snapshot:{digest:'d1'},issues:[],resources:{usageUnknown:true},
  messages:[{sender:'claude',action:'ask',content:'<script>alert(1)</script>',evidence:[]}]
});
assert.doesNotMatch(html, /<script>/);
assert.match(html, /&lt;script&gt;/);
~~~
Also assert readable natural questions, answers, rebuttals/dissent, source links, missing/unknown evidence, current context/recall manifest and next action. Distinguish prepared/delivered/agreed from inspected-and-assessed. Historic records remain readable. Never render credential fields.

- [ ] **Step 2: Run RED.**
~~~powershell
node --test test/dialogue-report.test.js test/conversation-rendering.test.js test/report.test.js test/dashboard-transcript.test.js
~~~
- [ ] **Step 3: Implement projection and truthful usage documentation.**
~~~js
export function renderDialogueReport(state) {
  return [
    'Shared context: ' + state.snapshot.digest,
    'Phase: ' + state.phase + '; authority: ' + state.authority,
    ...state.messages.map(message => message.sender + ' / ' + message.action + '\n' + message.content)
  ].join('\n\n');
}
~~~
Extend the projection with explicit issue disposition, source refs and resource labels required by tests/spec. Escape all model text for HTML. Document the approved query->shared context->Claude plan/Codex review->Codex execute/Claude review flow, clarification/correction/replan/human/technical routes, discretionary final depth, mandatory evidence, no default dialogue cap, explicit budgets, memory limitations and safe --continue. No live-provider verification claim.

Before modifying shipped agent instructions, read superpowers:writing-skills and perform a fresh-context application scenario before/after; do not treat grep text checks as an application test. Keep plugin paths and existing version metadata unless a coherent release decision is explicitly recorded; local code is not publication.

- [ ] **Step 4: Final tests/packaging and nineteen-case coverage matrix.**
~~~powershell
node --test --test-reporter=tap
node install.mjs --dry-run
node bin/loop.js --help
npm pack --dry-run --json
~~~
Record exact final tree/commit, counts/failures/skips, provider-denial evidence and packaging warnings. Map every spec acceptance case to real named tests/current code. No later task remains hidden behind the word complete; live-provider smoke/install/publication remain separately unperformed.

- [ ] **Step 5: Commit and independent whole-branch review.**
~~~powershell
git diff --check
git status --short
git commit -m "docs: explain coworker dialogue and verified recovery"
~~~
Explicitly stage only changed task files first. Generate review package from fcd7c48 through final HEAD; reviewer reads spec/plan/coverage and ledger deferred items. One final fix worker and scoped re-review if findings exist. Preserve all evidence. Do not push, merge or release; hand off verified local result and any remaining limitations.
