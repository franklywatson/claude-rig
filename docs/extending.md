# Extending Rig

Rig ships with a core set of enforcement checks and skills, but every project has
different non-negotiables. This doc covers how to add your own.

## Custom enforcement checks

Enforcement checks are composable functions added to the PostToolUse pipeline.
Each check follows the same signature, returning rig's structured
`EnforcementViolation` type (`src/types.ts`):

```typescript
// rig's EnforcementViolation (src/types.ts). Declare it locally in your
// check file — the generated hooks load rig from its dist path, not as a
// package dependency of your project.
interface EnforcementViolation {
  level: 'block' | 'advise';
  message: string;
}

function checkFoo(
  filePath: string,
  content: string,
  config: HarnessConfig,
): EnforcementViolation | null
```

Return `null` if the check passes, or `{ level, message }` if it fails —
`level` is `'block'` or `'advise'`. Severity is **structural**: the pipeline
derives the combined result's level from these values and never sniffs message
text for prefixes like `[BLOCK]` (messages can embed arbitrary tool output,
including that literal string). Any block-level violation makes the combined
result block-level; advisory messages are joined and reported together.

### Example: secrets scanning

Add a check that flags committed secrets, API keys, and tokens:

```typescript
// .claude/hooks/scripts/check-secrets.ts
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,                        // AWS access key
  /ghp_[0-9a-zA-Z]{36}/,                     // GitHub token
  /sk-[a-zA-Z0-9]{48}/,                      // OpenAI API key
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY/, // PEM private key
];

export function checkSecrets(
  filePath: string,
  content: string,
): EnforcementViolation | null {
  // Skip non-source files
  if (/\.lock$|\.map$|package-lock\.json/.test(filePath)) return null;

  const match = SECRET_PATTERNS.find(p => p.test(content));
  if (!match) return null;

  return {
    level: 'block',
    message: [
      'Secrets detected',
      '',
      `Pattern matched: ${match.source}`,
      `File: ${filePath}`,
      '',
      'Revoke this credential immediately and use environment variables or',
      'a secrets manager instead of committing secrets to source.',
    ].join('\n'),
  };
}
```

### Wiring a check into the installed hook

The hook that `rig init` installs (`.claude/hooks/scripts/post-tool-use.ts`)
does not contain the checks itself — it parses stdin, loads `.harness.yaml`,
delegates to rig's compiled `handlePostToolUse` (which runs the built-in
pipeline and returns one merged `EnforcementViolation | null`), and emits the
result: block → stderr + exit 2, advise → agent-visible `additionalContext`
JSON. The seam for a custom check is the generated hook script, around that
`handlePostToolUse` call — run your check there and merge by level:

```typescript
// In .claude/hooks/scripts/post-tool-use.ts (the generated file), after:
//   const result = handlePostToolUse(input.tool_name, input.tool_input,
//     tracker, cache, config, execFn);
import { checkSecrets } from './check-secrets.js';

let custom: EnforcementViolation | null = null;
if (input.tool_name === 'Edit' || input.tool_name === 'Write') {
  const filePath = String(input.tool_input?.file_path ?? '');
  const content = String(
    input.tool_input?.content ?? input.tool_input?.new_string ?? '',
  );
  custom = checkSecrets(filePath, content);
}

// Merge by level: any block wins; otherwise join advisory messages.
const violations = [result, custom].filter(Boolean) as EnforcementViolation[];
if (violations.length > 0) {
  const level = violations.some(v => v.level === 'block') ? 'block' : 'advise';
  const message = violations.map(v => v.message).join('\n\n');
  if (level === 'block') {
    console.error(message);
    process.exit(2);
  }
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
  }));
}
process.exit(0);
```

Note that `rig init --force` regenerates the hook script, so keep your custom
checks in separate files (like `check-secrets.ts` above) and re-apply the
wiring after a re-init.

### Example: version pinning

Enforce that `package.json` dependencies use exact versions:

```typescript
const PINNING_PATTERN = /"dependencies"|"devDependencies"/;
const LOOSE_VERSION = /"[^"]+":\s*"\^|~|>=|\*|latest|x\./;

export function checkVersionPinning(
  filePath: string,
  content: string,
): EnforcementViolation | null {
  if (filePath !== 'package.json') return null;
  if (!LOOSE_VERSION.test(content)) return null;

  return {
    level: 'advise',
    message: [
      'Unpinned dependency version detected',
      '',
      'Use exact versions (e.g., "1.2.3") instead of ranges (^, ~, >=).',
      'Unpinned versions introduce non-deterministic builds.',
    ].join('\n'),
  };
}
```

## Custom config rules

Add new rule categories to `.harness.yaml` and read them from your check
function:

```yaml
rules:
  secrets:
    enforcement: block
    patterns:
      - "AKIA[0-9A-Z]{16}"
      - "ghp_[0-9a-zA-Z]{36}"
  version_pinning:
    enforcement: advise
```

Access custom rules in your check via `config.rules`:

```typescript
const level = (config.rules as any).secrets?.enforcement ?? 'block';
```

## Custom skills

Add a new skill by creating a SKILL.md file in `.claude/skills/<name>/`:

```markdown
---
name: security-review
description: Run security-focused checks before merging
user-invocable: true
---

# Security Review

Run these checks before any merge or deployment:

1. Check for secrets in staged files
2. Verify no new dependencies with known CVEs
3. Confirm environment variables are used for all credentials
4. Review any new network calls for proper authentication
```

The skill appears as `/security-review` in Claude Code. To wrap a superpowers
skill with project-specific enforcement (like the built-in chain skills do),
see [skill-wrapping.md](skill-wrapping.md) for the wrapping pattern and
scenarios.

## Custom agents

Add agent definitions in `.claude/agents/`. Each agent is a markdown file with
YAML frontmatter specifying tool restrictions and turn limits:

```markdown
---
name: dependency-auditor
description: Audit dependencies for CVEs and licensing issues
tools:
  - Bash
  - Read
maxTurns: 15
---

# Dependency Auditor

Check all dependencies in package.json against known CVEs...

## Related

- [skill-wrapping.md](skill-wrapping.md) -- wrapping superpowers skills with
  project-specific enforcement (threat modeling, compliance, performance budgets)
- [architecture.md](architecture.md) -- full system design and enforcement pipeline
```
