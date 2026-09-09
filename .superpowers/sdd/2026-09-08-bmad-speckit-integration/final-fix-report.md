# Final integration fix — F1 queue workflow delivery

Owner: /root/workflow_final_fix. Baseline: `b785f7b7febb00da22c5ef35469aa1e009f3a5ee`, existing `feat/shared-context-coworker-dialogue` worktree. This is the single combined fix wave for the final review's F1. No helpers or reviewers were dispatched.

## Correction and boundaries

`src/shared-context.js` now recognizes the harness queue's `prior-units` / `queue-results` carrier with queue provenance, follows its `[unit id, prior-work record]` tuples into captured context entries, and applies the existing nested workflow identity projection recursively. Surrounding unit, execution, landing, judgement, evidence and history records are preserved. Only the current snapshot's applicable section is delivered for each profile. Stored context JSON, binding identities and input snapshots remain unchanged; delivery retains the existing projection/original-content-digest labels.

The producer and persisted schema did not change. No general JSON sanitizer, context-size cap, truncation, workflow selector, provider/controller/permission/default/dependency/version change, active installation, external network operation, live provider CLI invocation, merge, push, release or CI change was made. Existing historical and arbitrary caller/non-snapshot delivery controls remain. This fixes added workflow duplication; ordinary prior-work history still grows with the retained work and is not claimed to have a general size bound.

## Regression evidence

The five-unit test constructs real shared contexts with the production queue tuple/context shape. The section-count expectation is independently `[planning=0, execution=1, acceptance=0]` for each profile at every unit; it does not derive expected output from the renderer. After delivery, it parses nested bindings and requires exact identity-only objects through every retained depth, checks prior requirements/receipts/reviewer evidence remain visible and compares all original snapshot bytes.

Both BMAD and Spec Kit had these measured copies before the fix:

| Unit | Before planning/execution/acceptance | After planning/execution/acceptance | Before bytes | After bytes |
| --- | --- | --- | ---: | ---: |
| 1 | 0 / 1 / 0 | 0 / 1 / 0 | 4,342 | 4,342 |
| 2 | 1 / 2 / 1 | 0 / 1 / 0 | 15,954 | 6,188 |
| 3 | 3 / 4 / 3 | 0 / 1 / 0 | 40,627 | 10,089 |
| 4 | 7 / 8 / 7 | 0 / 1 / 0 | 94,317 | 19,083 |
| 5 | 15 / 16 / 15 | 0 / 1 / 0 | 214,729 | 40,647 |

These are fixture observations, not an unrelated performance guarantee. The original review used a different minimal fixture and recorded different byte sizes.

The native regression runs a real three-goal queue through `runPlan`, `run`, approved planning handoff, ordinary execution, and `landQueueDiff`. Its cleanliness preflight is a fixture no-op, and child launch adapters call the real native functions. External seats/landing judgement are fake; review approvals use real captured requirement reads and inspection receipts, and landing judgement reads actual generated diffs. It records twelve actual native provider-boundary inputs: Claude planning author, Codex planning reviewer, Codex executor `plan`, and Claude execution reviewer `prompt` for each unit. All must have exactly one section per profile applicable to their own phase. The third unit's four inputs retain the first unit's requirements, reviewer claim and actual receipt IDs. All three marker files must land. Original saved context-reference bytes and provider-input snapshots must compare unchanged.

Historical/non-snapshot controls retain plain notes, historical unbound tuple contexts, caller JSON containing entries without a snapshot, user-origin tuples containing full snapshot-shaped values, and ordinary JSON objects byte-for-byte without a new projection marker. Existing historical native resume, binding-integrity, evidence prerequisite, no-replay and accounting tests remain in the covering gates.

## Retained commands and results

The recorded test/audit commands run from `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/work/uroboros-two-agent`. Each is launched through `node ../../tools/workflow-capture.cjs PREFIX ...`, which uses the real Node process, puts provider-deny shims first on PATH, and sets a fresh `URO_TEST_PROVIDER_DENIAL_LOG`. All `PREFIX.receipt.json`, `.stdout.txt`, `.stderr.txt` and `.provider-denials.log` files are retained under the persistent root's `outputs` directory. Receipts contain exact command arrays, UTC start/end, numeric exit, elapsed milliseconds and SHA256/lengths for every raw stream. No failed/setup run was deleted.

| Prefix | Test arguments after capture prefix | True exit | Elapsed ms | Result |
| --- | --- | ---: | ---: | --- |
| workflow-final-red-01 | `--test --test-reporter=tap --test-name-pattern='five-unit queue history\|multi-unit native queue' test/workflow-native.test.js` | 1 | 10501 | 0/2; five-depth duplication reproduced; native fixture failed because local Git author identity was absent |
| workflow-final-red-02 | same test arguments | 1 | 54865 | 0/2, both genuine duplication failures; later native planning input had 4/3/3 copies for each profile instead of 1/0/0 |
| workflow-final-green-01 | `--test --test-reporter=tap --test-name-pattern='five-unit queue history\|multi-unit native queue\|queue history projection preserves' test/workflow-native.test.js` | 0 | 51939 | 3/3; no fail/skip/cancel/todo |

The RED-01 fixture correction configured only its disposable target Git repository, following the existing real queue test pattern; no global configuration changed. After GREEN-01, only test diagnostics and a nonempty receipt assertion were added, then the final source was frozen before the covering gates. The runtime bytes are the GREEN runtime; final test bytes are covered by the later affected/full gates.

Final affected command:

```powershell
node '../../tools/workflow-capture.cjs' workflow-final-affected-01 --test --test-reporter=tap test/shared-context.test.js test/workflow-native.test.js test/workflow-parents.test.js test/workflow-profiles.test.js test/planning-dialogue.test.js test/execution-dialogue.test.js test/final-planning-integration.test.js test/dialogue-dispatch.test.js test/dialogue-recovery.test.js test/plan.test.js test/decompose.test.js test/queue.test.js test/queue-runtime.test.js test/queue-cli.test.js test/campaign.test.js test/iterative-campaign.test.js test/candidate-campaign.test.js test/resume.test.js test/checkpoint.test.js test/dialogue-report.test.js test/report.test.js test/dashboard.test.js test/cli.test.js test/run.test.js
```

Affected result: **632/632 pass**, true exit0,949208ms (15m49.208s), no fail/skip/cancel/todo. Raw stdout151097bytes, SHA256 `6abb9bef94af781822bf7f0087c753bff16dbddf4afdaf5902ad931a60cead1f`. Outer stderr and correctly configured provider-denial log are0bytes. Expected invalid-revision Git fixture diagnostics remain in raw TAP alongside their passing cases. This run covers the final runtime and test bytes, including the twelve-seat diagnostics and nonempty receipt assertion.

Exact full-suite command (launched once on the frozen source):

```powershell
$env:URO_TEST_DISTRIBUTION_ARTIFACT_ROOT = 'C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/outputs/workflow-final-distribution-01'
node '../../tools/workflow-capture.cjs' workflow-final-full-01 --test --test-reporter=tap
```

Full-suite result: **1652/1652 pass**, true exit0,1247671ms (20m47.671s), no fail/skip/cancel/todo. Raw stdout368134bytes, SHA256 `4103a20aa078dec83ff6ad73eedde23039a5a9d4c5d06b701f3935e7dc05a484`. Outer stderr and correctly configured provider-denial log are0bytes. Expected branch-switch and invalid-revision Git fixture diagnostics remain in TAP; there are no failing test lines. The count includes the previously amended packaging portability tests and this fix's three new tests; the older1646 full result did not include either later addition.

The retention setting uses the existing packaging fixture's artifact switch; it preserves the actual archive/extraction, nested installer/package/load/help receipts, raw streams and workflow asset inventory. It does not change the executed test selection or source.

The full run's packaging subtest produced `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/outputs/workflow-final-distribution-01/uro-workflow-distribution-zL7y3S/uroboros-2.0.4.tgz`, SHA256 `46e14dd89b3e0522c74b70fac8c12e14e0dc2ad9e8cd13175bb86e0186c0f9b4`. Its neighboring `workflow-inventory.json` records all15 workflow assets, binding digest `0432be8a37133c2d08d0fef216c440e2d9cff48f7a1d4251a18f6d74fb89f061` and manifest SHA256 `f0571499e5b0ee1878116da8c1b22de0d432fc6ad4f6e4f220df18024f1af582`. The retained `npm-pack`, `archive-list`, `archive-extract`, `packaged-load` and `packaged-help` nested receipts each report actual status0. Nested receipts preserve stream hashes and statuses; their existing helper does not record separate elapsed durations. Full-suite TAP retains the subtest duration.

Nested npm stderr discloses the existing `gitignore-fallback` package-policy warning and an npm11.19.0→12.0.2 update notice. No npm update was performed. These nested notices are distinct from outer full-suite stderr. Installer refusal fixture directories and their expected status1 receipts remain alongside the archive directory under the same retention root.

The controller independently matched this archive hash, both manifest copies, all15 asset lengths/hashes against archive and current source, the packaged final renderer against frozen source, and all5 nested status0 receipts plus10 raw stream hashes. It read the actual packaged module/help output and375-byte npm warning stream. This is an independent archive/receipt audit, not a full-suite verdict. No rerun or repack was performed for that audit.

## Frozen source inventory

`workflow-final-freeze-01` ran `../../tools/workflow-task4-audit.cjs freeze`, true exit0,6763ms. Its raw stdout contains all386 source inventory rows; inventory digest `44b9a988109cfa48067747a7c8d5940f201d2d3210a0be33e438d17df612e4be`. Raw inventory file SHA256 `aff6ea08e75fe97d0f73e8ffd2a532ada15e81bb40d078cfbd1a05aa099070b0`,64769bytes. SDD reports are intentionally excluded by the existing freeze tool; runtime/source/test files remain frozen during final verification.

| File | Bytes | SHA256 |
| --- | ---: | --- |
| src/shared-context.js | 14437 | b87442f2f219f90df047c3502c5e805b2e0d1cf7247c9af3bf722966fdc01209 |
| test/workflow-native.test.js | 43177 | e79b5102ccc2ec77bda2862b0c9808d7004d73d874dff23c6f2402d206efa858 |
| test/workflow-distribution.test.js (unchanged portability fix) | 9211 | 173ac1321538ee6d98e2c43770b6729170318a51b08ba1a7673e2d31619ee519 |

The historical1646/1646 and amended packaging8/8 results are not this fix's final-source verification. The actual offline archive/package-load test remains in the final full-suite gate. Instructions did not change, so prior genuine instruction application evidence is retained without a repeated probe. Local verification does not establish live-provider comprehension or publication/release readiness; the separate M2 package-file policy remains outside this F1 correction.

Post-full verification: `workflow-final-check-frozen-01` ran `../../tools/workflow-task4-audit.cjs check-frozen ../../outputs/workflow-final-freeze-01.stdout.txt`, true exit0,841ms. All386 files and inventory digest matched. The controller independently matched the complete full receipt/TAP, all seven completed pre-audit receipt sets/21 raw streams and all386 post-full source files.

`workflow-final-receipt-audit-01` is a retained read-only Node audit run through the same capture helper, true exit0,185ms. Its receipt preserves the entire exact `node -e` command. Its stdout inventory records all seven earlier outer receipt file hashes and21 raw payload hashes/lengths, all nine nested receipt file hashes/statuses and18 raw stream hashes/lengths, the actual1400611-byte archive, the3040-byte workflow inventory, and verified15-asset/current-renderer equality. No test was rerun or package rebuilt. Its raw stdout is21844bytes, SHA256 `34a5842ce3e0d3b4e48cdfb57a2f00008eecb420972fabb46e070a337edb13d8`; the workflow inventory file SHA256 is `f0c60cfb2f73a4d12a6ab807915d30c723ce2b7572312dda5cfebc02dc5d0590`.

## Final receipt file hashes

All eight outer stderr and provider-denial streams are0bytes, SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Exact commands, start/end times and raw paths remain in each named `.receipt.json`. The audit stdout retains the full nested inventory rather than omitting expected failing installer receipts.

| Prefix | Exit | Elapsed ms | Stdout SHA256 | Receipt JSON SHA256 |
| --- | ---: | ---: | --- | --- |
| workflow-final-affected-01 | 0 | 949208 | 6abb9bef94af781822bf7f0087c753bff16dbddf4afdaf5902ad931a60cead1f | 352187c9f1632d2ed7667b8d089317b23401d86b79a97ed995937f2324f3e42e |
| workflow-final-check-frozen-01 | 0 | 841 | 17cd8f666e27cc316663a7b2189745b5748b323dd46704444f27001db404edc9 | 43e6c1f410784ff21d2963c99ef618a3eb9206f0ef97cddd0475056ad265c661 |
| workflow-final-freeze-01 | 0 | 6763 | aff6ea08e75fe97d0f73e8ffd2a532ada15e81bb40d078cfbd1a05aa099070b0 | 0e01d9835c5c3715324248d87d23d4b034d991c2ca65be7352d7c8b89c972987 |
| workflow-final-full-01 | 0 | 1247671 | 4103a20aa078dec83ff6ad73eedde23039a5a9d4c5d06b701f3935e7dc05a484 | 2bc47a027ea45dbffb587dc36a3fa3052fd70f8e3acdbc91efa29d4d231facb7 |
| workflow-final-green-01 | 0 | 51939 | c17895385b9397f938e275c652e544e5be8219e7b9aadfa27914c3f1f6eccb00 | a9511cd12f9c2229792393c67c4890c7a0891920deed90e256fd09b2be40c88e |
| workflow-final-red-01 | 1 | 10501 | e305b024535b958acf17344d99019933bb8f17ed54e86154e16777fbbe4ba360 | 92c0d6d163088e5c2a0896549c495a4e227e8573d2ae60ab4b25a358c106e137 |
| workflow-final-red-02 | 1 | 54865 | 025c6e7d3783edab956332752d2414448b8c51065fdeec52dc01e52680c8f57a | 0aa11a3274666c95a705199d50ba59fd6827017abc4253a143d0d2338d91f7ce |
| workflow-final-receipt-audit-01 | 0 | 185 | 34a5842ce3e0d3b4e48cdfb57a2f00008eecb420972fabb46e070a337edb13d8 | f1ee73abbfe58b9e30afe4025dc69ae1c560e04cb631dcd2eb6bcb0f6114fbb4 |

Completion boundary: implementation and final-source verification are complete locally. Only `src/shared-context.js`, `test/workflow-native.test.js` and this retained report belong to this fix commit. Root/controller owns the one scoped F1 rereview and broader progress/operator records. No independent rereview, merge, installation or release is implied by these passing checks.

Precommit inspection: the exact three-file staged diff was read in full; `git diff --cached --check` returned0 and `git diff --cached --name-only` contained only those owned files. No unrelated file was staged.
