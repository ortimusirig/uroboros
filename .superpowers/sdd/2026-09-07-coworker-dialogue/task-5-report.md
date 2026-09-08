# Task 5 recovery implementation — ready for independent review

BASE: `53db5fc150da01b9eacc9274ace0dab48701d6e6`. Sole implementer in the preserved linked worktree on `feat/shared-context-coworker-dialogue`. The containing implementation commit uses `feat: preserve coworker context across queues and safe resume`; its actual identity is returned in the handoff. Prepared maps and root release supplement consumed; no live providers, dependencies, global settings, publication or helpers.

Final status: native public recovery, explicit saved-v1 compatibility, queue context/resources and required retention are implemented. The first affected gate was 221/223; scoped production fixes passed their covering 13/13 and queued-planning 2/2 gates before the frozen full gate. The full gate was **1494/1498, exit 1**, with exactly four routed fixture failures. Their fixture-only correction is verified by targeted 4/4 and complete affected 47/47 gates; production stayed byte-identical to the full run. Per Ruling53 there is **no final passing whole-suite claim**: Task6 owns that final full run, and root owns independent review of the original BASE through this commit. Detailed source timing and all failed receipts are preserved below.

## Initial slice checkpoint (historical)

Implemented an initial native schema-2 checkpoint save/answer bridge, explicit CLI technical continuation mapping, separate technical receipts, strict saved context/journal manifest reopening, and scoped native product/permission human input. Saved autonomous/manual mode remains unchanged; material input extends the snapshot and returns to the reviewer without granting approval. The old v1 path and native planning manual-dispute direct-ruling behavior remain distinct. Completed current check projection now includes gateResult/reviewerTests/iterations so a reopened phase can approve without re-running completed checks. This is not yet full Task 5 acceptance.

## Verification receipts so far

All raw TAP files are retained in `C:/Users/aiuser4/OneDrive - Applexus Technologies/Uroboros/outputs/`. Every command prepends `tools/provider-deny-bin` and sets `URO_TEST_PROVIDER_DENIAL_LOG` to `outputs/coworker-task-5-provider-denials.log`. Final source/raw hashes, denial-log status and affected/full results appear in the closing sections; the following entries record the actual sequential checkpoints.

| Receipt | Command scope | Node exit / actual result |
| --- | --- | --- |
| task-5-red-recovery.tap | `node --test --test-reporter=tap test/dialogue-recovery.test.js test/checkpoint.test.js test/resume.test.js test/queue-runtime.test.js` | 1; 54 tests, 41 pass, 13 fail. Eight assigned historical resume failures, missing CLI mode, and four fixture setup failures because the initial new fixture used forbidden AppData scratch. Those four are setup diagnostics, not feature RED. |
| task-5-red-native.tap | `node --test --test-reporter=tap test/dialogue-recovery.test.js` after scratch correction | 1; 5 tests, 0 pass, 5 fail: missing --continue and native durable checkpoint. Valid native feature RED. |
| task-5-native-first.tap | same native file | 1; 5 tests, 3 pass, 2 fail. New canonical checkpoint field ordering exposed JSON-order scope validation; fixed by validating the actual pinned journal state after matching its canonical identity. |
| task-5-native-second.tap | same native file | 0; 5/5 pass. |
| task-5-red-technical.tap | native file, `--test-name-pattern='technical continuation|journal corruption'` | 1; 5 tests, 3 pass, 2 fail. Missing durable technical checkpoint cases; corruption/human-pending negatives pass. |
| task-5-native-technical-first.tap | native file with added technical/corruption tests | 1; 8 tests, 7 pass, 1 fail. Safe continuation exercised successfully; expectation omitted the existing zero usage subset fields. Changed assertions to exact input/output totals. |
| task-5-technical-planning.tap | native and resume files, `--test-name-pattern='technical continuation reuses|manual planning resumes|further planning dispute atomically'` | 0; 4/4 pass. |
| task-5-red-check-reuse.tap | native file, `--test-name-pattern='technical continuation reuses'`, strengthened to actual current approval | 1; 0/1. Completed saved checks lacked the outer gateResult projection and current approval failed. |
| task-5-check-reuse-green.tap | same strengthened focused case | 0; 1/1. Completed writer/checks reused and only one resumed reviewer debit. |
| task-5-red-retained-planning.tap | native file, `--test-name-pattern='public retained planning'` | 1; 0/1, missing durable native retained-planning checkpoint. |
| task-5-retained-planning-first.tap | same retained planning case | 1; 0/1, fixture disposition missing evidenced claim IDs; corrected the fake current reviewer response. |
| task-5-retained-planning-second.tap | same retained planning case | 0; 1/1, selected draft reused, remaining execution only, seven actual launches accounted once. |
| task-5-red-retained-archive.tap | retained planning case strengthened with archive and applied-checkpoint read | 1; 0/1, child phase selected a second archive. |
| task-5-retained-archive-green.tap | same strengthened archive case | 1; 0/1, second assertion exposed in-place native continuation mutation and invalid saved stateDigest. This filename is not a passing claim. |
| task-5-retained-archive-second.tap | same strengthened archive case | 0; 1/1, root archive refreshed, applied checkpoint reads validly. |
| task-5-red-preflight.tap | native file, `--test-name-pattern='exhausted saved|journal corruption'` | 1; 0/2, exhausted-budget continuation consumed receipt and corrupt journal accepted answer. |
| task-5-native-preflight.tap | native file | 0; 10/10, scoped answers, safe technical reuse, budget/uncertainty/journal guards, retained planning/root archive. |
| task-5-red-human-classes.tap | native file, `--test-name-pattern='native disputed replan|native conflicting-intent'` | 1; 0/2, disputed replan re-asked human rather than reassessing the answered scope; structured merge conflict had no human question. |
| task-5-human-classes-first.tap | same two classes | 1; 1/2, disputed-replan passes; merge resume exposed omitted saved unitKind. |
| task-5-merge-human-second.tap | native file, `--test-name-pattern='native conflicting-intent'` | 0; 1/1, real Git HEAD/parent cursor/ledger unchanged before reviewer, no replayed writer. |
| task-5-red-queue-context.tap | queue-runtime file, `--test-name-pattern='queue children transport'` | 1; 0/1, missing stdin context transport. |
| task-5-queue-context-first.tap | same transport/reader case | 0; 1/1, both children send reference/limits and reader consumes/rejects exact project/run/unit/context identity. |
| task-5-red-queue-budget.tap | queue file, `--test-name-pattern='queue carries current|enforced queue allowance'` | 1; 0/2, item allowance rejected and unknown native usage not gated. |
| task-5-queue-budget-first.tap | same queue cases | 0; 2/2, min(parent,item), current per-unit references, landing usage once, unknown usage blocks landing. |
| task-5-red-child-context.tap | native file, `--test-name-pattern='public child execution persists'` | 1; 0/1, writer did not receive queue grounding. |
| task-5-child-context-first.tap | same real child/context/archive case | 0; 1/1. |
| task-5-red-queue-review-usage.tap | queue-runtime + queue, `--test-name-pattern='hands Claude the composed|exhausted child allowance|queue acceptance preserves'` | 1; 0/3, landing runtime dropped usage, exhausted preflight became a phantom reviewer debit, acceptance unknown usage implied success. |
| task-5-queue-review-usage-first.tap | same plus `queue recovery reuses a completed acceptance` | 0; 4/4, runtime retains usage, no reviewer under exhausted allowance, unknown acceptance blocks success, completed acceptance/log recovery reuses one debit. |

## Native saved discriminator and human classes (implemented slice)

Retained planning uses the actual producer `version:2 + phase:'planning' + workspace + phaseChain/phaseLinks/candidateState`, with distinct child runId/directory and rootRunId. It is not ordinary planningContext and not legacy executionContinuation. Public validation reopens current and retained phase manifests/journal tails, validates saved source scopes/project identities and parent/link/workspace digests before accepting an answer or technical receipt. Native run clones the continuation before consumption; the root archive key is result.runId while phase question runId remains unchanged.

Explicit product/permission pending records yield scoped reviewer input. Manual disputed-replan answers retain a current question-scoped ruling and allow only current evidenced reviewer disposition, with stale terminalAction/approval cleared. Conflicting-intent merge questions derive from the completed saved merge-sequence operation, exact ledger/conflict/current artifact/context, and parent cursor. Answering creates reviewer-pending context; conclude/clear/advance remains barred through current reviewer reassessment and until material work changes. Ordinary manual artifact/dispute planning retains the separate prior human approve/stop route.

Queue slice is still in progress. Context is a pinned reference sent via stdin, validated against project/run/unit/context digest, then copied as required child grounding; it grants no source/effect authority. Initial queue journals/debits are now persisted; legacy known token facts are retained without inventing provider launch counts (`launchesUnknown` is separate). Campaign, final replay/retention gates, saved-v1 compatibility and full validation remain pending.

## Work remaining at the earlier slice checkpoint (superseded by subsequent receipts below)

- Complete native technical safety/preflight, current phase/parent-chain reopening, retained planning/merge-human classes, exact saved option/source/support validation, interrupted receipt recovery and notebook/recall behavior.
- Explicit v1 migration preserving original checksums/envelopes/answer receipts; construct the eight saved-v1 fixtures and genuine native counterparts from the prepared construction map.
- Queue child context transport and parent/item remaining allowances, durable launch/reviewer/landing/debit accounts, campaign propagation and required archive-before-cleanup retention.
- Final affected/full gates, complete per-case mapping, self-review, exact file/source/receipt hashes and exact-path commit.

No partial slice is being reported as full recovery support. Existing prepared maps remain the lookup authority for yet-unimplemented contracts; source and final accepted producer semantics govern implementation.

## Subsequent sequential slice receipts (not a full gate)

All commands retain the provider-deny PATH/log prefix documented above; filenames below are under persistent outputs. Counts are true Node totals, not summed unique coverage.

| Raw receipt | Exact Node scope after `node --test --test-reporter=tap` | Exit/count |
| --- | --- | --- |
| task-5-queue-slice.tap | test/queue.test.js test/queue-runtime.test.js test/queue-cli.test.js test/args.test.js | 1; 111/116. Five old expectations/setup seams: missing fake judge usage, exhausted-child landing expectation, unknown capped usage kind, initial landing failure API and exact context dirty-path allowances. |
| task-5-queue-slice-fixes.tap | --test-name-pattern='token budget forecasts\|completed child that exceeds\|malformed token facts\|diff check failure\|exact persisted context' test/queue.test.js | 0; 5/5 |
| task-5-red-campaign-budget.tap | --test-name-pattern='campaign child allowance\|campaign files retain optional' test/campaign.test.js test/campaign-file.test.js | 1; 0/2 |
| task-5-campaign-budget-first.tap | same campaign producer/actual child cases | 0; 2/2 |
| task-5-red-campaign-unknown.tap | --test-name-pattern='campaign unknown usage' test/campaign.test.js | 1; 0/1 |
| task-5-campaign-unknown-first.tap | --test-name-pattern='campaign unknown usage\|campaign child allowance' test/campaign.test.js | 0; 2/2 |
| task-5-red-required-retention.tap | --test-name-pattern='required native archive' test/artifact-retention.test.js | 1; 0/1 |
| task-5-required-retention-first.tap | test/artifact-retention.test.js | 0; 9/9, old best-effort controls retained |
| task-5-saved-v1-first.tap | --test-name-pattern='explicit human acceptance\|saved actual execution pivot' test/resume.test.js | 1; 7/8, native planning child in legacy pivot lacked workspace fallback |
| task-5-red-v1-migration.tap | --test-name-pattern='v1 migration' test/checkpoint.test.js | 1; 0/1 missing explicit migration |
| task-5-v1-migration-first.tap | --test-name-pattern='v1 migration\|explicit human acceptance\|saved actual execution pivot' test/checkpoint.test.js test/resume.test.js | 0; 9/9 |
| task-5-red-plan-child-budget.tap | --test-name-pattern='public planning child' test/dialogue-recovery.test.js | 1; 0/1, missing required zero prior providerLaunches |
| task-5-plan-child-budget-first.tap | same public planning child | 0; 1/1 |
| task-5-red-preparation-resume.tap | --test-name-pattern='native preparation continuation' test/dialogue-recovery.test.js | 1; 0/1, no public preparation checkpoint |
| task-5-preparation-resume-first.tap | same real retained alternatives/selection/resume | 0; 1/1 |
| task-5-red-native-queue.tap | --test-name-pattern='native queue public' test/dialogue-recovery.test.js | 1; 0/2. Human fixture originally incorrectly expected an unfinished writer-ask cycle to approve without completion; changed to reviewer product question after completed edit/checks. Technical case genuinely lacked queue attachment. |
| task-5-native-queue-first.tap | same real two-Git-unit human/log and technical/return cases | 0; 2/2; exactly two edits, two landings, two judgements; exact14/12 total tokens and7/6 launches respectively; replay unchanged |
| task-5-red-merge-identity.tap | --test-name-pattern='native conflicting-intent' test/dialogue-recovery.test.js | 1; 0/1, substituted excluded merge ledger was not rejected before receipt |

The saved-v1 fixture is explicit test-only construction, not a production fallback: real isolated Git, diffs, reviewer materialization/current tests and evidence are retained; public answers and landing receipts are created through real resume/queue. Both log/return faults are scoped to execution-2 and assert actual injection. Successful operation rows are one per run and two overall; original real commit/call-count/reconciliation assertions remain.

Native preparation uses `version:2`, `preparationSnapshot`, `preparationState`, pinned preparation journal/manifest and `candidateState.selectedCandidateId:null`, never an invented selected dialogue or ordinary planningContext for retained execution. The safe supported continuation is a missing, never-launched selector over complete authenticated candidate artifacts. Completed drafts are reused by the existing candidate-set seam; malformed/uncertain, exhausted or incompletely prepared states refuse reconciliation before accepting a technical receipt. Resource budgets retain exact prior phase spend rather than resetting. The real retained test completes three drafts, then public continuation adds selector/reviewer/remaining execution, nine launches/nine input total, same workspace.

Ruling51's optional campaign item budget is implemented in both producers and actual run dispatch. The actual child test proves min(parent remaining,item cap)40 then75 with total50 and unchanged rounds9; unknown native accounting prevents the next child. The shared-context validated-reference reader producer/consumer tests cover regular path and exact project/run/unit/digest mismatches; context is grounding only, no expanded effect authority.

| Raw receipt | Exact Node scope after `node --test --test-reporter=tap` | Exit/count |
| --- | --- | --- |
| task-5-merge-identity-first.tap | --test-name-pattern='native conflicting-intent' test/dialogue-recovery.test.js | 0; 1/1, substituted ledger rejected before receipt, valid original ledger then reassessed; exact HEAD/MERGE_HEAD/index validated |
| task-5-retention-negatives-first.tap | --test-name-pattern='authenticated prepared external\|visible recall fallback' test/dialogue-recovery.test.js | 0; 2/2, no prepared external replay, original current records and fallback warning survive public answer, one notebook lesson across replay |
| task-5-red-retained-manual.tap | --test-name-pattern='retained planning manual artifact' test/dialogue-recovery.test.js | 1; 0/1, handoff rejected original Task3 whole-artifact manual human authority |
| task-5-retained-manual-first.tap | same retained manual authority case | 0; 1/1, exact original manual-dispute/current human ruling accepted; only remaining execution runs |

## Acceptance property mapping (verified with source timing below)

The eight historical resume controls are not new recovery proof. Native equivalents use current scope/authority semantics, not the old pivot answer keywords as an automatic command language.

| Required property | Genuine native test evidence |
| --- | --- |
| Real edited workspace survives public human answer and landing log/return loss; no duplicate edits/commits/debits | dialogue-recovery: both `native queue public ... after ... loss` cases; independent actual two-unit Git commits and operation rows; saved-v1 eight-case controls remain separate |
| Scoped product/permission text, including `approve` or arbitrary prose, is current reviewer input rather than artifact authority | dialogue-recovery: both `native ... answer is current reviewer input even when its text says approve`; saved mode/scope/limits unchanged, exact parent context, reviewer stop, no edit replay |
| Stop and correction/replan are decided through current native authority, no stale pivot action | dialogue-recovery: `native disputed replan answer is reassessed ...` plus retained scoped/manual planning cases; run.test native ordinary correction/rechecked files and last-cycle/challenge-limit controls |
| Fresh/retained planning and further planning questions preserve edited work and selection/accounting | dialogue-recovery: retained scoped planning public answer and pre-selection technical continuation over three saved drafts; unchanged selected artifact cannot manufacture a new coding allowance; run.test retained last-cycle and native partial-replan controls |
| Ordinary manual artifact/dispute approval remains distinct from scoped user clarification | dialogue-recovery retained manual artifact approval proves original authenticated manual question/human ruling and six cumulative launches; scoped sibling proves reviewer reassessment and seven launches |
| Safe technical continuation, exhausted/unknown effect refusal, corrupt required journal before providers | dialogue-recovery technical reviewer-unavailable, budget, authenticated prepare-only effect, malformed writer, corrupt journal cases; original launch/debit IDs retained |
| Required retention versus optional recall, no repeated memory promotion | artifact-retention required-native failure revokes onward approval and retains source; dialogue-recovery visible recall fallback/one lesson across public replay; saved selected context is authoritative |

Seven previously routed review-loop counterpart properties are mapped to genuine native controls, separately from historical saved-v1 readers: (1) usable current review vs inconclusive is execution-dialogue `execution entry cannot approve an unusable terminal review carrying a valid envelope` and run.test `native ordinary empty malformed output and absent or legacy reviewer never imply approval`; (2) correction is run.test `native ordinary correction starts one new cycle and rechecks actual changed files`; (3) unrelated answer/prose cannot approve is run.test `unrelated executor prose does not label an empty native pause as approval-requested` plus public scoped-answer tests; (4) current diff identity is run.test `native ordinary final code change invalidates the current approval instead of relabelling it`; (5) required/current evidence is execution-dialogue actual command capture/delivery and run.test reviewer check-addition/current recheck tests; (6) same-workspace recovery is the public retained-phase and real queue cases; (7) human delivery/current identity is both public product/permission classes and manual disputed-replan reviewer reassessment. These native command/control tests passed in the frozen full gate; its four failures were exclusively the routed fixture inventory below. Prior Task4 counts are not reused as a new Task5 pass.

## Self-review checkpoint during first affected gate

Source is frozen for `task-5-affected-first.tap`. Read-only review found a narrow remaining support restoration risk: `run.js` rebuilds mutationTestSupport empty on public resume; exact validated completed reviewer support/analysis selection must survive to avoid changed mutation selection and duplicate analysis. A bounded public regression/restoration pass follows this gate before the final full run. Also check exact stored answer-envelope/receipt consistency and iterative unknown-accounting projection. These are Task5 recovery/accounting seams, not new controllers or Task6 rendering work.

## First combined affected gate and scoped self-review fixes

`node --test --test-reporter=tap test/dialogue-recovery.test.js test/checkpoint.test.js test/resume.test.js test/queue-runtime.test.js test/queue.test.js test/queue-cli.test.js test/campaign.test.js test/campaign-file.test.js test/artifact-retention.test.js test/args.test.js test/cli.test.js` returned **exit1,221/223**, zero skipped/cancelled/todo,221844.6986ms. Raw `task-5-affected-first.tap`, SHA256 `6A82B2FA3BA3C2400EB4A350D6E5B020460C339553CE11D176A2DB228FA4F43C`. This is explicitly a pre-fix failed gate.

The two failures were queued saved-planning controls: current approved phaseResult was shadowed by the old pending journal.planResult when deriving exact cleanliness paths; the two-goal injected fault fired prematurely on the first landing because initial landings now have durable operation IDs. Fixed current-result precedence, retaining assertCurrentPlanApproval/sidecar digest and exact checkpoint/lock file checks; no directory waiver. Scoped test fault to `goal-run-2` and asserted it fired, preserving previous-plan/unrelated-source negatives. Targeted `--test-name-pattern='queued saved planning' test/resume.test.js` => `task-5-queued-planning-fixes.tap`, exit0,2/2.

Mutation public regression `--test-name-pattern='public native recovery reuses completed mutation' test/dialogue-recovery.test.js`: `task-5-red-mutation-resume.tap` exit1,0/1 (lost support changed selection and paused; no actual duplicate provider was observed). `task-5-mutation-resume-first.tap` exit1,0/1 after inventory restoration exposed property-order-only JSON-string comparison of persisted input. `run.js` now rebuilds exact support only from saved analysis selection and validated materialized reviewer receipt inventory, verifies current regular contained files/hashes and conflicting duplicates; no scan or policy expansion. `src/execution-dialogue.js`'s existing completed-analysis seam now compares parsed saved input with the actual selection via deep exact-value equality, preserving all unknown/partial operation refusal. Canonical checkpoint key order no longer rejects semantically identical inputs; no input values are relaxed.

Self-review RED `--test-name-pattern='v1 migration|campaign unknown usage' test/checkpoint.test.js test/campaign.test.js` => `task-5-red-selfreview-accounting.tap`, exit1,1/3. Envelope mismatch was genuine RED; iterative case initially failed setup for missing required candidate perspective and is not counted as feature RED. After fixing only that setup, `--test-name-pattern='campaign unknown usage' test/campaign.test.js` => `task-5-red-iterative-unknown.tap`, exit1,1/2: iterative rollup dropped accountingIncomplete. Production now retains the unknown-accounting outcome/flag across rounds (unchanged stop policy), and present original answer envelopes must exactly agree with their receipt identity/artifact/answer array. Historical receipts without an envelope remain valid. Fixture-local core.autocrlf=false suppresses the owned checkpoint fixture's misleading CRLF warning, not a global Git setting.

## Frozen full-suite source inventory

These SHA256 hashes bind the actual source/test tree at start of `task-5-full-first.tap` after the13/13 covering gate. The report itself is excluded from its own hash. Root's plan-only9e856d5 is not an implementation BASE change; review remains53db5fc-to-final.

| Owned changed path | SHA256 |
| --- | --- |
| bin/loop.js | 3D0B084DEC8699DB83960D613583C03F601B5C956249DF4897FBAEC2B1C4905A |
| src/args.js | 56E8EA2D06E1C1B3A8DEA4B26F8BD4BD0176E0C1B5F343B966DF5A001762BC57 |
| src/artifacts.js | EF2FAEB11C50BA2231FC94F86832DD8A2D4F7D8A3CE4999F24BED1BF07F1E7E3 |
| src/campaign-file.js | F514BD006C4337AEBF83F83A183F2329B964D08259AFB674EC2D112BCBC951EA |
| src/campaign-validation.js | 7C84CF5B8D0B5AC745C6C5B84C87B66F0E657910627D82F8E924192F463513CF |
| src/campaign.js | 141270B1E2CC1E1B50FD8458964402AC738768D4E2D7CCBD01CF87F50EBF78DD |
| src/checkpoint.js | E1F10AE97682E0B34159328CE06C98D980EB31C0DC3C770DB3B877EB5790C2FC |
| src/dialogue-dispatch.js | A2A27BE79433E469D6D6BA8E3C58F7A547455CF2D0DDAEA6E09EBBCA3A5EEE7A |
| src/dialogue.js | AF8C6BBB14278646981C9F60AB2E92F301EB40743530973676DF502D7A12A5DD |
| src/execution-dialogue.js | 98E4A19A4E45131A13D742A088EEC17966729536CD86C4102024BFBCD1176083 |
| src/plan.js | 2CD27583E2BFA5697858AC9C6C8551A23F5FB289DC841327D791BE8467C69EE9 |
| src/planning-dialogue.js | 1205834988A021108FE77E359CBFDB14668EF3080AEDA1614BD2C7E4611CFDB6 |
| src/queue-cli.js | 54ACB0DC2CBC789B411F4157D95FD12024B456EF26444103BA4CBCA1BA4341E1 |
| src/queue-runtime.js | F784B953BD4958A790A2C3BD33A466ED5FCD1CC4072D46FAFA1A84B561CB3EE2 |
| src/queue.js | F2256EDD0E57DBE7DD5E7AC35A91C9013EA7A861B361EED0EF2C25D1151F6A7F |
| src/resume.js | 58B0A7766370058332430C6F2C217F4B834D92DD4B4213E43659EB6547AE5590 |
| src/run.js | 1389AF94D0CC4D737A7BD0FBB73B87E43424156395AF3751883177C301E9E4A0 |
| src/shared-context.js | 075EA671FBA6D24D9D662BAAC02448764913A70D58F9C3414B40C100C11C495E |
| test/artifact-retention.test.js | 05CCC0DF920960782372C63824C459A5359740ED9E30B33E86E1139668419CDC |
| test/campaign-file.test.js | 350C4BE5D7F04D26AF0DA4F938342EF1EAD58E762E882010C22E65AB370CB3D8 |
| test/campaign.test.js | FBA53485E3478780095C1F58FE2650AEEDFFDB8C2D6AD0D34DE6C29BFBC518D4 |
| test/checkpoint.test.js | AEFCCCAFBE48012CCD383224DD6A5AC646325702BB641542A16115C312576529 |
| test/queue-runtime.test.js | E3C1E13DEB99BA33817BDEF319DB58415D8237F1692DD745A9742619683FB18E |
| test/queue.test.js | 9BBFC8158B21ADAFD0349CB70BD2DDE2FE5D344892BC31E95CAE23139A48D206 |
| test/resume.test.js | B9B5D376923ED7D1458664E0DEC95D1394F4A7C386D413218DA7DFC21128326D |
| test/dialogue-recovery.test.js | F349395AF9BBE08A81563DA252E94047961A9E32F92CA7AE86D6B1A9744DBC12 |
| test/fixtures/saved-v1-execution.js | E5C1E52FC1FB402BEFAAE0C8C2A3D4116F8EE4BD179DCDEAA931A92670F08443 |

## Completed raw TAP receipt inventory

Hashes below cover each preserved Task5 raw TAP before the final full result. Source timing is the sequential table above; early REDs, setup diagnostics and failed intermediate files remain disclosed, including a filename containing green that still failed. Footer counts are read from each file, not inferred from filenames. Exit status is recorded at the originating tool invocation and summarized above.

| Raw receipt | Pass/tests (fail) | SHA256 |
| --- | --- | --- |
| task-5-affected-first.tap | 221/223 (2) | 6A82B2FA3BA3C2400EB4A350D6E5B020460C339553CE11D176A2DB228FA4F43C |
| task-5-campaign-budget-first.tap | 2/2 (0) | D0F0F426E903129DB8642B283FEA76291925D099CD6F149F7E2933322203D455 |
| task-5-campaign-unknown-first.tap | 2/2 (0) | 7F7D7EC7178003F5ABE51D0E901678A6689AE28D0F21A9A0755F94E33B7F88ED |
| task-5-check-reuse-green.tap | 1/1 (0) | D7DD18F0B7D134EEC931A26AA4657ED0064E0A166BF60D96D07EC0BD4F9933C4 |
| task-5-child-context-first.tap | 1/1 (0) | 2A61383EF7B9F10105316A2816B76711699B009CC18E95097BA303A4C6B8B542 |
| task-5-human-classes-first.tap | 1/2 (1) | D04DEF11B884FA03E51C835FFE9C70EF2E124E6D6F186D529096C2239514B8A2 |
| task-5-merge-human-second.tap | 1/1 (0) | 89820C4099CB8741146ABFFEC14CD5A96397261BBC6E532E8C4A1051B309DC40 |
| task-5-merge-identity-first.tap | 1/1 (0) | 8F050D1DF755EA6EC1C76FBF0EEC75D9FCBF0E2EBA651ADF038A3ECAF46AE276 |
| task-5-mutation-resume-first.tap | 0/1 (1) | 65635B87759B76B2E1AB0D29829DCAC419912A8734C4D45E9B450EEA366CAED2 |
| task-5-native-first.tap | 3/5 (2) | 31E09870180C424566D1A169B9B193103709B078BAA1DA1D8C985B7C2AF38BC6 |
| task-5-native-preflight.tap | 10/10 (0) | BED404829001E3B62A6321175EBB90EE7ED931F4C6298361B956CB3EF8C431EE |
| task-5-native-queue-first.tap | 2/2 (0) | 90BD0CE553FFF9C418D18A025DC99814EB4F0EDC3AFF4DB63AAD050C4711ECC0 |
| task-5-native-second.tap | 5/5 (0) | 0FED5C95BF858D4B5375457DC612DA2609873B70D40734C32978547FB466DB56 |
| task-5-native-technical-first.tap | 7/8 (1) | CD649E48B50C89A286CA9A4CFDFD99DDD02164B031EA5CCCABA5F48ADE26E67F |
| task-5-plan-child-budget-first.tap | 1/1 (0) | 42D98FFE90C81381F9A7655B225BC3B672D2633A3FB62F15670820053E872062 |
| task-5-preparation-resume-first.tap | 1/1 (0) | 6BD6B521F390EEC1111CD1C45693657951DAFDD1200DFFBE42F390000CFFB6EF |
| task-5-queue-budget-first.tap | 2/2 (0) | 8D8705F7EF93F92706384F6DB1BEA305478A594AF393C7A597AD9BD68155323F |
| task-5-queue-context-first.tap | 1/1 (0) | 4012D7AE4D9E04D4ABFE33FA6B2AAEEDFED17F782A0D6743F4C60682C5AE723A |
| task-5-queue-review-usage-first.tap | 4/4 (0) | 7066300BDC62EE8D33D40F4AA1CFDA73FC534330AFD133A1B4A3ECE29B1ED365 |
| task-5-queue-slice-fixes.tap | 5/5 (0) | ECF3929AE206EA1A1066F5ABC7BE6EAC877C9233F1DD910F51FF36C8CD0A7BA0 |
| task-5-queue-slice.tap | 111/116 (5) | EC217519FAC16504ED0ACFB06776F06DB4A8BF24B53F62166E3D85F4EFACAAEC |
| task-5-queued-planning-fixes.tap | 2/2 (0) | 0BED455264CA9076CEF09A14BC7814B2232BBEA0FF8B4296DBC9EB218BE4F541 |
| task-5-red-campaign-budget.tap | 0/2 (2) | 426EDE46622D39B4D43A30B5F72491FFC0AF79BB505B12C3907F4239F375A749 |
| task-5-red-campaign-unknown.tap | 0/1 (1) | E64637EA9F400AE880E41F438FE79DB06A6B5AA0586F0A8026AFB73AE45423D8 |
| task-5-red-check-reuse.tap | 0/1 (1) | 6DE3A6E636CB5FEBFFE7CDC33DDBF4340ACBF0B1838398BFA821DE422274A0D8 |
| task-5-red-child-context.tap | 0/1 (1) | 3A0BEA60F94012FF4E4FACACC719EEC3BBDE790454E1DD8A53651D9EC7E95C71 |
| task-5-red-human-classes.tap | 0/2 (2) | FCDAA4535E3691BFED16670F2D7828C4EE09996659D0A663EA32D07B5248BD59 |
| task-5-red-iterative-unknown.tap | 1/2 (1) | 28AFCD99F681319C0EAA738441CF4DDBC5A410CE989ADEFE628AC190FD7F2215 |
| task-5-red-merge-identity.tap | 0/1 (1) | A5A4A34AFDBCEC40C28B5419EF895C64E385226B6A50F75F188F04C1D0995924 |
| task-5-red-mutation-resume.tap | 0/1 (1) | A1E0196B408C85E95FDFD531EC5ACD1FD6FE1485E3774448901F3E3681D9C391 |
| task-5-red-native-queue.tap | 0/2 (2) | DEEFA8C1F74AAB92CF6685999679560E44FAA8334329A7AFEC31001CC4A92798 |
| task-5-red-native.tap | 0/5 (5) | 96DBD3D2D5C56B37608D078F38A6B228E49335100B82711587613B7DD7AD3ED9 |
| task-5-red-plan-child-budget.tap | 0/1 (1) | 1A34B7A0FFFE69FD657FBD4450ECA570AB9EDDD23A4CA293FEB3FB7FB65786C7 |
| task-5-red-preflight.tap | 0/2 (2) | F80D04C56628F956DBF9B96077785781A57E64CB721D5D29D1D9F346516D4A43 |
| task-5-red-preparation-resume.tap | 0/1 (1) | 0F3BA042B8FE6486074392ECDCEC608162CCC841DFF727D39602D3DC03CBAF02 |
| task-5-red-queue-budget.tap | 0/2 (2) | 9368AE1F5FD7FE528CCEB21899E383C20D848893AF049552A13E1A28155D29A9 |
| task-5-red-queue-context.tap | 0/1 (1) | 7747EE4CA41E67BC808FBB92B366253CF57F6179D327791A6FF7B22335641371 |
| task-5-red-queue-review-usage.tap | 0/3 (3) | 9ADB21CE893F47B94B88F7044DCDE341B6DCAE77C4E52A337D12EE5D6E0B2FDC |
| task-5-red-recovery.tap | 41/54 (13) | E6A5FA8C444C9A46B42F4644E119B9214C1A5E54141A84DCA4E900A3D9E85222 |
| task-5-red-required-retention.tap | 0/1 (1) | 9EA7577E84EB7EAE80160FCBD5A32B809996D9D334650611D41649DBEC7967EB |
| task-5-red-retained-archive.tap | 0/1 (1) | 713969F3C380DCACB47B3790EAC06F9ED4A40C9A08370262A61EE440A08F020D |
| task-5-red-retained-manual.tap | 0/1 (1) | 9893A74A4D0AA363796FF67D61B10FAE646B1E1DE59ACCB7A4E2F2035F8FBD20 |
| task-5-red-retained-planning.tap | 0/1 (1) | 39834DDC523A863D590005D9DABCCA8E1DDFA11DADFDD46D3A121389D41073C5 |
| task-5-red-selfreview-accounting.tap | 1/3 (2) | 279B2A8A27A0B87F40E1DC3E1B01B0282E29831C9EB5811E4B6F3496E0775794 |
| task-5-red-technical.tap | 3/5 (2) | F739D2FFAB57313CDA4BDDCBB448C96965E40A669EC1F0193039C8D80E8E6600 |
| task-5-red-v1-migration.tap | 0/1 (1) | 216C02D427ADD4463B5600CC7C0BB6DA3040035E0E5C640E5A853206343B4ED7 |
| task-5-required-retention-first.tap | 9/9 (0) | 45AD9D9517B0F2F7FE2221C3EEE943B25A5384DAB52B1BB31296275A58E39E95 |
| task-5-retained-archive-green.tap | 0/1 (1) | 9423B35E6DF2F99E7E695C0AD3D08DA4C2B4CE68D41D8B3BC1763EAD9C361FE6 |
| task-5-retained-archive-second.tap | 1/1 (0) | 608CECCF04856D0113FC26D6FA5B463C7CA92687CDB4813D18DF7D16FB626F28 |
| task-5-retained-manual-first.tap | 1/1 (0) | 869E8EB5D8047DC378266673885D4841A56311C386282279F6222A889D232114 |
| task-5-retained-planning-first.tap | 0/1 (1) | 243997A1FC8FFF5A4DA8D860B18D9A62479FBACB84F3858B4DF9CE6426E6C87F |
| task-5-retained-planning-second.tap | 1/1 (0) | 38AAEF307D095C38F05FBEE63ABED5BDAF4F90FC7C352551630D4ADF5FD0A9BF |
| task-5-retention-negatives-first.tap | 2/2 (0) | 7DEBFC16B8004AB194D85EB7370B85F5A9A7C2DC60958DA707FD505712109DCD |
| task-5-saved-v1-first.tap | 7/8 (1) | DC15915DD25553237398F554F009A804CDC5423FD8BA14436398B470E6732B1D |
| task-5-selfreview-covering.tap | 13/13 (0) | FCE8EC8B42E51D9DEF9B68A03939546F4C324F54511BC5233DD2EF6FEB64D291 |
| task-5-technical-planning.tap | 4/4 (0) | EA5FA228D71B1C7828419F8D252C78C884AFAA9C99E1F6FC57CFA608A284C426 |
| task-5-v1-migration-first.tap | 9/9 (0) | 8E177A5553CFA6F4BB9D6D3251EF0CDF8E88CE5862421FE7A7154D4A3337AC9E |

## Final full result and Ruling53 fixture-only delta

`node --test --test-reporter=tap` returned **exit1,1494/1498**, four failures, zero skipped/cancelled/todo,1038989.079ms. TAP has1466 top-level tests plus32 nested tests. Raw `task-5-full-first.tap`, SHA256 `B6BD932A76FD091EFFF5115CADC0B53DFF6F50FD10850B802521FB3726BBAD93`. It is a failed full gate, not a passing result. Its complete failure inventory is only events.test.js:624 (missing merge/start+finish), merge.test.js:443 and500 (fake parent accounting prevented fan-in), run-artifacts.test.js:184 (whole native archive incorrectly labelled optional).

Under parent-confirmed Ruling53, only fixture corrections follow: events' fully synthetic success facts now explicitly default input/output to zero while preserving its provided nonzero override and event vocabulary ratchet; merge's fully synthetic successFacts now has explicit zero usage with unchanged fan-in/cascade assertions; blocked native archive asserts paused/unapproved/nonzero, actual source journal and blocked destination preserved, no successful durable context copy. Genuine legacy best-effort archive API controls remain unchanged. Root additionally routed the already-owned checkpoint linked topology's remaining CRLF warning: local core.autocrlf=false is set before add in that disposable Git repo only.

Targeted command `node --test --test-reporter=tap --test-name-pattern='observed native runs and explicit schema|fan-in waits|fan-in merge holds|run pauses when required native archive' test/events.test.js test/merge.test.js test/run-artifacts.test.js` => `task-5-full-fixtures-focused.tap`, exit0,4/4,36277.0054ms. The complete events/merge/run-artifacts/checkpoint affected command is recorded below after completion. No production source changed after the full gate. Per Ruling53, **no whole-suite rerun on these fixture-only changes**; Task6 owns the final whole-suite acceptance. Scoped green results cannot rewrite the failed historical full receipt.

Final fixture hashes supersede/add to the frozen-full inventory only for these four paths:

| Owned fixture path | Final SHA256 |
| --- | --- |
| test/events.test.js | 5AE61CC100A7AF597DE92B9C426ABD5767B2434DB89A72FDA225AB8248E9EFC0 |
| test/merge.test.js | F96AEC08CE33FE5BD35FB5523B0BA5CE97E0D8E1610C1864C5DC82F4E87ECFCA |
| test/run-artifacts.test.js | 21DA60C86B372FCA6AED593CFC2A4E488B2C34BA8AAE5840BA3811B28C5F95ED |
| test/checkpoint.test.js | 0EE2CEF26081A1CA1F61286FFD427CB83138044A4B66234DD57F62C17041648B |

## Final verification and self-review handoff

The post-production-fix covering command was `node --test --test-reporter=tap --test-name-pattern='public native recovery reuses completed mutation|native completed mutation|native recovered uncertain|native mutation materialized|campaign unknown usage|v1 migration' test/dialogue-recovery.test.js test/execution-dialogue.test.js test/run.test.js test/campaign.test.js test/checkpoint.test.js`: exit 0, 13/13, zero skipped/cancelled/todo, 38041.3757 ms (`task-5-selfreview-covering.tap`, hash in inventory). This includes the genuine public completed-mutation/support regression, current support/completed-analysis and uncertainty controls, original answer envelope validation, and both direct/iterative unknown accounting. It preceded the frozen full source run.

The final fixture command was `node --test --test-reporter=tap test/events.test.js test/merge.test.js test/run-artifacts.test.js test/checkpoint.test.js`: **exit 0, 47/47**, zero skipped/cancelled/todo, 114178.1236 ms. This covers the full three Ruling53 files and amended linked checkpoint topology, not only the four prior failing names.

| Final raw receipt | Pass/tests | SHA256 |
| --- | --- | --- |
| task-5-full-fixtures-focused.tap | 4/4 | 5481574CB45166C11FBAD94EB57F6084CD80B5FFC33C50959BED6FC0F86469FA |
| task-5-full-fixtures-affected.tap | 47/47 | B1E1D89C21807F399266A8144F183BA032FA7E52AD8B2F3C588CC68A2B05D9EE |

Final read-only hash comparison checked all 30 owned source/test files: no mismatches against the frozen-full inventory plus the four explicit final fixture hashes. Thus all 18 production files and the other tests are byte-identical to the frozen full run. The changed-path inventory is exactly those 30 paths plus this report; no prepared map, Task6 document, raw evidence or root-owned plan is staged with the implementation.

`git diff --check` passed, and the index was empty before exact-owned staging. Self-review checked checkpoint/answer/technical routing, authenticated phase/workspace/context identities, current mutation support and completed-operation reuse, cumulative queue/campaign accounts, required native archive behavior and all final fixture deltas. The defects found during that review and their true RED/covering results are recorded above, rather than hidden by a later green scope. No unresolved implementation dependency was identified; independent review remains with root.

The provider-denial log was absent after the last gate (no denied live-provider launch was recorded). The frozen full raw output retains one actual `source.js` LF-to-CRLF warning at line 704; the final affected raw output has no `warning:`, `LF will`, or `CRLF` matches after the two disposable-only checkpoint Git settings. No global Git configuration was changed. No source/evidence cleanup, push, merge, release, install, authentication, live inference or operational/main/PR5 mutation was performed.

Remaining verification limitation: the full historical result is still a failed 1494/1498 receipt, not a green final tree. Only the approved fixture-only deltas followed it and their complete affected gate is green; Ruling53 assigns the next whole-suite gate to Task6. This local commit is ready for root's original-BASE independent review, not publication or final Task6 acceptance.
