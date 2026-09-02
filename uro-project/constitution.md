# Constitution — uroboros repository

Standing rules for any change to this repository. The operator wrote these; no seat may weaken them.

1. Zero runtime dependencies. Node built-ins and `node:test` only.
2. No determinism anywhere a decision is made. Decisions are judged by seats; evidence stays deterministic.
3. No hidden caps. Any bound a change introduces must be self-declared in its output AND recorded in the determinism-and-caps audit table in `docs/superpowers/specs/2026-09-01-decomposition-spine-design.md`, or it does not ship.
4. Malformed artifacts feed back verbatim for repair; refusal is reserved for a seat that never ran.
5. Silence is never consent. Unreadable evidence never lands.
6. The existing suite stays green: `node --test` from the repository root, currently 878 passing, 0 failing.
7. Windows first: paths, spawns, and prompts must work under win32, including the cmd.exe 8191-character argv limit.
8. Commits follow the repository style: imperative subject with a conventional prefix, body explaining why.
