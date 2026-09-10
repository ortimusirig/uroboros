# BMAD and Spec Kit Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver pinned BMAD and Spec Kit adaptations to real Uroboros seats, preserving their identity across the complete logical run and exposing honest provenance.

**Architecture:** A dependency-free bundled-profile loader creates an immutable captured binding. Native shared context carries that binding, with phase-specific delivery through the existing renderer; parent controllers and authenticated continuations inherit it instead of resolving a new default. Existing dialogue, evidence, checks and authority remain the sole decision/effect machinery.

**Tech Stack:** Node.js >=24, ESM JavaScript, node:test, existing CLI/plugin installer; zero runtime dependencies; Windows and existing portable paths.

**Spec:** `docs/superpowers/specs/2026-09-08-bmad-speckit-workflow-integration-design.md` (written specification approved by user on 2026-09-08).

## Global Constraints

- Uroboros remains the only controller: Claude plans and Codex reviews; Codex implements and Claude reviews.
- Autonomous final authority remains the phase reviewer; humans settle unresolved manual disputes and supply missing intent or permission.
- No upstream agent personas, separate task database, Python/uv requirement, extension hooks or second execution controller are introduced.
- Existing project → goals → task units and executable/plugin paths remain stable. No new runtime dependency is required.
- A missing, malformed or digest-mismatched required profile fails before the affected provider/effect is launched; it never quietly degrades to documentation-only guidance.
- There is no automatic quality score, numerical task-size threshold, fixed task count, compulsory extra conversation round or additional final-review call.
- A checkbox or statement that a method was followed is not evidence of correctness.
- Upstream workflow guidance cannot override the user's requirements, project constraints, permissions, reviewer authority or evidence rules.
- Initial upstream baselines are BMAD commit `abe4eb1bce919c9d22cd18b3519353d5824c4b75` and Spec Kit commit `0c8e31ff0a98c362696c2edb6a1bb25a37f68544`.
- Preserve both projects' MIT copyright/license notices. Preserve BMAD's trademark notice and link its guidelines; do not imply official endorsement or rename Uroboros as a BMAD product.
- Runtime loads the adapted sections, not arbitrary instructions or hooks from original sources. Updates require a reviewed adapter/bundle change; there is no download or automatic update during a run.
- Saved resume uses the captured binding and validated content, not the currently installed default.
- Historical v1 and pre-integration native records remain readable/resumable with their original context and existing safeguards. Its continuation lineage remains unbound.
- Removing a binding from a new bound run is corruption, not eligibility for this compatibility path. No in-place methodology migration of an approved run is introduced.
- Direct execution of a supplied task does not gain a compulsory planning detour.
- No installation into the user's active environment, authentication/global configuration change, live-provider smoke, merge, push or release is performed merely by approving this local integration design.
- Preserve all project/SDD objects in the user's persistent Uroboros folder.

---

## Worktree, verification and file responsibilities

Work only in `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/work/uroboros-two-agent`, branch `feat/shared-context-coworker-dialogue`. Feature baseline is `3051ccbe52d84dd7a93d80604e4230d089421038`. Prior 1552/1552 is historical verification of unchanged runtime, not this integration. Do not touch operational `C:/mt/uroboros` or other linked checkouts. No version bump or provider-default change.

The tasks below are outcome boundaries: independently usable/validated bundle; native run delivery and durable recovery; aggregate parent continuity; distribution/observable acceptance. They are sequential because consumers depend on the binding contract. Use one implementer at a time and a fresh task-scoped reviewer after each. Read the actual interfaces before adapting consumers; any contract correction belongs in the ledger and downstream brief.

Production files:

- `src/workflow-profiles.js`: shipped bundle loading, hash/schema checks, immutable captured binding, phase projection, safe identity summary. No provider or network calls.
- `src/workflow-profiles/manifest.json`, `adapted/*.md`, `upstream/{bmad,spec-kit}/...`, `README.md`: exact pinned source/notices and separately attributable adapted guidance. No scripts/hooks loaded as code.
- `src/shared-context.js`: carry/validate the reserved binding entry and integrity marker; render applicable guidance without duplicating full captured text into every operation.
- `src/planning-dialogue.js`, `src/plan.js`, `src/decompose.js`, `src/execution-dialogue.js`, `src/run.js`, `src/checkpoint.js`, `src/resume.js`: initialize once at native entry, transport to actual seats, preserve capture through handoffs/replans/checkpoints, reject corrupt continuation before effects.
- `src/queue.js`, `src/queue-runtime.js`, `src/campaign.js`, `bin/loop.js`: parent pin/state propagation to child stdin/context and aggregate acceptance. Batch is a campaign entry; no `batch.js` or separate goal-acceptance module is needed.
- `src/dialogue-report.js`, `src/report.js`, `src/dashboard.js`, existing CLI help only where necessary: curated profile identity/status projection, no opaque model-field leakage.
- `install.mjs`, `README.md`, `docs/README.md`, `docs/guides/usage.md`, `docs/guides/coworker-dialogue.md`, `docs/guides/task-sizing.md`, `docs/guides/workflow-profiles.md`, `skills/uroboros-chunk/SKILL.md`: delivery validation, honest discoverability and calling-session boundary. Task 4 owns these; only edit other shipped command/skill files if their existing instructions directly contradict the integration, reporting exact scope first.

Retain every test invocation via unique `outputs/workflow-*.{receipt.json,stdout.txt,stderr.txt}` files. Use the existing provider-deny shims FIRST on PATH with **`URO_TEST_PROVIDER_DENIAL_LOG`**, with a new integration-specific log, not the old final-fix log. Full suite once on the final integration source; each task runs its complete affected test files before commit. Do not repeat the 17–30 minute full suite after every isolated loader/doc edit. Record the real numeric process exit, elapsed time, stderr and receipt/file hashes. Never manufacture missing old RED/GREEN evidence. Tests use real runtime with fake external providers; provider input capture is a transport assertion, not evidence of model judgment.

## Binding contract shared by the tasks

`WorkflowBinding` is a JSON-only union:

```js
// Bound shape; source and notice hashes identify the bundled originals.
{
  schemaVersion: 1,
  mode: 'bound',
  digest: 'sha256-of-canonical-material-excluding-root-digest',
  profiles: [{
    id: 'bmad', // the other supported id is 'spec-kit'
    adapterRevision: 1,
    upstream: { repository: 'https://github.com/bmad-code-org/BMAD-METHOD', commit: '40-lowercase-hex' },
    sources: [{ path: 'upstream-relative-source-path', sha256: '64-lowercase-hex' }],
    notices: [{ path: 'upstream-relative-notice-path', sha256: '64-lowercase-hex' }],
    sections: [{ id: 'planning', phases: ['planning'], content: 'captured adapted guidance', sha256: '64-lowercase-hex' }]
  }]
}
// Explicit inherited historical lineage, never accepted to opt a new run out.
{ schemaVersion: 1, mode: 'legacy-unbound' }
```

The digest is SHA256 over recursively key-sorted JSON, preserving array order and excluding only the binding's root `digest` (not every nested digest). The bound array contains exactly `bmad` then `spec-kit`, with unique sources/notices/sections and no executable/configuration extras. Captured old supported-schema profiles validate structurally and against their own hashes; do not compare them with the currently installed default. Installed loading additionally validates every actual source/notice/adapted file and rejects nonregular/symlink/traversal paths. Source paths are provenance on captured bindings, never filesystem authority.

Required exports (object arguments are intentional):

```js
loadWorkflowBinding() // -> deeply frozen bound WorkflowBinding; only shipped root, no caller path/env override
validateWorkflowBinding({ binding }) // -> validated binding or throws
workflowIdentity({ binding }) // -> { schemaVersion: 1, mode, digest? }
workflowSnapshotEntry({ binding }) // -> one required context entry with id 'uroboros-workflow-binding', kind 'workflow-binding', JSON content and source identity
readWorkflowBinding({ snapshot, expected, allowLegacy = false }) // -> binding; validates marker/entry agreement and optional expected identity
renderWorkflowGuidance({ binding, phase }) // -> string containing selected sections and attributable identity; legacy explicitly says unbound
summarizeWorkflowBinding({ binding, phase }) // -> curated JSON { mode, digest?, profiles: [{ id, adapterRevision, upstreamCommit, sections: [id] }] }
```

Supported applicability values are `planning`, `execution`, `acceptance`. Each profile contains exactly those three adapted sections, with matching one-element `phases`. Planning text covers decompose, candidate preparation/selection and retained replan; execution text covers implementation and review, acceptance covers complete goal review. Section IDs/phase names are versioned contract values, not arbitrary user selectors. Renderer fails on unsupported phases rather than silently delivering no guidance. A historical phase without captured guidance remains visibly unbound and receives no BMAD/Spec Kit method text.

Native snapshots carry `workflow: workflowIdentity({ binding })` plus the single reserved required entry. Extend preserves both. Generic historical snapshots with neither field nor entry remain valid; native new entry always initializes both. Marker present with missing/wrong/duplicate/non-required entry, entry present without marker, malformed binding, or conflicting expected identity throws. Caller context keys `workflow`, `workflowBinding`, `uroboros-workflow-binding` and caller entries of kind `workflow-binding` are reserved and rejected. Only internal function options or already validated parent references can supply inherited bindings. They must agree when more than one parent source is present; an ordinary CLI/context payload cannot supply an arbitrary binding implementation or historical opt-out.

`renderSharedContext` remains the common renderer. When bound, it replaces only the reserved entry's full binding JSON in the **delivery projection** with `renderWorkflowGuidance`; immutable on-disk snapshots still contain the full binding. Label this as a projection with the original content digest, never assert that projected bytes equal the persisted JSON. All non-workflow context/evidence retains existing delivery and authority semantics.

### Task 1: Validated offline bundled workflows

**Files:** Create `src/workflow-profiles.js`, `src/workflow-profiles/manifest.json`, `src/workflow-profiles/README.md`, six `src/workflow-profiles/adapted/{bmad,spec-kit}-{planning,execution,acceptance}.md` files, upstream references/notices under `src/workflow-profiles/upstream/`, `test/workflow-profiles.test.js`, `test/fixtures/workflow-profile-fixture.js`.

**Interfaces:** Produces all exports in Binding contract above. Consumes no native controller changes. `readWorkflowBinding` operates on the documented marker/entry shape without importing shared-context.js (avoid an import cycle). The test fixture exports `copyWorkflowPackage(t)` returning `{ root, modulePath, assetsPath }`, and `importWorkflowPackage(modulePath)` using a unique file URL; it creates a disposable installed-module copy, not a production loader-path option. Include all binding contract requirements in the extracted task brief.

- [ ] **Step 1: Write executable loader/integrity failures first.** Tests exercise offline loading, absent profile/assets/notices, changed bytes, source traversal/symlink (portable privilege-aware symlink fixture), malformed metadata, duplicate/unknown profile IDs/sections, source hash mismatch, immutable return, old capture validation after package change, reserved snapshot identity conflicts, and projection applicability. Start with a dynamic import guarded by file existence so absent implementation is an assertion failure, not module-resolution noise:

```js
test('shipped workflow binding can be captured without a provider or network', async () => {
  const modulePath = fileURLToPath(new URL('../src/workflow-profiles.js', import.meta.url));
  assert.equal(existsSync(modulePath), true, 'offline workflow loader is missing');
  const { loadWorkflowBinding } = await import(pathToFileURL(modulePath).href);
  const binding = loadWorkflowBinding();
  assert.equal(binding.mode, 'bound');
  assert.deepEqual(binding.profiles.map(p => p.id), ['bmad', 'spec-kit']);
  assert.equal(Object.isFrozen(binding.profiles[0].sections), true);
});
```

The break caught is missing/invalid distributable loader, not an exact prose wording decision. For corruption, copy the package, mutate one adapted file leaving its manifest unchanged, call that package's loader and assert refusal; do not use the loader's digest helper to compute expected hashes. Use Node crypto independently to hand-check saved bytes.

- [ ] **Step 2: Run RED.** `node --test --test-reporter=tap test/workflow-profiles.test.js`; retain command, expected failing assertions and numeric exit before production edits.
- [ ] **Step 3: Acquire exact originals at the full pins from the spec.** BMAD: `skills/bmad-create-epics-and-stories/steps/step-02-design-epics.md`, `skills/bmad-correct-course/SKILL.md`, `LICENSE`, `TRADEMARK.md`. Spec Kit: `templates/tasks-template.md`, `templates/commands/implement.md`, `templates/commands/analyze.md`, `templates/commands/converge.md`, `LICENSE`. Fetch pinned raw.githubusercontent.com bytes as data, preserve bytes/notices, record SHA256s; never execute originals. Store original repository-relative paths in metadata, with separately explicit installed local paths in the manifest. Use apply_patch for authored code/prose. No full upstream clone or toolkit install.
- [ ] **Step 4: Author bounded adaptations and minimal loader.** Each section begins with scope/authority precedence, contributes concrete review questions, and identifies original sources in metadata. BMAD planning asks what usable outcome exists, whether a split changes evidence/risk/feedback, dependencies and retained evidence; execution asks whether discoveries invalidate approved assumptions and what completed work can remain; acceptance asks whether the whole capability works together. Spec Kit planning maps requirements/constraints to acceptance and implementation/test work; execution asks to inspect approved artifacts and current code, preserve contracts, test project-native success/failure paths and report unrun checks; acceptance reconciles actual coverage, contradictory evidence and limitations. No mandatory task count, foundation-first gate, optional-test default, finding cap, extra seat, checkbox-only completion, ignore edits or hooks.

```js
import { createHash } from 'node:crypto';
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}
function bindingDigest(binding) {
  const { digest, ...material } = binding;
  return createHash('sha256').update(JSON.stringify(sorted(material))).digest('hex');
}
```

The digest implementation excludes only root metadata. Implement the loader's concrete parser/file validation following the complete Binding contract, not a generic plugin framework: read only this installed module's bundled manifest and regular files, validate fixed profile IDs and each byte hash, assemble separately adapted captured text, and never evaluate original sources. Deep-freeze returned nested data. Errors name a safe profile/asset identifier without dumping content.
- [ ] **Step 5: Run GREEN and self-review.** Complete `test/workflow-profiles.test.js` passes; literal IDs and independently computed hashes establish delivered provenance, not generic snapshots of all wording. Verify license/reference files are exact and current captured sections survive a changed installed default. Record limitations and adaptation provenance in the bundle README.
- [ ] **Step 6: Commit only owned bundle/loader/test files.** `git add src/workflow-profiles.js src/workflow-profiles test/workflow-profiles.test.js test/fixtures/workflow-profile-fixture.js`; `git commit -m "feat: bundle validated BMAD and Spec Kit workflow profiles"`. Report exact RED/GREEN receipts, source hashes and any contract concerns for the next task.

### Task 2: Both-seat native delivery, retained replanning and safe resume

**Files:** Modify `src/shared-context.js`, `src/planning-dialogue.js`, `src/plan.js`, `src/decompose.js`, `src/execution-dialogue.js`, `src/run.js`, `src/checkpoint.js`, `src/resume.js`; modify `src/dialogue-dispatch.js` only for a named pre-launch validation seam not covered by the common renderer. Create `test/workflow-native.test.js`; extend `test/shared-context.test.js`, `test/planning-dialogue.test.js`, `test/execution-dialogue.test.js`, `test/resume.test.js`, `test/final-planning-integration.test.js` where public fixture reuse is clearer than duplication. Own no aggregate controller or reporting edits.

**Interfaces:** Consumes Task 1's exact exports and binding shapes in Binding contract. Add internal `workflowBinding` option to `openPlanningContext`, `runPlanningDialogue`, `runPlanCandidateSet`, `runExecutionDialogue`, `runPlan` and decomposition's `runDecomposition`; `run(opts)` accepts it only as internal controller input, not new CLI/environment configuration. Session exposes `workflowBinding`. Saved continuation exposes `workflow: workflowIdentity({ binding })`, with binding bytes in its snapshot. Fresh `createSharedContext` optionally consumes `workflowBinding`; generic callers without it keep historical behavior until their native parent passes one. `extendSharedContext` preserves marker/entry and refuses replacements.

- [ ] **Step 1: Add RED real input tests.** Reuse actual public planning fixture/draft/review callbacks from `test/planning-dialogue.test.js:354` and the authentic execution fixture from `test/final-planning-integration.test.js`. Capture real `request.input` at fake provider boundaries; replies are fixed protocol actions independent of whether method text exists. Assert selected method content, same binding digest and original requirements/code evidence reach both seats. Cover count 1 plus multi-candidate draft/selector/review, both decompose tiers, direct supplied task, Q&A/final review without extra mandatory calls, and missing profile refusal before any launch.

```js
const delivered = [];
const capture = handler => request => {
  delivered.push({ input: request.input, snapshot: request.state.snapshot });
  return handler(request);
};
// Wrap the existing authentic draft/review callbacks; do not change their actions.
assert.equal(result.approved, true, result.reason);
assert.equal(new Set(delivered.map(r => r.snapshot.workflow.digest)).size, 1);
for (const request of delivered) {
  assert.match(request.input, /BMAD/);
  assert.match(request.input, /Spec Kit/);
  assert.match(request.input, /requirement/i);
  assert.equal(request.snapshot.workflow.mode, 'bound');
}
```

These assertions run after a real native scenario's result, and catch omission/change of runtime transport. Add at least one direct assertion of captured adapted section content from independently read fixture bytes, not just product names. Test source claims/approval with existing observed-evidence fixtures: instruction/checkbox-only factual claims still refuse, and an actual inspection can support the ordinary review.
- [ ] **Step 2: Run focused RED.** `node --test --test-reporter=tap test/workflow-native.test.js`; expected failures are missing marker/delivery or illicit new default on continuation, not fixture errors.
- [ ] **Step 3: Integrate initialization and projection.** At a parentless fresh native entry choose current loader once, before preflight/provider/effect launch. If internal parent binding or validated contextRef/planning handoff/retained phase exists, derive and compare those instead. Do not let object spread of caller context override requirements/target or reserved workflow data. At session creation:

```js
const binding = inheritedBinding ?? loadWorkflowBinding();
validateWorkflowBinding({ binding });
const snapshot = createSharedContext({
  projectId: project.projectId, runId, unitId: `${runId}:${tier}`,
  phase, sourceRevision, entries, evidence, recalled,
  workflowBinding: binding,
});
```

`inheritedBinding` is computed only from authenticated internal sources. If those conflict, throw rather than choose precedence silently. Preserve full binding in the immutable snapshot. Project only applicable guidance through `renderSharedContext`; preparation already uses the same renderer, while native execution passes `request.input` at `run.js:1233/1252` (not older line857).
- [ ] **Step 4: Add RED persistence/upgrade/corruption cases, then implement.** Copy a disposable installed package, produce public planning/decompose/execution technical or manual checkpoints with fake providers, change its bundled default validly, then public-resume each saved run. Verify old exact guidance/digest, no replay of uncertain effects, and unchanged budget accounting. Strip/alter marker, entry, required status or captured content in a bound saved run while leaving its authoritative journal/manifest identity, and assert refusal before a provider. A missing installed bundle must not prevent resume from intact capture. Use genuine pre-integration v2 fixtures (no marker anywhere) and existing v1 fixtures; their continuation and any new retained successor stay `legacy-unbound`, no new adapted text. Do not manufacture historical eligibility by deleting metadata from a newly created bound run.

```js
const inherited = readWorkflowBinding({
  snapshot: continuation.dialogue?.snapshot ?? continuation.preparationSnapshot,
  expected: continuation.workflow,
  allowLegacy: true,
});
// This read follows existing checkpoint/journal/sidecar authentication.
// Save workflowIdentity(inherited) on every newly written continuation.
```

Track identity independently in continuation and original durable start/state records, so deleting a new entry does not masquerade as an old record. Preserve existing checkpoint schema compatibility/checksum/unknown-usage/uncertain-operation prerequisites. `validateNativeContinuation`'s retained chain must check one binding throughout; `run.js` retained handoff returns binding with its validated parent snapshot. Both execution→planning and planning→execution successors inherit it without resetting completed work or resource account.
- [ ] **Step 5: Run complete affected gates and self-review.** `node --test --test-reporter=tap test/workflow-profiles.test.js test/workflow-native.test.js test/shared-context.test.js test/planning-dialogue.test.js test/execution-dialogue.test.js test/final-planning-integration.test.js test/resume.test.js test/dialogue-dispatch.test.js test/dialogue-recovery.test.js`. Add any other changed test file to the actual command. Document actual seats/entrypoints exercised and historical cases; no model-quality claim.
- [ ] **Step 6: Commit owned files.** `git add` the exact owned changed files above, not unrelated controller artifacts; `git commit -m "feat: bind native planning execution and resume to captured workflows"`. Report exported internal options, checkpoint marker rules, genuine RED/GREEN evidence and current source hashes.

### Task 3: Queue, campaign and aggregate acceptance continuity

**Files:** Modify `src/queue.js`, `src/queue-runtime.js`, `src/campaign.js`, `bin/loop.js` only if batch input requires explicit propagation. Create `test/workflow-parents.test.js`; extend `test/queue.test.js`, `test/queue-runtime.test.js`, `test/campaign.test.js`, `test/iterative-campaign.test.js` for existing real harness fixtures.

**Interfaces:** Consumes Task 1 exports and Task 2 internal `workflowBinding` option/context entry/marker. Parent queue journal stores `workflowBinding` and new schemaVersion 3; new schema requires a valid binding. Validated historical schema 1/2 without a binding is explicitly unbound, never defaulted. `runCampaign({ runOptions, ... })` captures its one binding into a normalized internal `runOptions.workflowBinding` before any round/unit. Queue's internal options accept inherited `workflowBinding`; child plan/run stdin continues using existing `contextRef`, not new public flags. `judgeGoalAcceptance` accepts internal `workflowBinding` and renders `acceptance` sections in its actual request.

- [ ] **Step 1: Add RED parent-boundary tests.** Reuse `makeFixture`/`fakeRuntime` from `test/queue.test.js:79/119` and actual queue-runtime stdin fixture, campaign dependent-child and iterative fixtures. In fresh queue/campaign, capture a parent's selection then validly change a disposable installed default before starting the next child. Assert both sequential and dependent children receive the original pin, retained unit work remains, and acceptance receives that same method. A child fake process must deserialize actual stdin and import its disposable child package, not simply echo the parent's in-memory option.

```js
assert.deepEqual(childInputs.map(input => input.snapshot.workflow.digest),
  [parentBinding.digest, parentBinding.digest]);
assert.equal(acceptanceRequest.workflowBinding.digest, parentBinding.digest);
assert.match(acceptanceRequest.prompt, /Spec Kit/);
assert.match(acceptanceRequest.prompt, /BMAD/);
```

Above assertions belong after real queue execution/acceptance; derive parent binding before upgrade, not from the children under test. Also exercise task-only queue, goal planning→execution reference, a pending queue checkpoint followed by public resume, and iterative campaign rounds. Replacing a required child binding with a valid different bundle must fail as a parent identity conflict before launch.
- [ ] **Step 2: Run RED.** `node --test --test-reporter=tap test/workflow-parents.test.js`; retain named missing propagation/version failures.
- [ ] **Step 3: Implement one parent pin.** At `executeQueue` journal initialization (baseline398/450), load or inherit once; on continuation derive only from authenticated saved parent. On `childControls` create shared snapshot with the parent's binding, preserving it in the planning-to-execution context extension. Include parent identity in saved queue options/checkpoint and validate agreement with journal and child snapshot before launch. Keep public queue JSON and task/gate names unchanged. At campaign1055 normalize once before rounds; unit612 already spreads runOptions, ensure cloning/serialization retains the binding. On resumed historical parent, retain explicit unbound lineage.

```js
const workflowBinding = savedParent
  ? validatedSavedParentBinding
  : inheritedWorkflowBinding ?? loadWorkflowBinding();
const childContext = createSharedContext({
  ...existingUnitContext, workflowBinding,
});
await acceptGoal({ ...existingAcceptanceRequest, workflowBinding });
```

These named existing-context/request variables denote the unchanged local context/request fields, not new production globals. Implement in place without a duplicate controller. `judgeGoalAcceptance` appends `renderWorkflowGuidance({ binding: workflowBinding, phase: 'acceptance' })` to its existing real arbiter request. Validate before any acceptance provider; do not add another reviewer call.
- [ ] **Step 4: Run GREEN and complete affected tests.** `node --test --test-reporter=tap test/workflow-profiles.test.js test/workflow-native.test.js test/workflow-parents.test.js test/queue.test.js test/queue-runtime.test.js test/campaign.test.js test/iterative-campaign.test.js test/final-planning-integration.test.js test/resume.test.js`. Test missing/altered new-schema binding, differing child pins, saved old capture with missing current install, historical journal continuation, and parent resource continuity. Assert no extra calls/rounds or task hierarchy change.
- [ ] **Step 5: Commit owned files.** `git add` exact changed files listed in this task; `git commit -m "feat: preserve workflow pins through queue campaign and acceptance"`. Report parent-state schema/transport evidence, numeric exits and source hashes.

### Task 4: Inspectable distribution, reporting and genuine application evidence

**Files:** Modify `install.mjs`, `src/dialogue-report.js`, `src/report.js`, `src/dashboard.js` where their current projections require it, `README.md`, `docs/README.md`, `docs/guides/usage.md`, `docs/guides/coworker-dialogue.md`, `docs/guides/task-sizing.md`, `skills/uroboros-chunk/SKILL.md`; create `docs/guides/workflow-profiles.md`, `test/workflow-distribution.test.js`; extend `test/dialogue-report.test.js`, `test/report.test.js` and existing installer tests where necessary. Do not solve the separate broad npm package-file allowlist release obligation by silently changing publication policy.

**Interfaces:** Consumes `summarizeWorkflowBinding({ binding, phase })`, immutable snapshot binding readers, parent journal identity. Curated report field `workflow` carries only summary mode/digest and profile IDs/revisions/upstream commits/applicable section IDs. Invalid capture is labeled invalid/unavailable, never certified bound; historical absence is labeled legacy/unbound. No raw opaque model payload is added.

- [ ] **Step 1: Write report and package RED tests.** Drive existing real report/dashboard projections with bound/historical/corrupt fixtures; assert displayed identities/applicability and absence of injected unknown/private fields. Run installer validation on a disposable copy with a missing profile/license, assert nonzero before installation writes. Pack into a disposable directory using existing npm tooling and inspect the archive; extract there and load profiles through its actual Node module and CLI help with network disabled/fake provider-deny environment.

```js
assert.equal(rendered.workflow.mode, 'bound');
assert.deepEqual(rendered.workflow.profiles.map(p => p.id), ['bmad', 'spec-kit']);
assert.equal(JSON.stringify(rendered.workflow).includes('PRIVATE_SENTINEL'), false);
assert.equal(packagedLoad.status, 0, packagedLoad.stderr);
assert.equal(packagedLoad.binding.digest, repositoryBinding.digest);
```

Use real returned report/packaged-process outputs; tests catch lost reporting/delivery or missing notice assets, not whether documentation contains a sentence. No live install or network during packaged loading.
- [ ] **Step 2: Run focused RED.** `node --test --test-reporter=tap test/workflow-distribution.test.js` plus new affected report test names. Retain exact failures.
- [ ] **Step 3: Implement reporting and installer validation, then GREEN.** Installer reads/validates shipped profiles before copying payload; existing src payload root carries all assets. Use curated summaries in established report/dashboard paths with clear delivery-not-comprehension wording. README/usage/discovery guide explains BMAD/Spec Kit adaptations, MIT notices/trademarks, old-run behavior, direct task execution, no second orchestrator, fixed rounds or new service/dependency. Preserve runtime paths. Native corruption refuses, not silently docs-only.
- [ ] **Step 4: Test calling-session instructions before editing.** Read writing-skills fully and required references, then run genuine fresh-agent baseline application probes using existing chunk skill and source fixtures. Scenarios: oversized file-shaped request; artificial database/API/UI layers; missing acceptance/error tests; contradictory completion evidence; retained working implementation with a scope discovery. Ask for actual decomposition/development/review decisions and evidence citations, not self-report compliance. Record baseline outputs. Update the chunk skill to discover/read relevant bundled adapted guidance and route its output through reviewed native planning/queue, explicitly distinguishing uncontrolled calling-session preparation. Run the same fresh-agent application cases after edits and document qualitative outcomes without claiming statistical improvement. Controller dispatches the probe agents on the implementer's request; the implementer does not spawn helpers or reviewers. Any additional new fixture/probe files live in this plan's preserved workspace or persistent outputs, not a second user task.
- [ ] **Step 5: Final verification and acceptance map.** Run all new workflow tests plus complete affected report/installer/CLI/skill checks. Then freeze source and run exactly `node --test --test-reporter=tap` under correctly audited deny shims. Record actual totals, numeric exit and duration; fix named regressions with TDD rather than skip/mislabel them. Run `node install.mjs --dry-run` and offline disposable archive validation. Verify all 13 spec acceptance cases with exact test/probe/receipt references; mark any unproven case honestly. Source changes after freeze invalidate their affected receipts and require a covering rerun.
- [ ] **Step 6: Commit and hand off for final review.** Commit exact owned changes with `git commit -m "feat: expose and verify bundled workflow integration"`. Report scoped/full receipts, packaged profile/source/license inventory, instruction probes, all source hashes, limitations and acceptance map. Final whole-integration review covers `3051ccb..HEAD`, excluding already approved earlier shared-context implementation as unchanged baseline. No installation/push/merge/release.

## Plan self-review / acceptance ownership

Spec cases 1,2,3,5,6,7,8,9,10 belong to Task 2 plus Task 1 integrity; case4 belongs to Task3 including actual child process upgrades, acceptance and public parent resume; case11 is checked in every task; cases12/13 and genuine application probes belong to Task4. Both licenses/source hashes belong to Task1 and their distributability to Task4. Reserved identities, old-capture schema support, historical opt-out provenance, no replay, unchanged usage and renderer projection are explicit cross-task interfaces. No second workflow controller or arbitrary loader path is introduced. A plan sketch is not complete code: prose-defined nontrivial implementations use an integration-capable worker and retain TDD/review gates.
