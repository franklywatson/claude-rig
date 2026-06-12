# Design Process

How rig was built, and the philosophy behind it. Moved here from the README;
this is historical reference, not usage documentation.

## Seven phases against a reference implementation

Rig was built in seven iterative phases, each evaluated against
[gstack](https://github.com/garrytan/gstack) — a mature agent skill framework
used as a reference implementation. The approach was to study gstack's patterns,
identify patterns worth adopting and avoiding, then build rig with deliberate
advantages at each layer. The full phase plans and retrospectives are preserved
in [commit a9ee32f](https://github.com/franklywatson/claude-rig/tree/a9ee32f9b8e78f138aafeb0dd1e13af272c8706e/docs).

| Phase | Layer | Key decision vs gstack |
| ----- | ----- | ---------------------- |
| 1 | Foundation | Adopted gstack's injectable env detection; chose hooks over preamble text for enforcement |
| 2 | Tool Router | Enforceable PreToolUse hooks vs gstack's persuasive preamble routing |
| 3 | Enforcement | Composable programmatic pipeline vs gstack's monolithic text-based approach |
| 4 | Scout Agent | Typed `CodebaseMap` vs gstack's unstructured preamble context injection |
| 5 | Skill Chain | Programmatic state machine wrapping superpowers vs gstack's standalone skill tiers |
| 6 | CLI Installer | `npx`-first with `/verify-harness` vs gstack's global install, no verification |
| 7 | CI Guardrails | CI-enforced coverage gates and docs lint vs gstack's in-session-only enforcement |

A later cycle (v0.5.0) added typed subagent dispatch and the loop-aware skill
chain — see the spec and plan under `docs/superpowers/` for that design's
decision log.

## Philosophy

Every project has different requirements for rigor and oversight. A solo
prototype needs lighter guardrails than a production system handling financial
transactions. Some domains demand determinism — non-negotiable rules that can't
be talked around. Rig lets builders codify their project's non-negotiables as
enforceable hooks, then rest easy knowing Claude will follow them.

[superpowers](https://github.com/obra/superpowers) and
[gstack](https://github.com/garrytan/gstack) are excellent tools in their own
right. Rig doesn't replace them — it complements them by adding a layer of
programmatic enforcement that preamble-based approaches can't provide.

## Related

- [architecture.md](architecture.md) — the resulting system design
- [agent-loops.md](agent-loops.md) — the loop-centric operating model added in v0.5.0
