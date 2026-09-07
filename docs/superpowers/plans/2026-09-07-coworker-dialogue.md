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

**Files:** Create src/planning-dialogue.js, test/planning-dialogue.test.js. Modify src/plan.js, src/decompose.js, src/conversation.js (compatibility/prompt consistency/rendering), src/args.js (affected defaults/validation), src/executor.js and src/arbiter.js (observed tool receipts), src/review-protection.js and src/isolation.js (context/dialogue sidecar protections/exclusions), test/plan.test.js, test/decompose.test.js, test/candidate-campaign.test.js, test/events.test.js and the fresh-planning fixture portions of test/resume.test.js, plus affected transport/args/protection/isolation tests. Task5 still owns recovery semantics and the remaining resume test changes.

**Interfaces:** Consumes Tasks 1-2; produces runPlanningDialogue and existing runPlan/runPlanCandidateSet/decompose results plus sharedContext/dialogue/resources. Existing integer rounds, artifact validators/writer, output paths and legacy readers preserved.

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

Preserve explicit candidates and pivot-candidates 1..5. Split DEFAULT_PIVOT_CANDIDATES from the initial default: initial becomes one, existing omitted fresh-pivot breadth remains three. This avoids changing an unspecified default merely because the old code shared one constant.

Reconcile the existing exactly-two-artifact-tags prompt with the extra dialogue envelope. New-mode standing instructions must not demand an extra reviewer-written test on every review. Preserve explicitly required checks. Keep context/journal sidecars out of Git changes without treating model edits to correctness-critical records as trustworthy; validate their integrity/identity before subsequent decisions.

- [ ] **Step 4: GREEN focused and whole suite.**
~~~powershell
node --test test/planning-dialogue.test.js test/plan.test.js test/decompose.test.js test/conversation.test.js test/candidate-campaign.test.js test/args.test.js test/executor.test.js test/arbiter.test.js
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

Update snapshot with actual diff and command evidence before Claude review. Retain review bundle checks/isolation; remove any new-mode requirement to fabricate an executable test for every concern or to run an automatic extra clean final pass. Required evidence and acceptable required check outcomes remain. Final discussion can reopen at any point. New code/context invalidates old approval; unperformed correction cannot land.

For harness-run commands, capture actual argv, cwd, exit/status, full outputs and code identity at execution time. Existing evidence.js writes and gate.js onEvidence are best-effort legacy sinks: new-mode required evidence must surface capture failure and pause before a subsequent effect, not proceed using only an excerpt or invented output. Preserve legacy behavior explicitly outside the new mode. Test a failed required sink with a second command whose real counter must remain untouched, alongside the legacy sink behavior. Partial nested provider observations remain observations; never substitute outer CLI argv/cwd for a nested command.

Fresh planning retains parent issue, novelty evidence, original scope, completed work and consumed budgets; Claude revises, Codex approves, then Codex executes. Reuse amend/fresh/conclude and existing decision-resolver semantics. Legacy readers remain unchanged.

Reuse Task3 notebook lifecycle for execution work items and execution-derived memory proposals: either seat may propose; the harness validates provenance/evidence/disposition before writing. Retain selected history in execution/replan snapshots. Do not leave notebook recall or promotion disconnected from the real run path.

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
