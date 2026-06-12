#!/usr/bin/env node
/**
 * @rig-generated
 * rig: PostToolUse hook
 * Project: {{PROJECT_NAME}}
 * Generated: {{GENERATED_DATE}}
 *
 * Enforces stale test detection, constitutional rules, zero-defect.
 * Config: .harness.yaml
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

(async () => {
  let handlePostToolUse: any;
  let FileTracker: any;
  let SessionCache: any;
  let loadConfig: any;

  try {
    const enforcement = await import('{{RIG_DIST_PATH}}/enforcement/post-tool-use.js');
    handlePostToolUse = enforcement.handlePostToolUse;
    const tracker = await import('{{RIG_DIST_PATH}}/enforcement/file-tracker.js');
    FileTracker = tracker.FileTracker;
    const cache = await import('{{RIG_DIST_PATH}}/session/cache.js');
    SessionCache = cache.SessionCache;
    const config = await import('{{RIG_DIST_PATH}}/config.js');
    loadConfig = config.loadConfig;
  } catch {
    // rig dist not available — exit cleanly
    process.exit(0);
  }

  const cwd = process.cwd();

  // Parse stdin first to extract session_id for cache isolation
  let input: any = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf-8') || '{}');
  } catch {
    // Malformed input — exit cleanly
    process.exit(0);
  }

  const cache = new SessionCache(cwd, input.session_id);
  const tracker = new FileTracker();

  // execFn powers external-directory graphify stats capture; without it that
  // branch of handlePostToolUse is dead code.
  const execFn = (cmd: string, opts?: { timeout?: number }) =>
    execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }) as string;

  loadConfig(resolve(cwd, '.harness.yaml')).then((config: any) => {
    const result = handlePostToolUse(input.tool_name, input.tool_input, tracker, cache, config, execFn);

    if (result) {
      // Block-level violations: exit 2 + stderr. PostToolUse cannot undo the
      // tool call, but Claude Code feeds stderr back to the agent as an error.
      if (result.includes('[BLOCK]')) {
        console.error(result);
        process.exit(2); // surface to agent as error
      }
      // Advise-level violations: agent-visible additionalContext JSON.
      // Plain text on exit 0 only reaches the human UI, never the agent.
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: result,
        },
      }));
    }
    process.exit(0);
  }).catch(() => {
    // Config load failed — exit cleanly
    process.exit(0);
  });
})();
