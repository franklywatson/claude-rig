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
  let selectAgentContext: any;
  let SessionCache: any;

  try {
    const session = await import('{{RIG_DIST_PATH}}/session/start.js');
    handleSessionStart = session.handleSessionStart;
    selectAgentContext = session.selectAgentContext;
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

    handleSessionStart(cwd, cache).then((output: string) => {
      console.error(output);
      // stderr on exit 0 never reaches the agent. The lines skill templates
      // read go to it as additionalContext.
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: selectAgentContext(output),
        },
      }));
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
