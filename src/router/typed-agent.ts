import type { HarnessConfig } from '../types.js';
import type { SessionCache } from '../session/cache.js';
import { WORKFLOW_DEFAULTS } from '../session/worktree.js';

export interface TypedAgentResult {
  level: 'advise' | 'block';
  message: string;
}

// Phases that dispatch rig's typed agents (implementer / spec-reviewer / code-reviewer).
const ENFORCE_PHASES = new Set(['sdd+', 'review+']);
// subagent_type values that are NOT rig's typed agents: the general-purpose
// fallback and the 'claude' catch-all. A missing/empty subagent_type is also unttyped.
const UNTYPED = new Set(['general-purpose', 'claude']);

/**
 * PreToolUse gate (Release 2 / D1): during `sdd+`/`review+`, a Task/Agent
 * dispatch must use one of rig's typed agents — not general-purpose.
 *
 * superpowers' `subagent-driven-development` is general-purpose-native and
 * ships no typed agents, so without this gate the model silently reverts to
 * general-purpose, losing the typed agents' tool-scoping (reviewers can't
 * Edit/Write), enforcement rules in their system prompt, turn budgets, and
 * worktree isolation. Returns an advisory (steer to the typed agent) or a
 * block, per `rules.workflow.typed_agent_enforcement` (default `advise`).
 */
export function checkTypedAgentDispatch(
  tool: string,
  args: Record<string, unknown>,
  config: HarnessConfig,
  cache: SessionCache,
): TypedAgentResult | null {
  if (tool !== 'Agent' && tool !== 'Task') return null;
  const level = config.rules.workflow?.typed_agent_enforcement ?? WORKFLOW_DEFAULTS.typed_agent_enforcement;
  if (level === 'silent') return null;
  const phase = cache.getCurrentPhase();
  if (!phase || !ENFORCE_PHASES.has(phase)) return null;
  const subagentType = args.subagent_type as string | undefined;
  if (subagentType && !UNTYPED.has(subagentType)) return null; // a typed dispatch — allowed

  const typed = phase === 'review+' ? 'spec-reviewer or code-reviewer' : 'implementer';
  return {
    level,
    message: [
      `[${level === 'block' ? 'BLOCK' : 'ADVISE'}] Typed-agent enforcement: during ${phase}, dispatch a typed agent (subagent_type: "${typed}") instead of ${subagentType ? `'${subagentType}'` : 'a general-purpose subagent'}.`,
      `Typed agents carry tool-scoping, enforcement rules, and turn budgets that a general-purpose dispatch loses. (rules.workflow.typed_agent_enforcement — set to silent to disable)`,
    ].join('\n'),
  };
}
