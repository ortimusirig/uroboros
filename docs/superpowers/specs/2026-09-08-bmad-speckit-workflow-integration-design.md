# BMAD and Spec Kit workflow integration

Date: 2026-09-08. Status: written specification approved by the user's subsequent “go ahead”; implementation planning and local execution authorized. Runtime integration is not yet complete.

## Intent and scope

The user approved actual bundled integration and asked to strengthen Uroboros with BMAD and strengthen development with Spec Kit. The completed task-sizing guide at `02cf6c2` is documentation, not this integration. This design makes selected, attributable upstream workflow material an enforced input to real runs.

BMAD supplies outcome-based decomposition, useful epic/story boundaries, dependency reasoning and evidence-led replanning. Spec Kit supplies the development discipline connecting requirements, acceptance criteria, implementation work and verification. Uroboros remains the only controller: Claude plans and Codex reviews; Codex implements and Claude reviews. Autonomous final authority remains the phase reviewer; humans settle unresolved manual disputes and supply missing intent or permission.

This is an adaptation of selected upstream workflows, not installation of either complete toolkit or a claim of stock-tool compatibility. No upstream agent personas, separate task database, Python/uv requirement, extension hooks or second execution controller are introduced. Existing project → goals → task units and executable/plugin paths remain stable. No new runtime dependency is required.

## Meaning of enforcement

For new native runs, loading the appropriate pinned workflow material, delivering it through shared context and preserving its identity are mandatory. A missing, malformed or digest-mismatched required profile fails before the affected provider/effect is launched; it never quietly degrades to documentation-only guidance.

The harness enforces delivery, identity, current evidence, authority and existing integrity/check prerequisites. The models judge decomposition quality, requirement coverage, necessary tests, progress, drift and readiness. There is no automatic quality score, numerical task-size threshold, fixed task count, compulsory extra conversation round or additional final-review call. A checkbox or statement that a method was followed is not evidence of correctness. Important unanswered concerns use the existing issue/disposition protocol.

Both agents may inspect additional authorized project context. Upstream workflow guidance cannot override the user's requirements, project constraints, permissions, reviewer authority or evidence rules. It does not make the EULR Standing Instructions automatically required context or change that audit's unresolved policy distinctions.

## Bundled profiles and ownership

Add a focused loader at `src/workflow-profiles.js` and bundled text/metadata/notices under `src/workflow-profiles/`, an existing installer payload root. Each profile records its identifier, adapter revision, upstream repository and full commit, exact source paths and hashes, adapted phase sections and their hashes, and license/attribution references. A combined content digest identifies the selection used by a run.

Initial upstream baselines are BMAD commit `abe4eb1bce919c9d22cd18b3519353d5824c4b75` and Spec Kit commit `0c8e31ff0a98c362696c2edb6a1bb25a37f68544`, already researched. Bundle the selected original workflow sources as attributable reference material and separately identify the adapted runtime sections. Runtime loads the adapted sections, not arbitrary instructions or hooks from original sources. Updates require a reviewed adapter/bundle change; there is no download or automatic update during a run.

Preserve both projects' MIT copyright/license notices. Preserve BMAD's trademark notice and link its guidelines; do not imply official endorsement or rename Uroboros as a BMAD product. Uroboros retains its existing license. Validate required assets and notices through installer/package checks; do not assume a successful repository run proves a plugin distribution contains them.

The loader selects only shipped, supported profiles. Caller-supplied context cannot replace reserved workflow identities or supply arbitrary file paths, executable hooks or profile implementations. This uses the same trusted-installed-code boundary as the rest of Uroboros, not a claim of protection against an attacker who can replace the entire installed application.

## Phase behavior

| Phase | BMAD contribution | Spec Kit contribution | Existing authority |
| --- | --- | --- | --- |
| Project/goal decomposition | Usable outcomes, split/consolidate rationale, dependencies, risk and feedback boundaries | Testable acceptance, requirement coverage, independent verification | Claude authors; Codex reviews |
| Ordinary planning and candidate preparation | Challenge scope and unnecessary decomposition | Link requirements, design constraints, planned changes and evidence | Existing planning seats and selection rules |
| Implementation and execution review | Keep the approved scope and expose discoveries that change it | Work from the current approved plan; respect dependencies/contracts; connect changed behavior to tests and actual results | Codex implements; Claude reviews |
| Retained-work replan | Explain new evidence, affected assumptions and the remaining-work change | Reconcile acceptance/coverage without rewriting completed history | Claude replans; Codex reviews; then execution resumes |
| Aggregate goal acceptance | Judge whether the complete capability exists | Check end-to-end requirement coverage and retained evidence | Existing goal-acceptance reviewer |

Spec Kit's development contribution includes using project-native test patterns, proving relevant behavior and failure paths, reporting tests that did not run, and comparing actual implementation with approved requirements. Reviewers challenge unsupported completion claims through the ordinary conversation. New implementation tests follow the project's applicable TDD rules; test depth remains risk-sensitive, with existing required checks preserved.

Do not import Spec Kit's blanket infrastructure-first task phase, optional-test default, finding-count cap, checkbox-only completion, global ignore-file edits or automatic pre/post extension hooks. Do not import BMAD's interactive menus, additional approval seats or mandatory hierarchy. Record these adaptations alongside the bundled sources so the integration is inspectable rather than a claim that upstream runs unchanged.

## Runtime delivery and lifecycle

1. At a new native logical run's entry, resolve and validate the bundled profiles once. Save their identity, full adapted sections and applicability in a harness-owned workflow binding carried by required shared-context entries. Preserve source metadata separately from project factual evidence; a method is guidance, not proof about the user's code.
2. Planning, preparation/selection and execution inputs consume that binding through the existing common snapshot renderer. Both seats in a phase receive the same applicable guidance; role-specific action instructions remain separate. The provider operation's saved input and snapshot digest bind the actual delivered material.
3. A queue, batch or campaign controller pins the selection for its logical run and propagates it to related children. Carry it through per-unit context, planning handoff, direct task children and later units. A child cannot silently resolve a different installed profile version; a parentless standalone run selects the current shipped default. Existing public queue JSON and task/gate filenames do not change; internal controller state carries the binding.
4. Retained replanning and its execution successor inherit the parent's binding and captured sections. The method does not change when a new phase or candidate is created. Completed work, receipts, questions and dissent remain intact.
5. Saved resume uses the captured binding and validated content, not the currently installed default. A software upgrade may supply a newer default for a new run but must not alter the method of a resumed run. Invalid or missing required captured content pauses safely; it cannot be repaired by silently loading the new bundle or relaunching an uncertain effect.
6. Historical v1 and pre-integration native records remain readable/resumable with their original context and existing safeguards. An authenticated historical run without a workflow binding is reported as legacy/unbound, never falsely certified as integrated. Its continuation lineage remains unbound. Removing a binding from a new bound run is corruption, not eligibility for this compatibility path. No in-place methodology migration of an approved run is introduced.

Native entry-point coverage includes `plan`, both `decompose` tiers, explicit candidate preparation, direct `run --task`, queue goal/task children, batch/campaign children using those paths, execution review, retained replan, final goal acceptance and public resume. Direct execution of a supplied task does not gain a compulsory planning detour: Spec Kit development guidance applies to that execution; significant scope uncertainty uses existing clarification/replan routes.

Calling-session chunk preparation is not itself a controlled native run. The shipped instructions must accurately direct its output through reviewed planning/queue entry points and make the relevant bundled guidance discoverable. Do not claim that an arbitrary user's freehand draft or an external agent session has been harness-enforced. Any changed skill instructions require genuine application checks.

## Existing implementation seams

At baseline `02cf6c2`, `openPlanningContext` in `src/planning-dialogue.js:202` creates the required shared snapshot used by both native planning and execution (`src/execution-dialogue.js:28`). `src/dialogue-dispatch.js:403` renders that common snapshot into seat inputs. Native execution passes `request.input` to Codex and Claude at `src/run.js:1233` and `src/run.js:1252`; the older helper at line857 is not the native input contract.

`src/plan.js:489` creates a separate multi-candidate preparation session; its `callPlanningPreparation` path also needs the binding. `src/queue.js:494` creates queue context separately, and its approved planning-to-execution reference is another boundary. `src/run.js` retains parent phase/context for replanning, while `src/resume.js` routes saved phase continuations. Reuse those seams rather than adding another orchestrator or duplicating context renderers. Installer payload roots are declared in `install.mjs:28`.

## Observable result and acceptance

Reports expose the selected BMAD/Spec Kit revisions, applicable phase sections and whether the run is bound or historical/unbound. Use the existing curated reporting surfaces and immutable context references; do not expose opaque model fields or claim that delivery proves comprehension. The original required-check and same-unit projection limitations are not silently redefined by this feature.

Acceptance must demonstrate:

1. Fresh planning and both decomposition tiers deliver the required versioned sections to actual inputs of both seats.
2. Single- and multi-candidate preparation/selection retain the same binding and existing usage accounting.
3. A direct task run reaches both Codex implementation and Claude review with Spec Kit development sections, without calling decomposition first.
4. Queue goal/task children, batch/campaign children and subsequent units retain their parent's pinned binding, including a child process started with a newer installed default.
5. Questions, corrections and final-review conversation keep the method and evidence links without mandatory additional calls.
6. Execution-triggered replan and subsequent execution preserve completed work and the binding across both phase transitions.
7. Public planning, decomposition and execution resume preserve captured old-version guidance after an installed bundle upgrade.
8. Missing/altered required profile content or conflicting caller overrides refuse the affected operation before launch; historical absence cannot excuse corruption of a bound run.
9. Historical v1/pre-integration native continuation keeps its original behavior and is visibly unbound; unknown usage and uncertain effects retain their existing refusal rules.
10. Source claims in development/review still require actual evidence; checked task lists and upstream instructions cannot produce verified facts or approval by themselves.
11. No new hierarchy, mandatory turn, numeric sizing gate, provider default, permission, dependency or external service is introduced.
12. Installer validation and package inspection contain every required profile/source/notice; a disposable packaged CLI can load profiles with no network or provider calls.
13. Documentation and reports distinguish adapted integration, historical runs, observed delivery and demonstrated behavior accurately.

Automated tests use fake providers/isolated fixtures to verify public transport, lifecycle and integrity boundaries, not tests that merely search source text or return canned success after recognizing a prompt. Fresh-agent application probes cover oversized tasks, artificial layer splits, missing acceptance/error paths, contradictory evidence and retained-work replanning. They provide qualitative evidence of use, not a guaranteed improvement rate or proof of every agent's future judgment. Follow writing-skills testing when changing skill guidance. Preserve exact commands, numeric exits and retained outputs; the previous1552 passing tests are historical evidence, not this feature's test result.

## Delivery boundary and remaining approval

Implement on the existing preserved feature worktree after written specification review and implementation planning. Verify affected behavior and the final source proportionately; review the integration before merging. No installation into the user's active environment, authentication/global configuration change, live-provider smoke, merge, push or release is performed merely by approving this local integration design. Existing release-file allowlist work remains a before-release obligation; this feature must nevertheless prove its own packaged assets are present. Preserve all project/SDD objects in the user's persistent Uroboros folder.

## Primary references

- [BMAD epic design](https://github.com/bmad-code-org/BMAD-METHOD/blob/abe4eb1bce919c9d22cd18b3519353d5824c4b75/skills/bmad-create-epics-and-stories/steps/step-02-design-epics.md) and [correct-course workflow](https://github.com/bmad-code-org/BMAD-METHOD/blob/abe4eb1bce919c9d22cd18b3519353d5824c4b75/skills/bmad-correct-course/SKILL.md).
- [Spec Kit task template](https://github.com/github/spec-kit/blob/0c8e31ff0a98c362696c2edb6a1bb25a37f68544/templates/tasks-template.md), [implementation workflow](https://github.com/github/spec-kit/blob/0c8e31ff0a98c362696c2edb6a1bb25a37f68544/templates/commands/implement.md), [analysis](https://github.com/github/spec-kit/blob/0c8e31ff0a98c362696c2edb6a1bb25a37f68544/templates/commands/analyze.md) and [convergence](https://github.com/github/spec-kit/blob/0c8e31ff0a98c362696c2edb6a1bb25a37f68544/templates/commands/converge.md).
- [BMAD license](https://github.com/bmad-code-org/BMAD-METHOD/blob/abe4eb1bce919c9d22cd18b3519353d5824c4b75/LICENSE), [Spec Kit license](https://github.com/github/spec-kit/blob/0c8e31ff0a98c362696c2edb6a1bb25a37f68544/LICENSE), and [BMAD trademark guidelines](https://github.com/bmad-code-org/BMAD-METHOD/blob/abe4eb1bce919c9d22cd18b3519353d5824c4b75/TRADEMARK.md).

The references are upstream source material, not instructions to execute their installers or hooks. The integration architecture and adaptation choices above are Uroboros-specific proposals.
