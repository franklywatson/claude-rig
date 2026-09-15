# Automatic dependency/security PR pipeline

- **Date:** 2026-09-13
- **Status:** Approved design (awaiting implementation plan)
- **Approach:** Approach 1 — scheduled implementer sweep
- **Originating review:** cross-project comparison of rig's `.github/workflows/`
  against the claude-kb peer project's automation (findings summarized in
  Background)

## Background

rig's dependency automation today stops at issues. `dependency-watch.md`
(weekly Monday) and `vuln-watch.md` (weekly Thursday) file structured
`dependency-update` / `security-update` issues, but the only path from issue
to PR is `dependency-implement.md`, which requires a maintainer to comment
`/implement` **and** approve the `manual-approval: dependency-implement`
environment before the agent runs. The open backlog (#117, #121–#124 at time
of writing) is exactly the queue this design drains automatically.

The claude-kb peer project solved the same issue→PR gap, but with a component
we deliberately do not adopt: its org policy blocks GitHub Actions from
creating PRs, so gh-aw's `create-pull-request` safe output fell back to
"click here to create the PR" issues, and the fix was routing PR creation
through the **Claude Tag Slack bot** (`config/claude-tag-config.md`), which
drafts and opens PRs with its own push access. This design replaces that
manual/bot trigger with an automatic one and keeps everything inside GitHub
workflows (gh-aw + plain YAML), per project decision.

Verified facts this design relies on (2026-09-13):

- **Bot-created PRs work and get CI.** PR #85 (`deps/rtk-0.46.0-*`) was
  created by `github-actions[bot]` through gh-aw's safe-output pipeline using
  plain `GITHUB_TOKEN` (only `ANTHROPIC_API_KEY` is set as a repo secret);
  the `Tests` and `Docs Quality` workflows ran on it via `pull_request`
  events and passed. gh-aw's optional `GH_AW_CI_TRIGGER_TOKEN` is not
  configured and was not needed.
- **The repo already permits Actions-created PRs** (PR #85 is the evidence);
  confirming the Settings → Actions → "Allow GitHub Actions to create and
  approve pull requests" toggle remains an operator prerequisite, not a
  blocker.
- **gh-aw v0.86.2 supports the needed trigger machinery:** `on.steps:`
  deterministic pre-activation gating, `skip-if-no-match`, `concurrency`,
  `label_command`, `bots:` filtering, and `threat-detection` safe-output
  prompts.
- **The `dependency-implement.md` safe-output config is proven** — its
  `protected-files.exclude` list (README.md, `.github/dependency-versions.json`,
  `.github/` prefix) is the fix from the #79/#82 fallback-issue incident
  (#83) and is reused verbatim.

### Gaps in the current design (found during review)

1. **Superseded issues collide.** #117 (graphify 0.9.53) is superseded by
   #122 (0.9.55). A naive per-issue auto-implementer opens two conflicting
   PRs for the same tool.
2. **Closed-as-not-planned issues are re-filed forever.** Both watchers
   dedupe against *open* issues only (`--state open` in their prompts). Close
   a security-update issue as "dev-only, deferring" and vuln-watch re-files
   it next Thursday while the alert stays open.
3. **No injection hardening on the analysis→execution chain.** Release notes
   (external) → dep-watch issue body → implementer treats it as its spec.
4. **Sibling-PR conflicts.** Two concurrent dep PRs both regenerate the
   README "Tested against" line — a guaranteed conflict shape once more than
   one auto-PR is open.

## Goal

Watcher-filed `dependency-update` and `security-update` issues become pull
requests automatically, fully contained in GitHub workflows, with the human
gate moved to PR review and merge (approved decision: **merge only** — no
environment approval on the automatic path).

## Non-goals

- No external bot (Claude Tag / Slack) — explicitly rejected.
- No change to the watchers' schedules or analysis templates beyond the
  dedup and hardening edits in this spec.
- The manual `/implement` workflow stays as-is (retry/override path).
- No new secrets, labels, or repo settings beyond the confirmation above.
- Not adopted from claude-kb: the post-merge bookkeeping workflow (rig's
  `Closes #N` in PR bodies already closes source issues on merge) and the
  skiplist JSON (subsumed by the dedup fix — rig's issue titles are
  version/GHSA-exact, so all-state title matching suffices).

## Design

### Flow overview

```
dep-watch (Mon) ──files──> dependency-update issues ─┐
vuln-watch (Thu) ─files──> security-update issues ───┤
                                                     ▼
                            dependency-autoimplement (daily sweep, gh-aw)
                              pre-activation: any open implementable issue? ──no──> skip
                              agent: collapse supersessions → skip issues w/ open PR
                                      → implement ≤2 (oldest-first) → suite must pass
                                      → create-pull-request → add-comment
                                                     ▼
                            PR open (bot) ── CI runs (PR #85 precedent)
                                                     ▼
                            deps-conflict-settle (plain YAML): keeps sibling PRs mergeable
                                                     ▼
                            maintainer reviews & merges  ←── the only human gate
```

### 1. `dependency-autoimplement.md` (new gh-aw workflow)

**Frontmatter** — mirrors `dependency-implement.md` minus the gates, plus
sweep machinery:

```yaml
on:
  schedule: daily around 09:00        # fuzzy; empty days skip in pre-activation
  workflow_dispatch:                  # manual drain / targeted retry
permissions:
  contents: read                      # same proven set as dependency-implement.md;
  issues: read                        # the compiled safe-output job carries its own
  pull-requests: read                 # elevated job-level permissions
model: glm-5.3
engine:                              # identical to the other three workflows
  id: claude
  env:
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic"
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
network:
  allowed: [defaults, node, https://api.z.ai]
max-ai-credits: 2500                  # covers ≤2 issues; hard stop beyond
timeout-minutes: 90
concurrency:
  group: dep-autoimplement            # scheduled and manual runs serialize
  cancel-in-progress: false
# on.steps: deterministic gate (see below)
safe-outputs:
  create-pull-request:
    max: 2                            # ≤2 PRs per run — verify compiler accepts
                                      # max > 1 at implementation; fallback: 1/run
    allowed-labels: [dependency-update, security-update]
    protected-files:                  # byte-for-byte from dependency-implement.md
      policy: request_review          # (#83's lesson — do not re-derive)
      exclude: [README.md, .github/dependency-versions.json, .github/]
  add-comment:
    max: 4                            # per-issue notes + supersession explanations
  threat-detection:
    prompt: |
      <injection-detection prompt — see §3>
```

**Pre-activation gate** (`on.steps:` + `issues: read`): one step sums
`gh issue list --label dependency-update --state open` and
`--label security-update --state open`; writes `has_issues=true|false` to
`$GITHUB_OUTPUT`, re-exported through `jobs.pre-activation.outputs` so the
agent job is **skipped, not failed**, on empty days (near-zero cost — no
agent, no credits).

**Procedure (agent prompt):** the back half is `dependency-implement.md`'s
procedure verbatim (workspace setup; execute the issue's plan — manifest
bump + `npm run sync:versions` + version-coupled fixtures for
dependency-update, package fix + `npm audit` re-check for security-update;
`npm run lint` + `npm test` with the verbatim summary line in the PR body;
two fix iterations max, else `add-comment` and move on; never run
`npm run eval`; PR title/branch conventions `feat|fix(deps): …` on
`deps/<tool>-<version>` / `security/<package>-<version>`). New front half:

1. List open `dependency-update` and `security-update` issues.
2. **Supersession collapse.** Group by tool/package (titles are exact:
   `<tool> <version> released (tested: …)`, `<package>: <advisory> (…)`).
   Per group, keep only the newest version / newest advisory issue. Do not
   implement superseded ones; `add-comment` on each ("superseded by #N;
   closes with its PR") and add their numbers as extra `Closes #N` lines in
   the surviving PR body.
3. **Open-PR guard.** Skip any issue already served by an open PR — check
   open PR head refs (`deps/*`, `security/*`) and `Closes #<n>` occurrences
   in open PR bodies.
4. Take at most 2 remaining issues, oldest first, and implement each per
   the existing procedure. PR body must carry `Closes #<issue>` (plus
   supersession closes from step 2).
5. Nothing implementable after steps 2–3 → `noop`.

### 2. `deps-conflict-settle.yml` + settle script (plain YAML, no AI)

claude-kb's `pr-conflict-settle.yml` translated to rig's conflict shape.
Deterministic bookkeeping only — the AI layer never touches git state here.

- **Triggers:** `pull_request: [opened, synchronize, reopened]` gated to
  same-repo PRs whose head ref starts with `deps/` or `security/`, plus
  `workflow_dispatch` with a `pr_number` input (claude-kb's
  silent-trigger-failure lesson: always keep a manual re-entry point that
  runs identical logic and refuses non-matching PRs).
- **Per-run behavior:** resolve PR context from `gh pr view` into plain
  shell vars (never interpolate `github.event.pull_request.*.ref` directly
  into `run:` — branch names are attacker-influenceable text; actionlint
  discipline); checkout the head ref (`fetch-depth: 0`); configure the
  `github-actions[bot]` identity; `git merge --no-edit origin/master`.
  - **Clean** → push the merge commit if HEAD moved.
  - **Conflicted, and every conflicted file (`git diff --name-only
    --diff-filter=U`) is in {`README.md`, `.github/dependency-versions.json`}**
    → *recompute, never pick a side*: write the merged manifest via the
    settle script (max `testedVersion` per tool entry, tilde-range aware),
    then `npm ci && npm run sync:versions` to regenerate the README line
    from the merged manifest, `npm run lint` as the cheap sanity gate —
    full CI validates the pushed commit itself. Commit and push.
  - **Any other conflicted file** → `git merge --abort` and comment on the
    PR naming the files, leaving resolution to a human.
- **Concurrency:** `group: deps-conflict-settle-<pr number>`,
  `cancel-in-progress: true` (rapid successive pushes settle once).
- **Permissions:** `contents: write`, `pull-requests: write`, `issues: write`.

**Code layout** follows the repo's script/module split:

- `src/dependency-versions.ts` gains a pure `mergeDependencyManifests(ours, theirs)`
  (higher `testedVersion` per tool; entries present on one side pass
  through; tilde ranges compare by leading numeric segments) beside the
  existing `parseDependencyManifest` / `renderTestedAgainstLine`.
- `scripts/settle-deps-conflict.ts` (thin `#!/usr/bin/env tsx` wrapper, same
  shape as `scripts/sync-tested-versions.ts`) reads the conflicted manifest,
  writes the merged one, and reports unresolved state via exit codes
  (kb's convention: distinct exit codes for "no mechanical conflict" vs
  "merge failed").
- Unit tests mirror `tests/dependency-versions.test.ts` for the merge
  function (same-version, cross-version, tilde ranges, disjoint tool sets,
  malformed entries).

### 3. Watcher hardening

- **Dedup fix (both watchers).** dep-watch step 4 and vuln-watch step 3
  change `--state open` → `--state all` with exact-match semantics (version
  string / GHSA+package). A closed issue means "already triaged" —
  implemented *or* rejected — and must not be re-filed. Update the adjacent
  discipline notes to say so. At implementation, verify gh-aw's
  `deduplicate-by-title` scope agrees (it must not silently refuse or
  double-gate the new behavior).
- **`threat-detection` prompts** on `dependency-watch.md`,
  `vuln-watch.md`, and the new `dependency-autoimplement.md`, modeled on
  claude-kb's: flag any issue/PR body that echoes text addressed to
  "the AI"/"assistant"/"agent" from fetched release notes or advisories,
  cites URLs the run never fetched, or deviates from the mandated output
  structure (labels, counts, section order). This is the mitigation for the
  release-notes → issue → spec injection chain this design widens.

### 4. Documentation

- `docs/dependency-watch.md`: new section on the automatic path — sweep
  cadence, merge-only gate, conflict-settle runbook entry (how to
  re-dispatch, how to read abort comments), updated gh-aw-knobs notes.
- `README.md` dependency-automation section: one paragraph — watchers file
  issues, the sweep turns them into PRs automatically, humans merge.

## Prerequisites (operator)

1. Confirm Settings → Actions → General → "Allow GitHub Actions to create
   and approve pull requests" is enabled (evidence says it already is).
2. Nothing else: no new secrets, labels, or environments.

## Rollout & verification

1. `gh aw compile` the new workflow (no new secrets or actions → should not
   trip the compiler's security-review gate; if it does, `--approve` after
   review, per the existing runbook note).
2. First live run is the real test — the current backlog exercises every
   new path: #124 smol-toml + #123 vitest (mechanical security bumps),
   #121 rtk (dependency integration), #122 graphify **superseding #117**
   (collapse + dual-close).
3. Once two auto-PRs coexist, `workflow_dispatch` `deps-conflict-settle.yml`
   against one to exercise the mechanical resolution; confirm CI runs on
   the settle push.
4. Unit tests (`npm test`) cover the manifest merge; `npm run lint` covers
   types.
5. Watch the first week: credit spend per sweep, supersession comments,
   settle behavior after the first merge.

## Residual risks (accepted)

- **Manual/sweep race:** `/implement` running while the sweep picks the same
  issue can produce a duplicate PR (guarded by the open-PR check; worst case
  is noise, never corruption — one is merged, the other closed).
- **Injection surface:** a poisoned release note could steer analysis into
  an issue body. Contained by threat-detection prompts, safe-output
  validation (patch size/file caps, protected-files `request_review`), the
  suite gate, and the human merge.
- **`create-pull-request max: 2`** is expected but unverified; fallback is
  1 PR/run at daily cadence (same drain rate for a weekly-watch backlog).

## Open items to verify at implementation

- gh-aw accepts `max > 1` for `create-pull-request` (else fallback above).
- gh-aw `deduplicate-by-title` scope (open vs. all) — must not conflict with
  the watcher prompt change.
- Exact `on.steps:` wiring for skip-not-fail semantics against gh-aw v0.86.2
  (the documented `jobs.pre-activation.outputs` + `if:` pattern).
