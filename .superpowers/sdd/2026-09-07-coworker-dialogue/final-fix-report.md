# Combined final integration fix report

Status: DONE_WITH_CONCERNS — implemented and final-source verified; the local commit carrying this report is returned in the final handoff. Independent scoped re-review remains the controller's responsibility. Concerns are the explicitly disclosed adjacent live-envelope renderer and existing packaging M2, not failed acceptance tests. Base `2064697474af799926364dfa60fff0af2fc3c9ca`, branch `feat/shared-context-coworker-dialogue`. This is the one combined original-spec fix wave, not new EULR policy, packaging policy, or an independent review.

## Findings and implementation

### F1 — Current planning-to-execution handoff

The queue cached its common context before planning and subsequently passed that old snapshot to execution. It now constructs a separate immutable `executionContextRef` after validating native planning approval. The required `planning-handoff` entry contains the exact approval-bound snapshot, complete ordinary protocol history, issue/claim/assessment attribution, captured evidence bytes and their source/capture identities, journal state/tail identities, requirements/proposal, and the existing exact sidecar manifest. Both actual execution-seat inputs receive this through the existing common-context renderer. Original execution `plan` stays the approved artifact; Claude's actual submitted `prompt` is the observation boundary.

`createPlanningHandoff`, `validatePlanningHandoff`, and `readPlanningHandoffReference` reuse existing project/context/journal/manifest/evidence validators. Validation rejects native missing state, changed claimed context digest, stale current source, altered journal, cross-project context, out-of-scope manifests and missing saved references. Native markers cannot downgrade a malformed native result into legacy injected planning compatibility. New execution checkpoints retain the exact context reference; initial run, phase checks, resume preacceptance and queue recovery validate it. Completed work/results and cumulative debits are reused.

History is not silently made current verified evidence. A prior completed execution may retain historical planning source bytes only when a real commit bears the exact queue operation trailer, its diff equals the saved reviewed diff/hash, and it is an ancestor of current HEAD. The same active-unit lost-log/lost-return case recovers from the real landed operation before `logged` is durable. Pending/unexecuted units still require current source equality. Historical captures retain manifest/capture integrity and scope checks; there is no caller-flag or unit-index waiver.

Self-review found two delivery projection gaps and retained genuine REDs before correcting them: unknown fields preserved on otherwise valid protocol envelopes, and the earlier-unit producer's serialization of complete raw journal objects. `planningHistory` explicitly projects full ordinary protocol fields (including nested issues/claims/dispositions/next/request/memory fields) without opaque private/transport extensions or truncation. `priorUnitContext` uses this same projection plus validated previous handoff snapshots and explicit work/approval/result identities. Raw recovery journals stay unchanged. This is a protocol-field boundary, not a universal DLP guarantee.

### F2 — Scoped direct human approval

Direct native manual approval previously skipped complete required context. `assertHumanPlanningApproval` now guards resume before answer acceptance, native direct approval, retained-plan adoption, and handoff acceptance. It reuses `nativeHumanQuestion`'s authenticated `disputedIssueIds`, question class, current artifact/context and exact answer. The explicit `pending.issues` intersection remains distinct from the general manual-dispute fallback.

The guard refuses incomplete context, pending technical work, unrelated open blocking issues, unavailable/stale/out-of-scope evidence, and unrelated unsupported live premises. A claim shared with a separate open issue or separate disposition premise keeps normal support requirements. It does not blindly call reducer approval, which would wrongly reject the intentionally valid direct human no-premise case.

Ruling58: exact scoped uncertainty can be accepted as an existing `accepted` disposition with `by:human`, `basis:risk-acceptance`, explicit reason, decision/message/current identity. Original claims, inspection receipts and semantic assessments remain unchanged. No supports assessment, evidence inspection or retirement is manufactured. Exact scoped risk acceptance waives only counterpart semantic support, never missing evidence or incomplete context. Unsupported notebook proposals remain unsupported, not verified. This is distinct from the user's EULR-specific human-token business-action rules; Uroboros retains Codex planning-final/Claude execution-final autonomous coding. Cost if wrong: mistaken human-approved disputed premises could enter an approved plan; exact scope, factual nonpromotion and the controller's scoped re-review are important safeguards.

### F3 — Decomposition technical continuation

Project and goal decomposition now save checkpoints for native technical pauses using the existing human-checkpoint source/constitution references, matching `plan.js`. `continueDecomposition` accepts and forwards `technicalContinue` only on version2. The existing native safety predicate still refuses human-pending, uncertain effect, changed source/integrity and exhausted allowances. Version1 manual ordering remains unchanged.

## Owned files and API boundaries

Production: `src/decompose.js`, `src/dialogue.js` (narrow export of unchanged split-root checkedEvidence), `src/planning-dialogue.js`, `src/queue.js`, `src/resume.js`, `src/run.js`.

Tests: `test/planning-dialogue.test.js`, `test/dialogue-recovery.test.js`, new `test/final-planning-integration.test.js`. Plus this report. No dependencies, models, versions, installed settings or runtime folder layout changed.

## Verification method and retained evidence

All receipts are under `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/outputs/`. Prefixes below mean `<prefix>.receipt.json`, `.stdout.txt`, `.stderr.txt`. The retained capture script is `work/final-fix-capture.cjs`; its receipt records exact argv/cwd/start/end, true numeric child exit separately from wrapper state, resolved shim paths, the exact audit variable, raw stdout/stderr byte lengths and SHA-256.

Every gate prepended the persistent `tools/provider-deny-bin`, verified that both codex/claude resolve there first, and set exactly `URO_TEST_PROVIDER_DENIAL_LOG=.../outputs/final-fix-provider-denials.log`. No live providers were used. Isolated fake-provider Windows fixtures exercise real public orchestration, persistence, Git landing/recovery, and actual executor/reviewer prompt preparation. No install, auth/global settings, push, merge, release or operational-checkout changes.

Standard test command is `node --test --test-reporter=tap` with exact files/name patterns preserved in each receipt. Capture invocation is `node <persistent-root>/work/final-fix-capture.cjs <prefix> <command arguments>`; default binary is the actual Node executable. Counts overlap and must not be added together.

### TDD and intermediate disposition (all retained)

| Prefix (`final-fix-`) | True exit; pass/tests | What it establishes / limitation |
| --- | --- | --- |
| red-01 | 1; 0/6 | Five genuine feature failures; unrelated-premise fixture initially used an invalid unrelated claim/evidence link. |
| red-02 | 1; 0/1 | Corrected current unrelated premise genuinely bypassed direct human approval. |
| green-01 | 1; 4/6 | Four human negatives pass; two decomposition fixture path comparisons incorrectly assumed Windows case preservation. |
| green-02 | 1; 6/7 | Decomposition and human controls pass; Claude fixture observed original `plan` instead of submitted `prompt`. Runtime plan contract was not changed. |
| green-03 | 0; 7/7 | Initial handoff/human/decomposition regressions pass. Execution fixture later required stronger approved-terminal assertions; this gate proves transport delivery, not completed native execution approval. |
| affected-01 | 0; 157/157 | Complete initial planning/decompose/queue/runtime/resume scope; intermediate source. |
| recovery-01 | 1; 14/15 | Execution-resume fixture used a fact ID not linked to briefing evidence. |
| recovery-diagnostic-01 | 1; 0/2 | Same invalid execution fixture, including landed path that never approved execution. |
| red-landed-01 | 1; 0/1 | Invalid landed setup: execution did not approve; log failure was not reached. |
| red-landed-02 | 1; 0/1 | Invalid setup loaded the queue after its planning output already existed. |
| red-landed-03 | 1; 0/1 | Genuine new handoff recovery defect: old source was falsely required to equal legitimately landed code. |
| human-controls-01 | 1; 5/6 | Unrelated-dispute fixture incorrectly expected the native fallback to exclude a dispute; fallback correctly scoped both. |
| human-controls-02 | 0; 6/6 | Corrected explicit pending-issues intersection, no-premise direct success, scoped unsupported-risk success/nonpromotion and human refusals. |
| recovery-02 | 0; 21/21 | Genuine execution approval, planning/execution resume, landed-log recovery, malformed/current-source negatives and both decomposition tiers. |
| recovery-03 | 0; 23/23 | Adds active lost-return and prior completed-unit historical-source recovery; intermediate projection source. |
| retained-controls-01 | 0; 3/3 | Original retained scoped/manual success and new required-incomplete refusal before another writer/reviewer. |
| red-projection-01 | 1; 0/1 | Actual prompt contained valid-envelope unknown private root/nested fields. |
| green-projection-01 | 0; 1/1 | Explicit protocol projection preserves ordinary content and excludes private extensions. |
| red-identity-01 | 1; 0/1 | Genuine claimed snapshot digest tamper was ignored by canonical hashing's deliberate digest exclusion; explicit identity comparison fixes it. |
| affected-final | 0; 244/244 | Complete nine-file affected scope, intermediate before prior-unit projection. Filename retained verbatim, not mislabeled final-source acceptance. |
| red-prior-context-01 | 1; 0/1 | Actual later-seat prompt contained prior raw transport/private records in a real two-unit queue. |
| green-prior-context-01 | 0; 1/1 | Corrected prior-unit producer delivers validated earlier history without opaque records; further assertions added for distinct prior-only identity/text. |
| affected-frozen-candidate | 1; 238/245 | Six new fixture failures asserted exclusion from the same live execution conversation, not only the prior-unit handoff. That adjacent renderer behavior is disclosed below. Seventh failure read approval identity from an outer still-pending planning result during resume instead of the actual supplied handoff; test now observes the latter. |
| human-final-controls | 1; 54/55 | Shared-premise and missing-capture refusal pass; stale source correctly refused at target-content identity validation, but the test's error regex omitted this earlier refusal wording. Test-only correction retained. |

`final-fix-affected-ready` passes **248/248**, true exit0, no fail/skip/cancel/todo, 253354ms wall time. Exact files: `test/planning-dialogue.test.js test/decompose.test.js test/queue.test.js test/queue-runtime.test.js test/resume.test.js test/dialogue-recovery.test.js test/final-planning-integration.test.js test/dialogue.test.js test/shared-context.test.js`. This includes distinct prior-unit planning identity/content, ordinary prior execution dialogue, later-seat exclusion of prior private fields, and human shared-premise/missing/stale evidence controls. Stdout 59471 bytes SHA-256 `e55b5747e2f23e05144c6060c5e1a8d1dd40a9b2792d1fe35248f09363c1f9d3`; stderr and provider-denial log are empty.

### Frozen source and full gate

`outputs/final-fix-freeze.json` inventories all nine changed source/test files and 94 retained evidence objects at freeze. Its 26706 bytes hash to `b2c8dc6101ba23ee1efb04925d0835458d2f61616f8fd57fa9a97aaf54a531da`. The report itself is documentation completed after tests, not a source/test freeze input.

| Frozen file | Bytes | SHA-256 |
| --- | ---: | --- |
| src/decompose.js | 36460 | 9d03b035107188c22c5952a60f191be4613113408a2c96b31fdba8f8e31bea56 |
| src/dialogue.js | 23112 | df97775d5548036635d21b7dca71f9623eccd954e7383881072b295a98d3ca9b |
| src/planning-dialogue.js | 66362 | 9a4c983206038c11aada2a7437147752c72674e5764dff1b4bfdb9f128e3c85d |
| src/queue.js | 49364 | 0bc8178e79ba471883908e1e35880e5e4b31c23ed2ac0248f0a8a220ba363d34 |
| src/resume.js | 9050 | a082426e80018ef900b63f86141144711046ff329e1d1995f46a574473ca2094 |
| src/run.js | 145548 | 4746fb8ed4589dafe5fe59b5d3c165309752d30128de19720173ec4a085ae18b |
| test/planning-dialogue.test.js | 48739 | 1196acc7e3c23945b1836bb752b2fc299a42a31ca3a7448db699fa32f6ae021e |
| test/dialogue-recovery.test.js | 47311 | 92652df4bee3dc2c8b3547e8b467d2db3930425874eda041051772699cdd1478 |
| test/final-planning-integration.test.js | 20949 | 83aba9d54e8269d1395a2c1b5014cc0b2018cf164aa0ab7d08053bffda0d812f |

`final-fix-full`: **1552/1552 pass**, true exit0, fail/skip/cancel/todo0 (1520 top-level tests, 32 nested). Command `node --test --test-reporter=tap`, started 2026-09-09T03:59:05.520Z, completed 04:16:46.276Z, 1060756ms wall time (17m40.756s). Stdout 343737 bytes SHA-256 `6e8e3102f05d4371363bc5d8b9ceae1c544a701ecd473837391ac6e942e48b14`; stderr and provider-denial log zero bytes, both SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Actual warning-line scan is empty. This is fresh final-source evidence, not the base1518 result.

`outputs/final-fix-audit-full.json` re-read and verified stdout/stderr byte lengths and hashes for all32 captured commands, preserved their numeric exits/counts, and scanned actual warning lines. 17024 bytes SHA `bbfa7fcf2fb7fe96de6b3cc0ca5e72c748e5ef921e774a0f131f0309ef22dd35`. Only the two dry-pack receipts contain the known M2 warning.

`outputs/final-fix-postfull.json` verifies all nine source/test files still exactly match the freeze and inventories100 retained evidence objects (including final raw output, receipt, audit and earlier failures). 28138 bytes SHA `5cd72dab4b7610699520b4ea57e315a8fbc25cd72ca111b92c50d57abef87a51`. It contains exact SHA/length for every retained receipt rather than duplicating all100 entries here. No source or test changed after freeze. A final post-commit inventory additionally records committed HEAD; this report's final handoff identifies it.

### Dry public/package gates

`final-fix-install-dry-run`: `node install.mjs --dry-run`, true exit0, plugin validation passes (15 commands, 1 skill, 257 source files), no installation performed.

`final-fix-help`: `node bin/loop.js --help`, true exit0, public help succeeds.

`final-fix-pack-dry-run`: `cmd.exe /d /s /c "npm pack --dry-run --json"`, true exit0, 354 selected entries including the new test. Existing npm gitignore-fallback warning retained in 166-byte stderr. M2 explicit package policy remains a release follow-up, not addressed here.

Repeated on final source as `final-fix-install-final`, `final-fix-help-final`, `final-fix-pack-final`: all true exit0, same plugin/source count and 354 pack entries. Installer stdout 510 bytes SHA `cb51066d0db11babfd191c157fdf737519ff0836190a7ebbd04511a95496256d`; help stdout 5127 bytes SHA `af76910432541471bfa008b561d717f36f5f969cb886e2a324cf29a0e4f5fad5`; pack stdout 39379 bytes SHA `ed5684fbc57fa32d0be5fd62de6a0fc4a5c899e07758c5998ae5a79b2a8c26fd`. Pack stderr retains the same 166-byte M2 warning, SHA `b57caa295919b31f9ae5073e204bb579f2407a75888d109e94a9c5cc64fe39fb`; installer/help stderr empty.

## Self-review and limitations

Read the complete combined diff and public-boundary regressions. Original source/capture validator behavior stays unchanged; no parallel validator or widened current roots. Full protocol projection remains distinct from display-only summaries and raw recovery evidence. Current-vs-history classification is bound to an actual landed operation. Tests observe both real execution-seat input fields, genuine checkpoints/receipts, no-repeat provider/cycle counters, exact cumulative usage, unchanged partial work, and real Git commit count. Direct human risk cannot promote unsupported facts. No v1/manual/product/permission/replan path is repurposed into generic artifact approval.

Existing large orchestration modules remain large; the fix is confined to their existing boundaries instead of restructuring them. Fake-only tests do not prove real model judgment quality, installed CLI compatibility, live billing or deployment readiness. This report does not replace the parent's independent scoped final re-review. No release readiness claim is made.

Adjacent observation during the two-unit fixture strengthening: the existing same-unit live execution dialogue renderer includes unknown valid-envelope `privateOptions` on the next reviewer input. This wave's explicit queue-handoff projection prevents those fields crossing into later-unit context; it does not change the general live renderer. The failed candidate receipt retains the observation and the controller was notified before freeze. No universal private-trace/DLP claim is made.
