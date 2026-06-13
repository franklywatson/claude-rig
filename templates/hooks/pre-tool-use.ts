#!/usr/bin/env node
/**
 * @rig-generated
 * rig: PreToolUse hook
 * Project: {{PROJECT_NAME}}
 * Generated: {{GENERATED_DATE}}
 *
 * Intercepts tool calls and routes to optimal tools based on environment.
 * Config: .harness.yaml
 * Detected tools: rtk={{RTK_PATH}} jcodemunch={{JCODEMUNCH_AVAILABLE}}
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

(async () => {
  let handlePreToolUse: any;
  let SessionCache: any;
  let loadConfig: any;

  try {
    const hook = await import('{{RIG_DIST_PATH}}/router/hook.js');
    handlePreToolUse = hook.handlePreToolUse;
    const cache = await import('{{RIG_DIST_PATH}}/session/cache.js');
    SessionCache = cache.SessionCache;
    const config = await import('{{RIG_DIST_PATH}}/config.js');
    loadConfig = config.loadConfig;
  } catch {
    // rig dist not available — allow the tool call through
    process.exit(0);
  }

  const cwd = process.cwd();

  // Parse stdin first to extract session_id for cache isolation
  let input: any = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf-8') || '{}');
  } catch {
    // Malformed input — allow the tool call through
    process.exit(0);
  }

  const cache = new SessionCache(cwd, input.session_id);

  loadConfig(resolve(cwd, '.harness.yaml')).then((config: any) => {
    const result = handlePreToolUse(input.tool_name, input.tool_input, cache, config);

    // Transparent rewrite: output JSON with updatedInput
    if (result && result.type === 'rewrite') {
      const output = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { command: result.command },
        },
      });
      console.log(output);
      process.exit(0);
    }

    if (result) {
      // The severity comes from the structured result's level, derived by
      // the router itself — never from sniffing the message text, which can
      // embed arbitrary content (e.g. the literal string '[BLOCK]').
      if (result.level === 'block') {
        // Block: exit 2 + stderr (rejects the tool call, agent-visible)
        console.error(result.message);
        process.exit(2); // block
      }
      // Advise: agent-visible additionalContext JSON. Plain text on exit 0
      // only reaches the human UI, never the agent.
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: result.message,
        },
      }));
    }
    process.exit(0); // allow
  }).catch(() => {
    // Config load failed — allow the tool call through
    process.exit(0);
  });
})();
