# rig

![Tests](https://github.com/franklywatson/claude-rig/actions/workflows/test.yml/badge.svg)
![Coverage Gate](https://github.com/franklywatson/claude-rig/actions/workflows/coverage.yml/badge.svg)
![Docs Quality](https://github.com/franklywatson/claude-rig/actions/workflows/docs.yml/badge.svg)

A cockpit for your [Claude Code](https://claude.ai/code) tooling stack.
[rtk](https://github.com/rtk-ai/rtk),
[jcodemunch](https://github.com/jgravelle/jcodemunch-mcp),
[graphify](https://github.com/safishamsi/graphify),
[Headroom](https://github.com/chopratejas/headroom), and
[superpowers](https://github.com/obra/superpowers) are each excellent
instruments on their own — rig is the panel that wires whichever of them you
have installed into one place, with plug-and-play detection, programmatic
routing, and a single pane of visibility.

## The cockpit

Each tool in the stack answers one question well: rtk (cheap shell output),
jcodemunch (what exists in the code), graphify (how it connects), Headroom
(context compression), superpowers (process discipline). Run them separately
and you carry the integration burden — remembering which is installed, which
to reach for, and what each is saving you. Rig carries it instead:

- **Plug-and-play detection** — session start probes the whole panel (PATH,
  MCP registrations, proxy markers, the experimental agent-teams flag),
  auto-indexes the project, auto-builds the knowledge graph, and reports what's
  online. Install a tool and it joins the panel; remove one and rig degrades
  gracefully (jcodemunch-only analysis when graphify fails, pass-through when
  rtk is absent, general-purpose subagents when typed agents are deleted,
  sequential dispatch when agent-teams is off).
- **Routing, not memory** — PreToolUse hooks steer every operation to the best
  instrument available right now. You never have to remember the stack exists.
- **One pane of glass** — `/savings` reports every layer side by side (tool
  layer, context layer, graph stats) without double-counting;
  `/verify-harness` is a 38-point preflight check; session start prints the
  panel status every time you sit down.

## What it does

Rig installs the cockpit into a Claude Code project:

- **Tool Router** -- intercepts shell commands via PreToolUse hooks, transparently rewrites
  `grep`/`find`/`cat`/`git` to rtk when available (via `updatedInput` paired with `permissionDecision: "allow"`,
  default permission mode only — `bypassPermissions` ignores the rewrite);
  advises on native Read/Grep/Glob when jcodemunch is indexed;
  diverts high-value Bash reads/searches (big-file `cat`, identifier `grep`) to jcodemunch instead of rtk
  (`tool_routing.jcodemunch_divert`); blocks `sed -i` and rtk code-reading (`rtk read`/`rtk smart`) on code files
- **Enforcement Pipeline** -- PostToolUse hooks check stale tests, constitutional rules (real dependencies in stack/E2E tests),
  and zero-defect status (with pre-existing failure classification); a PreToolUse test-scope check redirects full-suite runs
  to scoped tests during `tdd+`/`sdd+`, and configurable branch/PR discipline with worktree-aware isolation advice guards
  commits on protected branches. Advisories reach the agent as `additionalContext`; blocks exit 2
- **Skill Chain** -- ordered workflow skills: `brain+` -> `plan+` -> `tdd+` -> `verify+` -> `review+`, plus standalone `investigate` and `savings`,
  and `sdd+` for subagent-driven plan execution via typed agents (`code-reviewer`, `spec-reviewer`, `implementer`) installed into `.claude/agents/`
- **Scout Agent** -- cross-repo indexing agent that builds a typed `CodebaseMap`
  for context injection, enriched with graphify relationship data (god nodes,
  module communities, dependency paths) when available

Built from the [agentic-patterns](https://github.com/franklywatson/agentic-patterns) L2-L4 patterns.

## Rig vs plain superpowers

[superpowers](https://github.com/obra/superpowers) provides the process
discipline: brainstorming, planning, TDD, verification, review. Rig keeps all
of it — every chain skill delegates to its superpowers counterpart — and
upgrades the three places where process text alone can't reach:

| | plain superpowers | superpowers through rig |
| --- | --- | --- |
| **Enforcement** | Persuasive skill text the agent can rationalize around | PreToolUse/PostToolUse hooks that programmatically block or advise (`.harness.yaml`) |
| **Subagents** | Every implementer and reviewer dispatched as a general-purpose agent; role and discipline ride inside the prompt | Typed agents in `.claude/agents/`: tool-scoped (reviewers carry no Edit/Write tools), enforcement rules in their system prompt, named in the UI, backstop-calibrated turn budgets with partial-status resumption, worktree-isolated implementers, and team-mode execution of independent plan tasks as parallel teammates when Claude Code's experimental agent-teams feature is detected (see [architecture.md "Subagent operations"](docs/architecture.md#subagent-operations)) |
| **Trajectory** | The skill chain ends at merge | Opt-in agent-loop trajectory: `brain+`/`plan+` can design a layered signal stack so the system self-assembles gate-by-gate and hands off to an always-on maintainer agent |

The result: the same superpowers workflows, but the review chain is
structural instead of persuasive, and projects that fit can graduate from
"built and merged" to "self-assembling and self-maintaining".

## Requirements

- [Claude Code](https://claude.ai/code) CLI
- Node.js 18+
- [superpowers](https://github.com/obra/superpowers) -- base skills framework (required; all skill chain skills wrap `superpowers:*` skills)
- [rtk](https://github.com/rtk-ai/rtk) -- token-optimized command proxy (strongly recommended; tool router redirects `grep`/`find`/`cat` through rtk when available)
- [jcodemunch](https://github.com/jgravelle/jcodemunch-mcp) -- indexed code search MCP server
  (strongly recommended; powers the scout agent and tool router fallback). Detected via PATH or,
  failing that, the MCP server command registered in Claude Code's own config (`claude mcp list`)
  -- wheel-URL `uvx --from` installs work out of the box.
- [graphify](https://github.com/safishamsi/graphify) -- knowledge graph builder
  (recommended; auto-builds graphs at session start and provides god nodes,
  module communities, and dependency path queries that complement jcodemunch's
  symbol search)

> **Tested against:** rtk 0.46.0 · jcodemunch-mcp ~1.108.x · graphify 0.4.31 · headroom 0.32.0 · superpowers 6.2.0
>
> This line is generated from [`.github/dependency-versions.json`](.github/dependency-versions.json)
> (the machine-checkable source of truth, including each tool's repo coordinates).
> To bump a tested version, edit the manifest and run `npm run sync:versions` — don't edit the line by hand.

### Using rig with Headroom

[Headroom](https://github.com/chopratejas/headroom) is a context-compression proxy that
sits between the agent and the LLM API. It is **complementary** to rig -- the two operate
at different stages of the token pipeline and can run in the same project:

| | rig | Headroom |
| --- | --- | --- |
| Layer | Tool calls (PreToolUse/PostToolUse hooks) | API payloads (local proxy via `ANTHROPIC_BASE_URL`) |
| Saves tokens by | Routing to cheaper tools *before* output is produced | Compressing context *after* it exists, before the API |
| Also provides | Enforcement, skill chain, scout agent | Conversation compression, KV-cache alignment, memory |

**The one conflict to avoid:** `headroom wrap claude` can install rtk's own
*global* Bash-rewriting PreToolUse hook (when run with `--rtk` or `HEADROOM_RTK=1`),
stacking a second rewriter on rig's project-level routing. Plain `wrap claude`
does not enable rtk by default — but if you opt in, rig's session-start warns
when the redundant global hook is present (remove with `rtk init --uninstall -g`).

**Recommendation:** let rig own the tool-routing seam and Headroom own the
compression seam:

- Trial per-invocation with `headroom wrap claude` (rtk stays off unless you pass `--rtk`), or
- Install durably with `headroom init claude`, which configures only the proxy and does not touch rtk.

Rig detects Headroom automatically: when the proxy is configured for a project
(`headroom init claude` hook marker or a localhost `ANTHROPIC_BASE_URL` in any
settings scope), session start reports it and `/savings` pulls in `headroom perf`
data as a separate **context layer** line:

```
[rig] Session Savings
  rtk: 1.2M saved (42 calls, +340K this session)
  jcodemunch: 85K saved (23 queries, 150M total all-time)
  headroom: 40K saved (context layer — 42 requests, 40% compression, 78% cache hits; not summed with tool-layer savings)
  graphify: 913 nodes, 1349 edges, 62 communities (100% EXTRACTED, 0% INFERRED, 0% AMBIGUOUS)
  superpowers: installed (v6.2.0)
```

`/savings` reports every layer it detects side by side — rtk and jcodemunch on
the tool layer, headroom on the context layer, and graphify's graph stats. The
tool and context layers overlap at the rtk boundary, so rig reports them side
by side and never adds them together.

## Quick start

```bash
# Clone and build
git clone https://github.com/franklywatson/claude-rig.git
cd claude-rig
npm install
npm run build

# Link globally so `rig init` works anywhere
npm link

# Initialize in your project
cd /path/to/your/project
rig init

# Optional: pre-authorize common tools to reduce permission prompts (see below)
rig init --broad-permissions

# Verify installation (in a Claude Code session)
/verify-harness
```

The `init` command generates hooks, skills, agents, config, and permissions into your
project's `.claude/` directory. Hook commands use `${CLAUDE_PROJECT_DIR}` for portability
across machines.

### Permissions

By default `rig init` only adds the secret-file **deny** list (`**/secrets/**`,
`**/credentials/**`, `**/*.pem`, `**/*.key` for Read and Edit — Claude Code
treats `Edit(path)` as the umbrella rule covering all file-editing tools,
including Write, so no separate `Write(path)` entry is needed). No allow
entries are written — you control your own approval level.

Versions before 0.7.2 also wrote redundant `Write(**/...)` deny entries, which
Claude Code now flags at startup ("is not matched by file permission checks —
only Edit(path) rules are"). Re-running `rig init` (no `--force` required)
strips those stale entries from an existing `.claude/settings.json`.

Use `--broad-permissions` to pre-authorize common tools and reduce repeated prompts:

```bash
rig init --broad-permissions
```

This adds to `permissions.allow`: MCP tools (`mcp__jcodemunch__*`, `mcp__graphify__*`),
session cache reads (`Bash(cat /tmp/rig-session-*)` etc.), `Bash(npx:*)`,
`Bash(rtk:*)` (when rtk detected), and broad bash read-ops (`Bash(ls:*)`,
`Bash(cat:*)`, `Bash(grep:*)`, `Bash(find:*)`, `Bash(which:*)`, `Bash(node:*)`,
`Bash(npm:*)`).

**Why broad bash permissions?** Claude Code's system prompt requires agents to use
absolute paths unconditionally. Each new absolute path triggers a
permission prompt unless the command pattern is pre-authorized. `--broad-permissions`
pre-authorizes common read-only operations so agents can explore the codebase without
constant approval dialogs.

Existing user permissions are preserved on re-init. Entries are deduplicated automatically.
The deny list is always applied regardless of the flag.

## Architecture

```
+---------------------------------------------------+
|                    Claude Code                    |
+------------+------------+-------------------------+
| PreToolUse | PostToolUse| Session Start           |
| Hook       | Hook       | Hook                    |
| (router)   | (enforce)  | (auto-index)            |
+------------+------------+-------------------------+
|               Skill Chain Pipeline                |
|  brain+ -> plan+ -> tdd+|sdd+ -> verify+ -> rev+  |
|                debug+ (any phase)                 |
+---------------------------------------------------+
|                    Scout Agent                    |
|     (CodebaseMap + GraphContext + cross-repo)     |
+---------------------------------------------------+
|               .harness.yaml config                |
+---------------------------------------------------+
```

Four layers, one config file. See [docs/architecture.md](docs/architecture.md) for the full design.

## Configuration

Rig uses `.harness.yaml` in your project root:

```yaml
rules:
  stale_tests:
    enforcement: advise        # block | advise | silent
    grace_period: 0
  test_scope:
    enforcement: advise
    allowed_unscoped: [vitest watch, jest --watch]
  constitutional:
    no_mocks: advise
    evidence_only: block
  zero_defect:
    tolerance: strict
    unrelated_errors: block      # silent|advise|block — how to handle pre-existing failures
  tool_routing:
    native_read: advise        # advise jcodemunch for Read on code files
    native_grep: advise        # advise jcodemunch for Grep
    native_glob: advise        # advise jcodemunch for Glob on code patterns
    rtk_cat_code: block        # block rtk read/smart on code files
    jcodemunch_divert: advise  # advise | block | silent — divert high-value Bash shapes (big cat, identifier grep) to jcodemunch instead of rtk
  workflow:
    branch_discipline: advise  # block | advise | silent — git commit/push on a protected branch
    protected_branches: [master, main]
    isolation_strategy: auto   # auto | branch | worktree — auto picks worktree when the tree is dirty
    team_execution: offer      # offer | auto | never — parallel teammates for independent tasks (needs experimental agent-teams)
    typed_agent_enforcement: advise  # block | advise | silent — during sdd+/review+, steer general-purpose dispatches to typed agents
```

Each enforcement rule can be `block` (hook exits nonzero), `advise` (advisory
emitted to the agent as `additionalContext`), or `silent` (logs only). Active
enforcement rules are emitted at session start and referenced dynamically by
skill templates -- set `no_mocks: silent` to disable no-mock enforcement
entirely.

## Skill chain

| Skill | Purpose | Wraps |
| ----- | ------- | ----- |
| `brain+` | Ideation and requirements | `superpowers:brainstorming` |
| `plan+` | Implementation planning | `superpowers:writing-plans` |
| `tdd+` | Test-driven development | `superpowers:test-driven-development` |
| `sdd+` | Subagent-driven plan execution (typed implementer/reviewer agents) | `superpowers:subagent-driven-development` |
| `verify+` | Implementation verification | `superpowers:verification-before-completion` |
| `review+` | Code review | `superpowers:requesting-code-review` |
| `debug+` | Systematic debugging | `superpowers:systematic-debugging` |
| `savings` | Session token savings report | -- |
| `investigate` | Alias for `debug+` | -- |

The chain is ordered by convention, with one tracked gate: `verify+` requires a
prior `tdd+` or `sdd+` visit; every other transition is free (`review+` and
`debug+` work from any phase). The ordering is carried by each skill's
procedure text plus the phase tracker's transition rules — no hook blocks an
out-of-order skill invocation. `sdd+` is a peer of `tdd+` for plans with
independent tasks -- it executes each task via typed subagents (implementer ->
spec-reviewer -> code-reviewer). `debug+`, `savings`, and `investigate` are
standalone (no phase prerequisite). `debug+` mandates scout context harvesting.

## What gets installed

```
.claude/
  settings.json          # Hook registrations + permissions
  hooks/
    scripts/
      pre-tool-use.ts    # Tool router
      post-tool-use.ts   # Enforcement pipeline
      session-start.ts   # Auto-indexing
  skills/
    brain-plus/          # brain+ skill
      references/
        agent-loops.md   # Signal-stack / maintainer-loop design vocabulary
    plan-plus/           # plan+ skill
      references/
        agent-loops.md   # Same reference, installed for plan+
    tdd-plus/            # tdd+ skill
    sdd-plus/            # sdd+ skill (typed subagent execution)
    verify-plus/         # verify+ skill
    review-plus/         # review+ skill
    debug-plus/          # debug+ skill (systematic debugging)
    verify-harness/      # Installation verifier
    savings/             # Session savings report
    investigate/         # Alias for debug+
  agents/
    scout.md             # Cross-repo scout agent
    code-reviewer.md     # Typed code-quality reviewer (read-only)
    spec-reviewer.md     # Typed spec-compliance reviewer (read-only)
    implementer.md       # Typed task implementer
.harness.yaml            # Enforcement configuration (project root)
```

## Development

```bash
npm install
npm test         # vitest, 1100+ tests (deterministic, model-independent)
npm run build    # TypeScript compile
npm run lint     # type-check only
npm run eval     # behavioral evals — live claude -p runs (see below)
```

### Behavioral evals

`npm test` is deterministic and never runs through a model, so it can't see
model-driven behavior change. The `evals/` harness drives the real skill chain
through a real model (`claude -p`) and asserts on observable behavior with
model-robust invariants — the **L2 evaluation instrument** for rig's own skills.
Run it locally before releases and after a model change; running it under two
models and diffing the reports is the drift check. Not part of `npm test`, not a
CI gate (the nightly lane is operator-gated). See
[evals/README.md](evals/README.md) and
[docs/architecture.md](docs/architecture.md#behavioral-eval-harness-evals).

### Releasing

Releases are automated with
[release-please](https://github.com/googleapis/release-please) -- you don't cut
them by hand. Merge feature PRs with
[conventional commit](https://www.conventionalcommits.org) messages (`feat:`,
`fix:`, `feat!`/`BREAKING CHANGE:`) and release-please keeps a release PR open
that bumps `package.json` and `package-lock.json`. Merging that release PR tags
`vX.Y.Z` and publishes the GitHub Release with generated notes. There is no
in-repo `CHANGELOG.md` (`skip-changelog`); the notes live on the Release page.

The workflow (`.github/workflows/release.yml`) runs on every push to `master`.
A release PR appears only once a releasable commit (`feat:` or `fix:`) lands
after the latest tag -- `chore:`/`ci:`/`docs:` commits alone do not trigger one.

## Dogfooding

Rig uses itself during development. After building, run `rig init` in this repo to install hooks, skills, and agents into the local `.claude/` directory:

```bash
npm run build && npm link
rig init
```

This wires the same guardrails that rig installs for consumers — the tool router
intercepts shell commands, the enforcement pipeline runs after edits, and
`/savings` reports token usage for the session.

## Loop-centric development

Beyond shipping features, rig can steer a project toward a **self-assembling,
self-maintaining trajectory**: design a layered signal stack during `brain+`,
order the plan signal-stack-first in `plan+`, execute gate-by-gate with `sdd+`,
and hand the finished system to an always-on maintainer agent. Strictly opt-in
— `brain+` only offers it when the project fits. See
[docs/agent-loops.md](docs/agent-loops.md) for the full model.

## Extending rig

Rig is designed to be extended. Add custom enforcement checks (secrets scanning,
version pinning, log level enforcement), new skills, or additional config rules.
See [docs/extending.md](docs/extending.md) for patterns and examples.

The skill chain wraps [superpowers](https://github.com/obra/superpowers) skills
with project-specific enforcement -- threat modeling in brainstorming,
compliance in planning, latency budgets in TDD, security checklists in review.
See [docs/skill-wrapping.md](docs/skill-wrapping.md) for the wrapping pattern
and domain-specific scenarios.

## Related projects

- [agentic-patterns](https://github.com/franklywatson/agentic-patterns) -- Pattern library (L0-L4) that guided this system's design
- [superpowers](https://github.com/obra/superpowers) -- Base skills framework that the skill chain wraps
- [gstack](https://github.com/garrytan/gstack) -- Alternative agent skill framework with resolver pipeline
- [graphify](https://github.com/safishamsi/graphify) -- Knowledge graph builder for relationship-aware code exploration

## License

MIT
