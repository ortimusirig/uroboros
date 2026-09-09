# Task 2 — native workflow delivery and safe continuation

Base: `4978794b7567883a22e6c18e08da2e51131a624b`. Worktree: `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/work/uroboros-two-agent`. Task 1's loader/bundle and binding API remain unchanged. This report covers only Task 2; aggregate pin initialization, campaign/queue process propagation, reports, distribution and skills remain assigned to later tasks.

Status: DONE_WITH_CONCERNS, locally implemented and verified; final affected gate 258/258, exit 0. Independent review remains the controller's next step. This report accompanies the scoped implementation commit.

## Runtime behavior

- Parentless native `runPlan`, `runDecomposeProject`, `runDecomposeGoal` and `run` select the shipped binding before preflight/provider/effect launch. Direct `runPlanCandidateSet`, `runPlanningDialogue` and `runExecutionDialogue` obtain it through the common context creation seam. A validated internal parent supplies the pin instead of selecting the installed default again.
- Internal `workflowBinding` options are carried through `openPlanningContext`, `runPlanningDialogue`, `runPlanCandidateSet`, `runExecutionDialogue`, `runPlan`, `runDecomposition`, and `run`. No CLI flag/environment selector, dependency, provider default or executable path changed.
- `src/shared-context.js` exports `assertNativeContext(context)` and `resolveNativeWorkflowBinding({ workflowBinding, parentSnapshots })` for internal consumers. Caller context cannot override requirements, target, workflow identity/binding/reserved entry. A similarly named `queueParent` caller value remains grounding and does not select inherited methodology. Multiple validated sources must agree, including two different valid bound digests, not only bound versus unbound.
- Snapshots retain one required `uroboros-workflow-binding` entry containing the full captured binding plus the independent `workflow` identity. Extensions retain both and reject replacement entries. The common renderer delivers only the current native phase's adapted sections. Its header and projected entries identify projection and the original digest; projected bytes are never represented as the saved snapshot bytes.
- Known nested `queueParent`, `planning-handoff.snapshot` and `retained-phase.parentEntries` carriers project their workflow entry to an identity-only reference. Full immutable nested snapshots and conversation history remain stored. Ordinary non-snapshot caller text is not parsed as a mandatory harness carrier, and unaffected carrier content retains its original delivery bytes. This is workflow projection, not general JSON sanitization/DLP.
- Every new context journal records a `workflow-start` identity before provider operations. New planning, preparation-pause and execution continuation records independently save `workflowIdentity`. `reopenPlanningContext` authenticates existing files, sidecar manifest, journal tail and latest state, then compares captured binding, continuation identity and durable workflow-start identity. A bound snapshot requires the independent continuation and start identity. New bound records cannot qualify as historical by deleting a field or entry.
- `validateNativeContinuation` compares one binding across retained phases while preserving completed-effect, unknown-usage and budget checks. Native execution recovery reads the captured binding; both retained phase transitions carry the validated parent snapshot and binding. Legacy v1 candidate/replan calls propagate explicit legacy lineage. No completed file, operation, question, history or accounting value is reset by the workflow handoff.
- Genuine historical v2 snapshots stay unchanged and render explicit `legacy-unbound` in the delivery projection. Their new continuation identities and any new retained successors remain unbound. Existing v1 readers remain separate. No BMAD/Spec Kit adaptation is inserted into that lineage.

`src/checkpoint.js`, `src/resume.js` and `src/dialogue-dispatch.js` required no edits: the existing public resume authentication routes through the strengthened reopening/continuation validator, and all native inputs already consume `renderSharedContext`. No queue/campaign/report/skill/installer file was edited.

## Actual entrypoint and lifecycle evidence

The new `test/workflow-native.test.js` runs real native controllers with fixed protocol responses at external provider boundaries. Responses do not inspect methodology text to decide an action. It captures actual `request.input` for planning/preparation and actual `request.plan`/`request.prompt` passed by native execution to its executor/reviewer adapters. Input assertions establish delivery, not model comprehension or quality.

| Boundary | Actual exercised behavior |
| --- | --- |
| Count 1 and count 2 candidate planning | Claude draft; Codex selector for count 2; Codex review. Bound identity and independently read adapted BMAD planning section reach real inputs. Existing launch counts remain 2 and 4. |
| Public ordinary planning | Same-artifact ask/answer and final reviewer approval, 4 provider calls and 1 proposal round; no extra review call. |
| Project and goal decomposition | Public `runDecomposeProject` and `runDecomposeGoal`, real tagged artifact parsers/writers and observed requirement approval; both seats receive the planning section. |
| Code grounding and evidence | The existing `both planning seats can independently inspect a new source and the next input extends material context` test now checks both-seat workflow input/identity alongside actual `source.js` inspection, code bytes in the next input, two real code captures, 5 launches and 1 round. Existing evidence/unsupported-claim tests remain in the affected gate. |
| Direct supplied task | Real native `run` isolation, executor and reviewer; exact 2 launches, observed requirement review and no planning detour. |
| Parent pin | A real persisted/reference-validated queue-phase snapshot pins planning despite a valid newer installed default. Applicable guidance occurs once and the captured nested source snapshot stays complete. Authenticated handoff and internal supplied-session conflicts refuse. |
| Public planning resume | Captured bound run resumes after an independently valid upgraded bundle is validated and then removed; one remaining reviewer call, 3 total provider debits, old captured digest/text. Authentic historical planning resumes with no added adaptation. |
| Public decomposition/execution upgrade resume | `public project resume uses captured guidance after valid installed upgrade`, `public goal resume uses captured guidance after valid installed upgrade`, and `public execution resume uses captured guidance after valid installed upgrade`: installed version B is still valid and present during resume; one remaining reviewer call, 3 total provider debits, captured old digest and no version-B sentinel. |
| Retained bound transition | `retained execution planning execution keeps bound lineage and completed work`: upgrade installed bundle during first execution review, then real replan and remaining execution. `completed.txt` remains, only remaining work is added, 6 total provider calls/input/output token debits, one captured binding throughout. |
| Retained authentic historical transition | `retained execution planning execution keeps authentic historical lineage and completed work`: baseline native execution pauses for a human answer; current public resume proceeds through replan and execution. Completed work remains, 7 total provider calls/input/output token debits, no adaptation in any captured seat input, final successor explicitly unbound. |
| Corruption/prelaunch refusal | Missing installed profiles before native preflight/workspace allocation; deletion of independent continuation workflow identity; marker, entry, required status, content and all captured metadata tampering with original journal/manifest left authoritative; distinct valid A/B conflicts; reserved caller override attempts. No affected provider launch. |
| Existing recovery guards | The complete affected scope includes public technical continuation, uncertain prepared operations, ambiguous completed writers, unknown usage, exhausted saved budgets, retained planning manual approval and incomplete-context refusal, queue landing recovery and v1 continuation tests. These guards remain distinct from workflow identity. |

The adapted planning-content expectation is read independently from `src/workflow-profiles/adapted/bmad-planning.md`. Disposable version B appends `NEW_INSTALLED_WORKFLOW_90210` to real adapted files, updates their SHA-256 values and the canonical combined manifest digest, and is validated by the production loader. This is a real valid changed installed bundle, not merely an invalid-file stand-in. Installed assets in the repository are never changed.

Historical fixture provenance: `copyNativeWorkflowPackage(t, { historical: true })` uses `git archive --format=tar --output=<disposable>/historical.tar 3051ccbe52d84dd7a93d80604e4230d089421038 src package.json`, then extracts that archive into a disposable package. The actual pre-integration planning/execution code produces its own snapshots, journal, sidecars and public checkpoint. No new bound run is stripped to manufacture eligibility. The current code consumes that authentic saved state. The archive baseline and loader fixture implementation are retained in the scoped test source.

## Retained verification chronology

All invocations use the existing `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/tools/workflow-capture.cjs` helper. It prepends the provider-denial shims, sets the correct per-run `URO_TEST_PROVIDER_DENIAL_LOG`, preserves prior receipts, captures raw TAP/stdout/stderr and records the actual numeric exit and elapsed time. Commands are reconstructed exactly as `node '<helper>' <prefix> <arguments>`; each receipt also records the executed Node executable and complete argument vector. Artifacts are under `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/outputs/` with each prefix followed by `.receipt.json`, `.stdout.txt`, `.stderr.txt` and `.provider-denials.log`.

For ordinary rows, arguments are `--test --test-reporter=tap test/workflow-native.test.js`. Named-filter rows below retain the exact filter and files. None of the completed retained invocations has a skip, cancel or todo. Every completed retained stderr and provider-denial file is 0 bytes (empty SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`). Failed attempts are retained as failures regardless of their filename.

| Prefix | Pass/total | Exit | Elapsed ms | Result/arguments |
| --- | ---: | ---: | ---: | --- |
| workflow-task2-native-red-01 | 0/11 | 1 | 7423 | Genuine initial RED: missing native marker/delivery and accepted reserved caller overrides; native planning/decomposition scenarios otherwise approved. |
| workflow-task2-native-green-01 | 11/11 | 0 | 3074 | Initial delivery/projection GREEN. |
| workflow-task2-resume-red-01 | 12/16 | 1 | 7210 | Two missing reconstructed-session binding failures plus two fixture setup errors (forbidden AppData scratch and incorrectly recomputed outer checksum). Not a clean RED for those fixture cases. |
| workflow-task2-resume-red-02 | 12/16 | 1 | 11002 | Expected missing execution continuation marker and missing resumed session binding; independent-identity fixture still had a stale decision digest. |
| workflow-task2-identity-red-03 | 0/1 | 1 | 2333 | Corrected genuine RED: provider launched after removal of independent identity. Arguments: `--test --test-reporter=tap --test-name-pattern='independent workflow identity' test/workflow-native.test.js`. |
| workflow-task2-resume-green-01 | 14/16 | 1 | 14058 | Despite filename, failed: two resumed fixture replies left their real human-choice blocking issue unresolved. No weakened authority check; replies were corrected to supply its explicit supported disposition. |
| workflow-task2-early-execution-red-01 | 0/1 | 1 | 612 | Genuine early-entry RED; preflight/isolation happened before missing profile refusal. Arguments: `--test --test-reporter=tap --test-name-pattern='direct execution missing' test/workflow-native.test.js`. |
| workflow-task2-native-green-02 | 17/17 | 0 | 43134 | Full then-current native file, including real direct execution and historical/bound planning resume. |
| workflow-task2-lifecycle-01 | 24/27 | 1 | 45438 | Three fixture expectation errors: execution uses nextAction/outcome for needs-decision while reason is conversation text; aggregate usage includes zero-valued optional fields. Corrected assertions preserve exact debit values. |
| workflow-task2-lifecycle-02 | 3/3 | 0 | 45397 | Public execution upgrade and both retained lineages. Arguments: `--test --test-reporter=tap --test-name-pattern='public execution|retained execution' test/workflow-native.test.js`. |
| workflow-task2-parent-red-01 | 2/4 | 1 | 2592 | Genuine missing authenticated-handoff and supplied-session conflict checks. Arguments: `--test --test-reporter=tap --test-name-pattern='parent reference|handoff cannot|candidate session|caller queueParent' test/workflow-native.test.js`. |
| workflow-task2-parent-green-01 | 4/4 | 0 | 2290 | Same exact parent-filter arguments; agreement checks added. |
| workflow-task2-affected-01 | 253/255 | 1 | 372394 | Complete pre-fix affected scope below. Two queued-resume test adapters dropped the already-supplied contextRef, explained below. Source remained frozen for the whole invocation; retained pre-fix source hashes are in `outputs/workflow-task2-affected-01-source-hashes.json`. |
| workflow-task2-self-review-red-01 | 0/3 | 1 | 1182 | Genuine RED for distinct valid bound A/B conflict, explicit historical delivery label and preserving ordinary caller carrier text. Arguments: `--test --test-reporter=tap --test-name-pattern='distinct valid bound|historical unbound delivery|non-snapshot caller' test/workflow-native.test.js`. |
| workflow-task2-self-review-green-01 | 5/5 | 0 | 45537 | All three corrections and both queued-resume fixture forwarding cases. Arguments: `--test --test-reporter=tap --test-name-pattern='distinct valid bound|historical unbound delivery|non-snapshot caller|queued saved planning inside' test/workflow-native.test.js test/resume.test.js`. |

The complete affected arguments (both `affected-01` and `affected-02`) are:

```text
--test --test-reporter=tap test/workflow-profiles.test.js test/workflow-native.test.js test/shared-context.test.js test/planning-dialogue.test.js test/execution-dialogue.test.js test/final-planning-integration.test.js test/resume.test.js test/dialogue-dispatch.test.js test/dialogue-recovery.test.js
```

The final whole-project suite is reserved for controller integration; it was not run for this task. Historical 1552/1552 is not this integration's evidence.

## Failure diagnosis and self-review

The two pre-fix affected failures are `queued saved planning inside the target resumes with real cleanliness and exact generated-path allowances` and its `across two goals` variant (`test/resume.test.js:233`). Their fake external `launchPlan` and `launchRun` callbacks destructured only `{ unit }`, dropping the real `contextRef` already provided by the queue. Planning therefore started as a fresh parentless bound run, while its authentic queue snapshot was unbound, and the new agreement check correctly rejected the mismatched handoff. The production queue runtime already forwards this reference through its existing context-stdin contract, and the working final-planning fixtures already forwarded it. The test-only fix passes `contextRef` through both callbacks; all original cleanliness, landing, integrity, replay and token assertions remain unchanged. No queue agreement check was weakened, no queue runtime source was changed, and no historical fixture was manufactured. The controller independently inspected this exact fixture diff and agreed with the diagnosis. The systematic-debugging guidance was read for this analysis.

Self-review caught that `contextDigest(workflowIdentity(...))` drops a root `digest` by design. The corrected comparison nests the identity (`contextDigest({ workflow: workflowIdentity(...) })`), preserving its digest, with a retained RED/GREEN for distinct independently valid versions. This is separate from Task 1's already-correct canonical expected-identity comparison. Historical snapshots now have an explicit unbound delivery projection without in-place mutation. Known-carrier projection only changes a carrier when nested workflow content actually projects; arbitrary ordinary caller text remains intact.

Final self-review also traced all native and legacy candidate calls, confirmed both retained transitions preserve their validated snapshot/binding, and verified that the original requirement/evidence rules, reviewer authority, budgets and uncertain-effect guards are not replaced by methodology statements. The final affected gate includes the last legacy pivot forwarding line and strengthened existing both-seat source-inspection assertions; the pre-fix gate is not attributed to those amended bytes.

No helper agent, reviewer agent, live provider, install, configuration/default/version change, push, merge or release was performed. Independent review belongs to the controller after the scoped commit. No model-quality improvement is claimed.

## Final verification and inventory

Final `workflow-task2-affected-02`: **258/258 pass, exit 0**, fail/cancel/skip/todo all 0, elapsed **382649 ms**, start `2026-09-09T07:31:57.986Z`, end `2026-09-09T07:38:20.635Z`. The source and tests below were frozen throughout this final run. It covers all six amended runtime files, the new native workflow test, both extended test files and the fixture utility through their consumers. No test/source edit followed it. Aggregate parent admission/propagation and display/distribution remain later-task responsibilities.

Handoff concern identified by controller after the final gate: the authentic historical fixture helper unconditionally uses `git archive 3051ccbe52d84dd7a93d80604e4230d089421038` at test runtime. Its provenance is genuine but its availability is not hermetic: shallow checkouts, source archives, or squash-merged histories may lack this object. The controller observed that `.github/workflows/tests.yml` uses `actions/checkout` without a fetch-depth override. This local gate has the historical object and does not establish portability to those environments. Per controller direction, leave tested source/fixtures intact and retain this concrete independent-review risk rather than silently rewriting them; this report-only concern addition does not alter the final gate's covered code.

Full raw stdout: `outputs/workflow-task2-affected-02.stdout.txt`, 62809 bytes, SHA-256 `8220a351eb0f1a9365ef7d33bd11f7db71ea332755044f17e407bc450c6ad23c`. Stderr and provider-denial log are both 0 bytes with the empty hash recorded above. The machine-readable `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/outputs/workflow-task2-final-inventory.json` contains every exact command vector, numeric exit, elapsed time, receipt hash/length and stdout/stderr/denial hash/length, plus the final changed-file inventory.

Final changed runtime/test byte inventory (SHA-256):

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| src/shared-context.js | 13792 | `9766354C9518488244B32E38CB4BA47B55DC893DC4BB9CB9428221B897ECAD7B` |
| src/planning-dialogue.js | 67817 | `CC5075B0F236355E1F606258DE41C2DE7007D25BB96A9191ACD380608E57F438` |
| src/plan.js | 47602 | `262B171E46798670A5185A4374E19A7E84AB1FA61082C9BC64BC3ADCAE0488D2` |
| src/decompose.js | 36633 | `05B85041EB41A1FBE660D73C8D540D399F0C56A5E1424DE09CC975EE3F79111C` |
| src/execution-dialogue.js | 32442 | `C8603C2201B96137EE8354B49159EFE800D30D3FE427FB961DBDE60ACBF7F251` |
| src/run.js | 146797 | `DBEE1C3F33E5208C624EA6D7622B8DAF49F6E06674BB2E54406AB537620D29FC` |
| test/workflow-native.test.js | 31760 | `E7E1CD362054B1C1919DC593514BA324AAD8C0DAA7A7B837B369B61E7E0A2C53` |
| test/fixtures/workflow-profile-fixture.js | 2130 | `96BDE580B8C15674AA8CC142D111DF6D871932FFF2950F097AFC9DF36BBF4DC5` |
| test/planning-dialogue.test.js | 49139 | `10EA4DBC17F2760C930B3E97D7245D96AF0254223A006DE0D04B0500A4F44AA9` |
| test/resume.test.js | 30339 | `AA7BA88F3AF9503344C6EF6F1A8F24DE17EE21B47EA4E609FDF316A960A73ADA` |

Retained receipt and raw output SHA-256 inventory (all files under the persistent outputs directory; suffixes are `.receipt.json` and `.stdout.txt`):

| Prefix | Receipt bytes | Receipt SHA-256 | Stdout SHA-256 |
| --- | ---: | --- | --- |
| workflow-task2-affected-01 | 2191 | `41B4FDCAB5755F03F77551888C8CD65279BF171DD4B23F32F2E0604B2F89DFBF` | `7dff81a0505013b26f113ca92954460c29eae34507e9ff4527e58547281e39cb` |
| workflow-task2-affected-02 | 2191 | `A45676BBCCC8010E505FE761E15106AE4995B3A1102942766752FD0A8AC90312` | `8220a351eb0f1a9365ef7d33bd11f7db71ea332755044f17e407bc450c6ad23c` |
| workflow-task2-early-execution-red-01 | 1983 | `8DDD574DCC9477AA351BC334AA6365E561DA3AC4769C0A5946F3D01E16DA6472` | `b14b3f7ecb321017e32ec38c97d4287f2f71b393af231ae31f5a21a6ddc52e2b` |
| workflow-task2-identity-red-03 | 1961 | `9FF64785FE590A07F2ADE78082AEF8309BDF33CA1FEA628767EA15D5A9C936CB` | `538964164c65713d2482d98eb83f20f5fc2d6c151b8022490c62d263777e8a65` |
| workflow-task2-lifecycle-01 | 1893 | `AB9295E683DCA9F8FF4E5E09002BA74F805A0903E56734A86EEADBC327CF9995` | `7895620043f2a78f21d755de871d519c9fbbf5c01ad12ec7c9af10e7c4b478bc` |
| workflow-task2-lifecycle-02 | 1955 | `20B85DB6FBAFBC3889D67A68146D7C83DA8ADF8B51D7CA35BF9F520B505AA5C1` | `a83be69047cb05b8566c2ed4254450109399e562380f15cea2f56f4407aba0b2` |
| workflow-task2-native-green-01 | 1904 | `4F4A62346354AAC78D4DC62A92B9268CB3E69E5273D93C2F8280B1EDD7E3D3CD` | `7e327320ad502c5403a8579ecb0d15f110f4b52889746c214843f34068fc4322` |
| workflow-task2-native-green-02 | 1905 | `A44C868EE3BDDE3452214D2BC2E3DFA4F37C7D81D041C65B8D186CD63D1B7D39` | `0916652bc140226ec6627bd329a3842f68386f7e33deed57a57d7fb972d5b1bc` |
| workflow-task2-native-red-01 | 1897 | `B856D3D8640B15B9F7FF58492E2AE050D1D52F8A79F10DA0019E7D7CF756B8C3` | `ade92b15221fdec453f86282cac001379705e79adbe7bae64fdeb76d23fa2779` |
| workflow-task2-parent-green-01 | 2000 | `07D7A832851BF205CB186928AA59141D2B8B4A65D16943444174F2A96B47CF8C` | `7aa6e6780c4c6836d4faa503fd22be6a6552db2544fbd84ef465db9b620bcdfb` |
| workflow-task2-parent-red-01 | 1992 | `DCC75E635D82525EDF64DF19B3A79FF34E70E6406BF8F8226B3D701266345C33` | `9680f41d09d92fbc159694185c27fecd49328d5d6c8b0da83b07ce7bc625cff4` |
| workflow-task2-resume-green-01 | 1905 | `6BCC229AD0AEB85D6570146EAA1FEF51E60A0811120431EE7B1924CF33146453` | `d7e2f72f36a86d87a205673e66c2dabc187b3e91b4d76870c58a736c07a2a8ce` |
| workflow-task2-resume-red-01 | 1896 | `D729A1378C7A74A927A73FBBDD09E27B3FE880AE2F72672A5030F94D08CDE834` | `df12cf0d51d5f8b2e45ce258f317d9006d59335515ee1600aefa944b36e8d12f` |
| workflow-task2-resume-red-02 | 1897 | `BD10F895406C78ECCFA9578D3F84908E7CA68A4D9E8B9C0D6CEFFB2C099D2862` | `3a9775f23e6bda8b14cde9757a85910798ebe74926d3c523e3a56ac3e2a16439` |
| workflow-task2-self-review-green-01 | 2077 | `9D4CA5DFE77CB3479A7DA850D6E2DCBEF6B05E198899D6022660DF5D1610A15C` | `d4f533e7a8e47b7d4aa058ac4fb245e8b437b1e4fb70fde7b5107f3b93e1a398` |
| workflow-task2-self-review-red-01 | 2012 | `8F71179DAB7190BE90B804B89B8BD918C3B141FEA40891CC63076759181277E5` | `2a59fa3e615152017670146f8d4b4fa79a23804e759e73ce43db6ac4bfc6fada` |

## Review fix round 1 — offline authentic historical fixture

Latest status: DONE, locally fixed and verified; scoped independent rereview remains with the controller. This addendum supersedes the historical-object portability concern above without replacing or reattributing earlier evidence. Base: `2edb8f82bacd45394cecc7619e2df6952da9caa0`. Scoped commit accompanying this addendum: `test: vendor authentic offline native workflow fixture`.

The Important finding in `task-2-review.md` was reproduced under systematic-debugging/TDD: the real copied helper invoked `git archive` from a disposable source-only package with no `.git`, raising `fatal: not a git repository (or any of the parent directories): .git`. The genuine first RED fails its `doesNotThrow` compatibility assertion before any helper edit. Increasing checkout depth cannot fix a source archive; the root dependency on repository history is removed from the fixture helper instead. No runtime production file, existing workflow-native assertion, CI configuration, or dependency changed.

The helper now consumes the checked-in immutable `test/fixtures/native-preintegration-3051ccb.tar.gz`. It contains exact pre-integration commit `3051ccbe52d84dd7a93d80604e4230d089421038` archival bytes for all `src/`, `package.json`, and the authentic MIT `LICENSE`: 80 regular files, no extra extracted files. Generation was a one-time offline mechanical data operation:

```powershell
git archive --format=tar.gz --output=test/fixtures/native-preintegration-3051ccb.tar.gz 3051ccbe52d84dd7a93d80604e4230d089421038 src package.json LICENSE
```

Generation exited 0. A separate Node verification exited 0: `assert.deepEqual` checked archive bytes against a fresh `execFileSync('git', ['archive', '--format=tar.gz', commit, 'src', 'package.json', 'LICENSE'])`; extracted each file through the actual helper and compared bytes with `execFileSync('git', ['show', commit + ':' + path])`; checked the complete extracted regular-file set against `git ls-tree -r` for those paths. All 80 source-file comparisons and the whole-archive comparison matched. The exact file/blob/byte/SHA-256 results are retained in `test/fixtures/native-preintegration-3051ccb.inventory.json`; adjacent `.md` records provenance and immutable maintenance rules. This authoring verification uses the original source object; normal tests do not.

Runtime fixture loading pins archive SHA-256 `513463b5c25b1ac0f2d65de11c8b5a6e86167f83dd1ce6c9d0bdfafbb0db85cc`, rejects a missing/corrupt archive explicitly, and feeds the same verified Buffer to existing system `tar` via stdin. There is no fetch, download, regeneration, current-source fallback, synthesized legacy metadata, or historical-test skip. Existing target-repository Git operations and system `tar` remain test prerequisites; private Git history is not. The portability test imports the real helper from a disposable source copy, creates and imports the historical planning module, verifies absence of the new workflow module, and verifies the retained license. Separate real-file mutations exercise missing and tampered archive rejection.

### Exact retained verification

All commands ran in `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/work/uroboros-two-agent`, with the existing provider-denial capture helper, in this order:

```powershell
node 'C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/tools/workflow-capture.cjs' workflow-task2-fix1-portability-red-01 --test --test-reporter=tap test/workflow-fixture.test.js
node 'C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/tools/workflow-capture.cjs' workflow-task2-fix1-integrity-red-01 --test --test-reporter=tap test/workflow-fixture.test.js
node 'C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/tools/workflow-capture.cjs' workflow-task2-fix1-portability-green-01 --test --test-reporter=tap test/workflow-fixture.test.js
node 'C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/tools/workflow-capture.cjs' workflow-task2-fix1-affected-green-01 --test --test-reporter=tap test/workflow-fixture.test.js test/workflow-profiles.test.js test/workflow-native.test.js
```

| Prefix | Pass/total | Numeric exit | Elapsed ms | Result |
| --- | ---: | ---: | ---: | --- |
| workflow-task2-fix1-portability-red-01 | 0/1 | 1 | 3484 | Expected actual helper failure: source-only package lacks Git history. |
| workflow-task2-fix1-integrity-red-01 | 0/3 | 1 | 3130 | Original helper still invokes Git; missing/tampered local archives do not produce the required explicit archive errors. |
| workflow-task2-fix1-portability-green-01 | 3/3 | 0 | 1986 | Source-only import, missing archive, and tampered archive checks pass. |
| workflow-task2-fix1-affected-green-01 | 49/49 | 0 | 74565 | Complete fixture/profile/native consumers pass; no fail/cancel/skip/todo. |

Final affected gate start `2026-09-09T07:52:02.984Z`, end `2026-09-09T07:53:17.549Z`. Source/tests/archive remained frozen throughout; only this report was edited afterward. The final gate includes both authentic historical consumers, `public planning resume preserves authentic historical unbound lineage with unavailable installed bundle` and `retained execution planning execution keeps authentic historical lineage and completed work`, alongside all native valid-upgrade, retained-work/debit, execution/decomposition/planning input, and workflow-profile checks. The previous broad 258 gate was not rerun because its unchanged runtime scope remains covered by its earlier evidence; whole-project integration stays with the controller.

All four receipts/raw streams are retained under `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/outputs/` as `<prefix>.receipt.json`, `.stdout.txt`, `.stderr.txt`, and `.provider-denials.log`. All stderr and denial files are 0 bytes, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. GREEN stdout contains only successful TAP, without warnings or unexpected diagnostics; the RED stdout intentionally preserves the Git failure evidence. Each receipt confirms provider-deny-first resolution and its own `URO_TEST_PROVIDER_DENIAL_LOG` path.

| Prefix | Receipt SHA-256 | Stdout bytes | Stdout SHA-256 |
| --- | --- | ---: | --- |
| workflow-task2-fix1-portability-red-01 | `D9FD84E1FEBB03EC50040258AC7FB19109C171D6B5E7B5B86D3846392AEFB804` | 2472 | `3e08fefe85ea8db92bd37ea1ca14d9230ccdf814739246889d658c84038482bc` |
| workflow-task2-fix1-integrity-red-01 | `93E053D2F50DF9D7CE8971889CDB3BF2820FD1669AB58179167B6B7203D711ED` | 7143 | `a119b0dc6dec86fb0560f4a2293fdc7e95e8f8d0c192579373d1d92053a668e3` |
| workflow-task2-fix1-portability-green-01 | `F4EDE9B9EC034DA40BBFB812F17CBB8A135C4CA5740407D2C5176EED2636752F` | 746 | `68ffc41cf9aa220b0ecf2d0a94233eb1906e3db8395e6868ae7cff8e68d56be6` |
| workflow-task2-fix1-affected-green-01 | `1FB4C7F6CE1567DA2614D6E5B373FE91A8AA0F2323C693DC9EF01D6D9A15D4B9` | 10856 | `4f981698d7bcf941689a966601648faa59e005cf995ae36d0d99226da73b13fc` |

### Final changed fixture inventory and self-review

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| test/fixtures/workflow-profile-fixture.js | 2447 | `8B1F1332433D627B164CA2E8BCDDE1E958FEAA2E6F5A816D7970AF0738C28D0C` |
| test/workflow-fixture.test.js | 2251 | `3A2E78CFC2DF8666436D87913F30507C89405D96698D60CF95FE7DE147146E14` |
| test/fixtures/native-preintegration-3051ccb.inventory.json | 19315 | `9768A49447526C21C03A6EA03099CC6D23138DB41A48CFE5A0CEA19D9432B447` |
| test/fixtures/native-preintegration-3051ccb.md | 2159 | `44FEB96BA0BB6209D08BDCB47EEC0CAD65D4338D6C00B496BBFD67290F68EDC1` |
| test/fixtures/native-preintegration-3051ccb.tar.gz | 321746 | `513463B5C25B1AC0F2D65DE11C8B5A6E86167F83DD1CE6C9D0BDFAFBB0DB85CC` |

Self-review: the mutation checks catch renewed Git-history dependency, current-source substitution, absent artifact, and changed artifact bytes. The checksum precedes extraction and extraction consumes that exact checked buffer. Archive source/license authenticity and exact file-set completeness were independently checked. No source/test/archive edits followed the affected GREEN; `git diff --check` is clean and `git diff --name-only -- src` is empty relative to the fix base. The original Important portability finding is locally resolved; no additional unresolved fix-round concern was found. This remains local Windows offline evidence, not a claim that CI or another platform was executed.
