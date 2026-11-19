#!/usr/bin/env node
/**
 * @rig-generated
 * rig: SessionStart hook
 * Project: {{PROJECT_NAME}}
 * Generated: {{GENERATED_DATE}}
 *
 * Detects environment (rtk, jcodemunch), auto-indexes CWD, initializes session cache.
 * Detected tools: rtk={{RTK_PATH}} jcodemunch={{JCODEMUNCH_AVAILABLE}}
 */
import { readFileSync } from 'node:fs';

(async () => {
  let handleSessionStart: any;
  let buildSessionStart: any;
  let SessionCache: any;

  try {
    const session = await import('{{RIG_DIST_PATH}}/session/start.js');
    handleSessionStart = session.handleSessionStart;
    buildSessionStart = session.buildSessionStart;
    const cache = await import('{{RIG_DIST_PATH}}/session/cache.js');
    SessionCache = cache.SessionCache;
  } catch {
    // rig dist not available — don't block the session
    process.exit(0);
  }

  const cwd = process.cwd();

  try {
    // Parse stdin to extract session_id for cache isolation
    let input: any = {};
    try {
      input = JSON.parse(readFileSync(0, 'utf-8') || '{}');
    } catch {
      // No stdin or malformed — proceed without session isolation
    }

    const cache = new SessionCache(cwd, input.session_id);

    // A rig build from before buildSessionStart has only the summary to give.
    const started = buildSessionStart
      ? buildSessionStart(cwd, cache)
      : handleSessionStart(cwd, cache).then((summary: string) => ({ summary }));

    started.then((output: { summary: string; agentContext?: string }) => {
      console.error(output.summary);
      // stderr on exit 0 never reaches the agent. The lines skill templates
      // read go to it as additionalContext.
      if (output.agentContext) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: output.agentContext,
          },
        }));
      }
      process.exit(0);
    }).catch(() => {
      // Session init failed — don't block the session
      process.exit(0);
    });
  } catch {
    // Uncaught synchronous error — don't block the session
    process.exit(0);
  }
})();
