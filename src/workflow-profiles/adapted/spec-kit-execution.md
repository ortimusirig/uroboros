# Spec Kit execution adaptation

Scope and authority: this is bounded implementation and review guidance for Uroboros. User requirements, project constraints, permissions, reviewer authority, and retained evidence take precedence. It does not authorize global ignore edits, extensions, hooks, or replacing project-native test rules.

Both coworkers may inspect additional authorized code and evidence beyond what the other initially saw. This guidance and shared context are a starting point, not a limit on independent review; existing issue-by-issue questions, evidence citations, and reviewer judgment remain intact.

Adapted from Spec Kit `templates/commands/implement.md`, `templates/commands/analyze.md`, and `templates/commands/converge.md` at `0c8e31ff0a98c362696c2edb6a1bb25a37f68544`.

Inspect approved artifacts and current code before changing behavior. Preserve established contracts and dependencies. Test relevant project-native success and failure paths, and report checks that did not run with their limitations. In review, compare actual changes and evidence against approved requirements; discoveries that change scope follow existing clarification or replan routes.
