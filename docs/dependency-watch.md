# Dependency Watch & Implement

rig's dependency automation: Dependabot as the rule-based baseline, plus
two GitHub Agentic Workflows (gh-aw) that detect upstream releases of the
panel tools and open Dependabot-alert gaps, analyze the integration or
fix impact, and implement approved changes as proposed PRs — with a human
at the two gates that matter (run approval and PR merge).

This is the maintainer-agent trajectory from [agent-loops.md](agent-loops.md),
materialized: the L1 external-contract signal (upstream releases,
vulnerability advisories) is watched continuously, and a
graduated-autonomy agent acts on it.

## The pieces

| Piece | What it is |
| ----- | ---------- |
| `.github/dependabot.yml` | Layer 0 baseline: weekly grouped npm version-update PRs (minor/patch grouped, majors individual) plus github-actions updates. Routine vulnerable-dep bumps are covered by Dependabot's own security-update PRs — no agent involved |
| `.github/dependency-versions.json` | Machine-checkable source of truth: one entry per panel tool (rtk, jcodemunch, graphify, headroom, superpowers) with `repo` coordinates, `testedVersion`, and integration `notes` |
| `npm run sync:versions` | Regenerates the README "Tested against" line from the manifest (`scripts/sync-tested-versions.ts` over the pure module `src/dependency-versions.ts`). Never hand-edit the README line |
| `.github/workflows/dependency-watch.md` | Weekly agentic workflow: probes upstream releases, files structured analysis issues |
| `.github/workflows/vuln-watch.md` | Weekly agentic workflow: escalates Dependabot alerts that no open Dependabot PR covers, filing structured `security-update` issues |
| `.github/workflows/dependency-implement.md` | Slash-command agentic workflow: `/implement` on an issue builds the change and proposes a PR (serves both `dependency-update` and `security-update` labels) |
| `dependency-implement` GitHub environment | Required-reviewer approval gate every implement run passes before the agent starts |

## dependency-watch (analysis -> issues)

**Trigger:** fuzzy weekly schedule (`weekly on monday`) + manual dispatch.
**Engine:** Claude engine against an Anthropic-compatible endpoint
(`engine.env.ANTHROPIC_BASE_URL`, model passes through verbatim; the host
must also be in `network.allowed` — engine defaults exempt only
`api.anthropic.com`). **Writes:** `create-issue` safe-output only, labeled
`dependency-update`, dedup by exact title, max 5 per run, hard
`max-ai-credits` cap.

Per release it files one issue with a fixed template — What changed
(cited from release notes) / Breaking vs additive / Affected rig modules
(cited file paths) / Proposed integration steps / Verification checklist
(`npm test`, `npm run lint`, `npm run sync:versions`, operator-gated
`npm run eval`). Releases inside a tested tilde range (e.g. `~1.108.x`)
are skipped; quiet weeks emit `noop`, never placeholder issues.

## dependency-implement (issues -> PRs)

**Trigger:** a maintainer comments `/implement` on an issue (`roles:
[admin, maintainer]`), then approves the run when the
`dependency-implement` environment pings them.
**Writes:** `create-pull-request` (label-gated to `dependency-update`
and `security-update` issues) + `add-comment` back on the issue. Never
merges, never closes issues, never pushes outside the safe-output
pipeline.

The agent executes the issue's checklist in the sandbox: `npm install` +
build, manifest bump, `npm run sync:versions`, fixture updates. For
`security-update` issues the manifest/README steps apply only when the
vulnerable package is one of the five panel tools — otherwise it is a
plain `package.json`/lockfile fix on a `security/<package>-<version>`
branch, and the agent must also verify the advisory no longer reproduces
(`npm audit` / re-check the alert). `package.json` and
`package-lock.json` deliberately stay in the protected-files set: the
`request_review` flag on a security PR is the human gate, not friction.
Zero-defect gate: the full suite must pass and the verbatim test summary
goes in the PR body; two fix iterations max — a red suite produces a
diagnosis comment on the issue, never a PR. `npm run eval` is
deliberately not run (operator-gated, live model spend) and its checklist
box stays unchecked.

## vuln-watch (alerts -> gap issues)

**Trigger:** fuzzy weekly schedule (`weekly on thursday`, offset from
dependency-watch's Monday so Dependabot's own PRs exist to check against)
plus manual dispatch. **Engine:** same Anthropic-compatible endpoint as
dependency-watch. **Writes:** `create-issue` safe-output only, labeled
`security-update`, dedup by exact title, max 5 per run.

The agent lists open Dependabot alerts (GitHub MCP `list_dependabot_alerts`
read-only tooling — no firewall additions), and **escalates the gap
only**: an alert whose remediation is already covered by an open
Dependabot bump PR is skipped silently. For each uncovered alert it
triages the fix shape (plain bump / breaking major / package replacement)
against rig's actual usage and files one issue with a fixed template —
Advisory / Vulnerable dependency / Why no Dependabot PR covers it /
Proposed fix path / Verification checklist. Quiet weeks emit `noop`. The
agent may note a vuln is dev-only or unreachable, but deferring is a
maintainer decision — it files the issue either way.

## Runbook

### One-time setup (vuln-watch + Layer 0)

1. **Enable Dependabot alerts**: repo Settings -> Code security ->
   Dependabot alerts. `dependabot.yml` covers version updates; alerts
   are a separate settings toggle and are the signal vuln-watch reads.
2. **Create the label**: `gh label create security-update --color D93F0B
   --description "npm vulnerability fix, filed by vuln-watch"` (the
   `create-issue` safe output auto-adds the label but does not create
   it with a description/color).
3. First run: `gh workflow run vuln-watch` (manual dispatch) and watch
   `gh run watch` — an empty backlog should emit `noop`.

### After a watch issue appears

Review the analysis (especially the Breaking vs additive verdict and the
affected-modules citations). Then either implement it yourself, or comment
`/implement` and approve the environment ping.

### After a vuln-watch issue appears

Review the gap analysis first — confirm the agent is right that no open
Dependabot PR covers the alert (the issue cites what it checked). If the
fix is a plain bump, `/implement` and the environment approval are the
whole loop. For breaking majors or package replacements, decide whether
the "Proposed fix path" is the plan you want before approving the run;
the implement agent adjusts where reality disagrees but is scoped to the
issue's plan.

### If a run files a fallback issue instead of a PR

gh-aw's safe-output pipeline can fall back to filing the *intended PR
content as an issue* when the signed push is refused. Observed cause:
the default `protected_files` policy (README.md is on the list; the
top-level-dot-folder rule covers `.github/`) — and this workflow's job is
editing exactly those files. The fix shipped in #83:

```yaml
safe-outputs:
  create-pull-request:
    protected-files:
      policy: request_review
      exclude:
        - README.md
        - .github/dependency-versions.json
        - .github/   # prefix exclude opts out of the dot-folder rule
```

Diagnose any failure with the run's `safe_outputs` job log
(`gh run view <id> --log`), or `gh aw audit <id>` for remediation YAML.

### gh-aw knobs learned the hard way

- `allowed-files` on `create-pull-request` is an **exclusive patch
  allowlist** (every patched file must match), not a protection exemption.
  Do not reach for it to bypass `protected_files`.
- The firewall allowlist is baked into the lock file at compile time —
  `network.allowed` needs literal hosts, and repo variables/secrets cannot
  serve it. Engine env vars *can* use `${{ secrets.* }}` for keys.
- `gh aw compile --approve` clears the compiler's security-review gate
  after a human reviews new secrets/actions in the diff (the review note
  belongs in the PR description).
- The compiler suggests fuzzy schedules over fixed cron; adopt them.
- gh-aw-generated `.github/skills/` is excluded from markdownlint
  (compiler-managed, regenerated by `gh aw init`).

### Local verification the sandbox cannot do

The implement agent has no rtk/graphify/headroom binaries (they are not
npm-distributable), so integration tests that need them self-skip. Before
merging a deps PR, run the skipped contract tests on a machine with the
new tool version on PATH — e.g.
`npx vitest run tests/integration/rtk-contract.test.ts` — and check
`/tmp/rig-rtk-rewrite-failures.log` for out-of-protocol rtk exits.

## History

- Phase 1 (#71): manifest + sync module + watch workflow. First run
  filed four real issues (#73-#76) with cited, coupling-aware analysis.
- Phase 2 (#77): implement workflow with approval environment.
- Fix cycle (#80, #83): protected-files push refusal -> fallback issues
  (#79, #82) -> correct `protected-files.exclude` knob. First successful
  loop: rtk 0.46.0 -> #73 -> PR #85.
- Vulnerability layer: Dependabot baseline (`dependabot.yml`) + vuln-watch
  gap escalation + implement label-gate widening. Modeled on the same
  watch -> issue -> `/implement` -> gated-PR loop; the agent escalates
  only alerts Dependabot's own PRs do not cover.

## Related

- [architecture.md](architecture.md) -- full system design
- [agent-loops.md](agent-loops.md) -- the maintainer-agent trajectory this implements
- [gh-aw documentation](https://github.github.com/gh-aw/) -- triggers, safe outputs, engines
