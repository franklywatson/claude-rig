# Release 2 — Structural + Detection + Adoption (C+D+E+F)

**Source design:** `brain+` Release 2 scope (2026-07-29); one release (C+D+E+F); D = hook enforcement + verify check.
**Branch:** `feat/dep-sync-release-2` (off merged `master` @ `8987de7`).
**Target version:** **0.8.0** (minor — `feat:` work; release-please interaction noted in T-final).

> ## ⚠️ Workstream C reframed — needs sign-off before implementation
>
> The original C ("replace `rtk rewrite` with `rtk hook claude` delegation") was chosen on incomplete information. A read-only exploration of `~/tools/rtk` (v0.44.1) found it is **(a) blocked** — the deployed rtk is **v0.33.1**; `rtk hook claude` shipped in source at **v0.37.x**, so it doesn't exist on the installed binary — and **(b) the wrong seam**:
> - `rtk rewrite` is rtk's *designated* hook-facing API ("single source of truth for hooks", `main.rs:841`) with a **richer** protocol (exit 0/1/2/3 = allow/no-equiv/deny/ask) than `rtk hook claude` (which emits only allow-or-nothing and **cannot express deny or ask** to its caller).
> - Both use the **same decision engine** and read the **same** Claude Code `settings.json` allow/deny/ask rules (`check_command → load_permission_rules`). There is no verdict information the hook exposes that `rtk rewrite` lacks.
> - rig's `pre-tool-use.ts` is *already* the PreToolUse hook; calling `rtk hook claude` (designed to *be* the hook) and re-wrapping its JSON is double-wrapping to recover an exit code.
> - Release 1's T3 already achieved the least-privilege goal (exit-3 → no `permissionDecision`).
>
> **Reframed C** = the one genuinely-open item: **deconflict rtk's own global hook** (if a user ran `rtk init --global` / `headroom wrap claude --rtk`, rtk installs a *second* global PreToolUse rewriter stacked on rig's project hook) + an audit confirming the `rtk rewrite` mapping is correct. **Not** a re-architecture. If you'd rather drop C entirely (T3 may suffice), say so.

## Constitutional Rules / Mock Policy
Same as Release 1: injectable `ExecFn`/`ExecRewriteFn` (no component mocks); evidence before claims; every source change ships with test changes; `npm test` green per task. Docs tasks verified by the markdown-lint gate (now passing after `f17fafa`) + grep assertions.

## Context (verified facts carried over)
- rtk 0.44.1 (deployed 0.33.1): `rtk rewrite` is the hook API; exit 0/1/2/3; reads CC `settings.json`; `rtk init -g` writes a global PreToolUse hook `{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}` to `~/.claude/settings.json`.
- jcodemunch ~1.108.x: large untapped catalog (`plan_turn`, `get_ranked_context`, `assemble_task_context`, `search_ast`, `winnow_symbols`, etc.).
- graphify 0.4.31: new MCP tools `get_node`, `get_neighbors`.
- headroom 0.32.0/main: `headroom savings --json` (durable ledger), `headroom doctor --json`.
- superpowers 6.2.0: install registry at `~/.claude/plugins/installed_plugins.json` (key `superpowers@*`); all 9 wrapped skills stable; no typed agents; general-purpose dispatch.
- Tool versions to reference in docs: **rtk 0.44.1, jcodemunch ~1.108.x, graphify 0.4.31, headroom 0.32.0, superpowers 6.2.0**.

---

## T0 — Build fix (DONE)
`f17fafa` — excluded `docs/plans/` from markdownlint (point-in-time plan artifacts). Docs Quality gate now green.

## Task C (reframed): rtk global-hook deconfliction + rewrite-integration audit
Detect rtk's *own* global PreToolUse hook and advise removal (it double-processes commands rig's project hook already rewrote); confirm the `rtk rewrite` exit-code mapping is correct post-T3.

**Files:** `src/session/environment.ts` (new probe), `src/session/start.ts` (emit warning), `src/router/hook.ts` (audit only — confirm exit-0→allow / exit-3→no-permissionDecision; no code change expected), `tests/session/environment.test.ts`, `tests/session/start.test.ts`
**Approach:** probe `~/.claude/settings.json` `hooks.PreToolUse` for a command containing `rtk hook` (rtk's global hook marker); if present AND rig is also rewriting, emit a one-time `[HINT]` at session start: "rtk's global PreToolUse hook is installed; rig's project hook already performs rtk rewrites — remove it (`rtk init --uninstall -g`) to avoid double-processing." Audit: add/confirm a test asserting exit-0 → `autoAllow:true` and exit-3 → `autoAllow:false` (already covered by Release 1's `rewrite.test.ts`; just confirm no regression).
**Test strategy:** injectable read of `~/.claude/settings.json`; assert the hint fires when the marker is present and is silent when absent.
- [ ] RED → GREEN → commit `feat(router): deconflict rtk's global PreToolUse hook with rig's project hook`.

## Task D1 (headline): typed-agent PreToolUse enforcement
Programmatic gate so the typed-agent dispatch can't silently revert to general-purpose (the user's original concern). During `sdd+`/`review+` phase, intercept `Task`/`Agent`; if `subagent_type` is missing or `general-purpose`, advise (steer to the typed agent) or block.

**Files:** `src/router/hook.ts` (new check, after branch-discipline) or new `src/router/typed-agent.ts`; `src/types.ts` (config: `rules.workflow.typed_agent_enforcement: 'advise'|'block'|'silent'`, default `advise`); `src/config.ts` (default); `templates/hooks/pre-tool-use.ts` (emit the advisory via `additionalContext` / block via exit 2); `tests/router/hook.test.ts` (or `typed-agent.test.ts`)
**Mechanism:** read phase from `SessionCache.getCurrentPhase()`; `tool_name ∈ {Task, Agent}`; `tool_input.subagent_type ∈ {undefined, 'general-purpose', 'claude'}` → violation. Configurable level.
**Test strategy:** injectable phase (session cache); assert advise-level emits `additionalContext` mentioning the typed agent during `sdd+`, and is a no-op in other phases / for typed dispatches; block-level exits 2.
- [ ] RED → GREEN → commit `feat(router): enforce typed-agent dispatch during sdd+/review+ (PreToolUse gate)`.

## Task D2: verify-harness typed-agent check
**Files:** `templates/skills/verify-harness/SKILL.md` (add a check that `.claude/agents/{implementer,code-reviewer,spec-reviewer}.md` exist + are resolvable), `tests/cli/template-content.test.ts`
**Test strategy:** template-content assertion that verify-harness references the typed-agent files.
- [ ] commit `feat(verify-harness): check typed agents are installed`.

## Task E1: superpowers detection
Detect superpowers via the plugin registry; report at session start; warn if absent (rig's skill chain requires it).

**Files:** `src/session/environment.ts` (read `~/.claude/plugins/installed_plugins.json`; superpowers installed iff any `plugins` key matches `/^superpowers@/`; capture version + installPath), `src/types.ts` (`Environment.superpowers: { installed, version? }`), `src/session/start.ts` (emit `superpowers: installed (v6.2.0)` or a `[WARNING] ... install via /plugin install superpowers@claude-plugins-official`), `tests/session/environment.test.ts`
**Fallback:** if registry absent/unreadable, glob `~/.claude/plugins/cache/*/superpowers/*/.claude-plugin/plugin.json` with `name==="superpowers"`.
**Test strategy:** injectable filesystem read; assert detection from a canned `installed_plugins.json` and the absent-case warning.
- [ ] commit `feat(session): detect superpowers via plugin registry`.

## Task E2: superpowers verify-harness check + install docs
**Files:** `templates/skills/verify-harness/SKILL.md` (check superpowers detected; deepest check: `<installPath>/skills/brainstorming/SKILL.md` exists), `docs/getting-started.md` (plugin-marketplace install: `/plugin install superpowers@claude-plugins-official`), `tests/cli/template-content.test.ts`
- [ ] commit `docs+feat(verify-harness): superpowers check + plugin-marketplace install instructions`.

## Task F1: jcodemunch catalog adoption (scout + reviewers)
Adopt the highest-leverage untapped tools: `plan_turn`, `get_ranked_context`/`assemble_task_context` (token-budgeted context) → scout; `search_ast` (AST anti-patterns) + `winnow_symbols` (multi-axis queries) → code-reviewer/router advisories.

**Files:** `templates/agents/scout.md` (tool list + procedure: use `plan_turn`/`get_ranked_context` for context harvesting), `templates/agents/code-reviewer.md` (add `search_ast`/`winnow_symbols`), `src/scout/mapper.ts` (optionally call `plan_turn`), `tests/scout/*.test.ts`, `tests/cli/template-content.test.ts`
**Test strategy:** template-content asserts the new tool names in agent `tools:` lists; scout procedure references them.
- [ ] commit `feat(scout): adopt jcodemunch plan_turn/ranked_context + AST/winnow tools`.

## Task F2: graphify get_node/get_neighbors
**Files:** `templates/agents/{scout,code-reviewer,spec-reviewer}.md` (add `mcp__graphify__get_node`, `mcp__graphify__get_neighbors` to `tools:`), `tests/cli/template-content.test.ts`
- [ ] commit `feat(agents): expose graphify get_node/get_neighbors`.

## Task F3: richer /savings + /verify-harness (headroom + rtk metrics)
`headroom savings --json` (durable ledger, restart-safe) → replace/augment the `headroom perf` read in `/savings`; `headroom doctor --json` → `/verify-harness`; `rtk gain --project` (per-project scope) → `/savings`.

**Files:** `src/session/metrics.ts` (`captureHeadroomStats` → prefer `headroom savings --json` schema: `lifetime.tokens_saved`, `windows.*`; add `headroom doctor --json` probe), `templates/skills/savings/SKILL.md`, `templates/skills/verify-harness/SKILL.md`, `tests/session/metrics.test.ts`
**Test strategy:** injectable exec; assert the new headroom schema is parsed and falls back to `perf` on drift.
- [ ] commit `feat(savings): headroom savings --json ledger + doctor + rtk gain --project`.

## Task DOCS: present-state rework + version references + feature docs
Per guidance: **docs explain the present state in plain terms — not change history — and reference the tool versions we're current against.**

**Files:** `README.md`, `docs/architecture.md`, `docs/getting-started.md`, `docs/troubleshooting.md` (+ new prose for C/D/E/F)
**Rework (change-history → present-state):**
- `README.md:103-113` headroom — drop "historically… now opt-in… against currently-released 0.32.0"; state plainly: "headroom's rtk integration is opt-in (`--rtk`/`HEADROOM_RTK=1`); plain `wrap claude` doesn't install rtk's hook." (current against headroom 0.32.0)
- `docs/architecture.md:134` — drop "rtk 0.36+ maps…"; state: "an exit-3 rewrite is emitted without `permissionDecision` so Claude Code prompts (rtk's least-privilege default for unrated commands)." (current against rtk 0.44.1)
- `README.md:187`, `docs/getting-started.md:85` — drop "since v2.1.97"; state the requirement plainly.
- Add a **"Current against"** note (README or architecture): rtk 0.44.1, jcodemunch ~1.108.x, graphify 0.4.31, headroom 0.32.0, superpowers 6.2.0.
**New feature docs:** describe D (typed-agent enforcement), E (superpowers detection), F (adopted tools) in present state.
**Test strategy:** markdown-lint gate (the `docs/plans/` exclude is in); grep assertions that change-history phrases are gone.
- [ ] commit `docs: present-state rework + tool-version references + Release 2 feature docs`.

## Task VERSION: bump to 0.8.0
**Files:** `package.json`, `package-lock.json` (version fields)
**⚠️ release-please interaction:** this repo uses release-please, which auto-bumps `package.json`/`package-lock.json` via its release PR on `feat:` commits — the `feat:` work above will naturally produce a **0.8.0** release. A *manual* bump in this branch can conflict with release-please's manifest. **Confirm before doing this:** (a) let release-please cut 0.8.0 (recommended — just merge the feature PR; release-please opens the 0.8.0 release PR), or (b) manually set 0.8.0 here and coordinate (close/align release-please's release PR). Default to (a) unless you've disabled release-please.
- [ ] commit `chore: bump version to 0.8.0` (only if manual bump is confirmed).

---

## Validation (Phase C)
- [ ] Every task has a test strategy (docs → lint+grep) ✓
- [ ] No protected-component mocks ✓
- [ ] Exact file paths, no TBDs ✓ (C reframed + flagged; E method concrete; version-bump release-please interaction flagged)
- [ ] Evidence criteria per task ✓
- [ ] C reframe has explicit user sign-off before T-C starts

## Execution
- Branch `feat/dep-sync-release-2`; `/tdd+` task-by-task (avoids the typed-agent revert until D1 lands; after D1, `/sdd+` becomes safe).
- Recommended order: **D1 → D2** (the headline, unblocks reliable typed dispatch) → C → E1 → E2 → F1 → F2 → F3 → DOCS → VERSION.
- Full suite green + `npm run lint` clean + markdown-lint clean before each commit; `/review+` then PR.

## Open question for you
**Sign off on the C reframe** (slim to global-hook deconfliction + audit, drop the `rtk hook claude` delegation) — or drop C entirely, or keep the delegation gated on a future rtk ≥0.37.x deploy?
