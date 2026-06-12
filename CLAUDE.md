# rig -- Project Instructions

## Overview

Agent middleware for Claude Code. TypeScript, vitest, commander CLI.

## Commands

```bash
npm test           # Run all tests (vitest run)
npm run test:watch  # Watch mode
npm run build      # Compile TypeScript to dist/
npm run lint       # Type-check (tsc --noEmit)
```

## Architecture

Four-layer middleware:

1. **Tool Router** (`src/router/`) -- PreToolUse hook: intent classification, priority resolution (rtk > jcodemunch > claudeTool > fallback > allow), test-scope and branch-discipline checks
2. **Enforcement** (`src/enforcement/`) -- PostToolUse hook, composable pipeline: stale tests -> constitutional -> zero-defect
3. **Skill Chain** (`src/skills/`) -- Phase tracker validates transitions (brain+ -> plan+ -> tdd+|sdd+ -> verify+ -> review+; debug+ standalone)
4. **Scout** (`src/scout/`) -- Cross-repo indexing, CodebaseMap formatter, TTL cache

Supporting: `src/config.ts` (YAML config), `src/session/` (environment detection, session cache), `src/cli/` (init command, template renderer)

## Key Types

All types in `src/types.ts`. Important ones:

- `IntentType` -- file_read, text_search, file_discovery, file_modify, symbol_search, scout_explore, pass_through, native_read, native_grep, native_glob, rtk_cat_code
- `EnforcementLevel` -- block, advise, silent
- `EnforcementViolation` -- { level, message }; severity is structural, never sniffed from message text
- `Resolution` -- allow, advise, block
- `ToolRule` -- match pattern + resolutions per environment priority
- `WorkflowRules` -- branch_discipline, protected_branches, isolation_strategy
- `CodebaseMap` -- structure, entryPoints, keyExports, dependencies, languages, symbols
- `HarnessConfig` -- nested rules with enforcement levels

## Conventions

- Config via `.harness.yaml` (YAML, layered merge with base + local)
- Environment detection uses injectable `ExecFn` for testability
- Session cache: 4-hour env TTL, file-backed in /tmp keyed by (cwd, session id); scout cache has a separate 30-min TTL
- All hooks read JSON from stdin, write JSON to stdout (Claude Code hook protocol)
- Skill templates use `{{VAR}}` substitution via `renderTemplate()`
- Enforcement levels: block (exit 2), advise (agent-visible additionalContext + exit 0), silent (log + exit 0)

## Testing

- 1100+ tests in `tests/` mirroring `src/` structure
- Vitest with v8 coverage provider
- Coverage gate: 80% statements/functions/lines, 75% branches
- No mocks for environment detection -- use injectable `ExecFn`

## Docs

- @README.md -- Project overview and quick start
- @docs/architecture.md -- Full system design
- @docs/getting-started.md -- Installation and usage guide
- @docs/extending.md -- Custom enforcement checks, skills, and agents
- @docs/skill-wrapping.md -- Wrapping superpowers skills with project-specific enforcement
- @docs/agent-loops.md -- Loop-centric development: signal stack, opt-in trajectory, maintainer pattern
- @docs/troubleshooting.md -- Diagnosing permission prompts, cache, and detection issues
- @docs/design-process.md -- How rig was built (historical reference)
