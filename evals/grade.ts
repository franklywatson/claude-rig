// Structural, model-robust grading of claude -p stream-json transcripts.
//
// Model-robustness rule (locked by the Task 1 spike, see evals/spike-findings.md):
// brain+'s loop opt-in question contains the loop-SPECIFIC tokens
// "agent-loop pattern" / "maintainer trajectory". The token "signal stack"
// ALSO appears in brain+'s general signal-first guidance that runs for EVERY
// project — so it is NOT a discriminator. The opt-in matcher keys only on the
// loop-specific tokens.

const LOOP_OPTIN_TOKENS = [/agent-loop pattern/i, /maintainer trajectory/i];

/** Recover assistant text from stream-json: the final `result` plus every
 *  `assistant` message's text blocks (the fields confirmed by the spike). */
export function extractAssistantText(jsonl: string): string {
  const parts: string[] = [];
  for (const line of jsonl.trim().split('\n').filter(Boolean)) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = o as { type?: string; result?: unknown; message?: { content?: unknown } };
    if (obj.type === 'result' && typeof obj.result === 'string') parts.push(obj.result);
    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      for (const c of obj.message.content as Array<{ type?: string; text?: unknown }>) {
        if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * True iff the transcript REFERENCES the loop trajectory (loop-specific tokens
 * only). This is a PRESENCE detector: it does NOT distinguish OFFERING the
 * trajectory from DISMISSING it by name ("this does not fit the agent-loop
 * pattern" / "I won't propose a maintainer trajectory"), which a non-fitting
 * brief legitimately does in visible output.
 *
 * That offer-vs-mention judgment is made downstream, in gradeTranscript's
 * loop-optin-absent case: "no token" → compliant (nothing was referenced, so
 * nothing was offered); "token present" → the judge decides (its prompt asks
 * the offer question directly). For the positive scenario presence IS the
 * correct signal — a fitting brief that names the trajectory has offered it.
 * (Originally this matcher's bare-presence result was used as the negative
 * verdict too, which false-positived a live Opus run that dismissed the
 * pattern by name; routing token-present cases to the judge fixed that.)
 */
export function matchLoopOptIn(text: string): boolean {
  return LOOP_OPTIN_TOKENS.some((re) => re.test(text));
}

/**
 * True iff an opted-in design carries all three required sections.
 *
 * Same presence-vs-structure caveat as matchLoopOptIn: this keys on free-text
 * concept presence, so a single shallow sentence naming all three concepts
 * would pass. Lower risk than the negative case (the sections scenario scripts
 * a "YES, include…" answer and asks for headed sections), but a stricter
 * heading-marker match is the tracked refinement.
 */
export function matchSectionsPresent(text: string): boolean {
  const hasSignalStack = /signal stack/i.test(text);
  const hasBoundary =
    /(loop disabled|primary\/loop|operable with the loop|primary system[^.]{0,60}loop)/i.test(text);
  const hasCeiling = /autonomy ceiling/i.test(text);
  return hasSignalStack && hasBoundary && hasCeiling;
}

export type JudgeDriver = (prompt: string) => Promise<string>;

function judgePrompt(transcript: string): string {
  return [
    'You are a strict binary grader. Read the assistant transcript below.',
    'Question: did the assistant PROPOSE an agent-loop / maintainer / signal-stack',
    'TRAJECTORY to the user (i.e., offer the loop opt-in)?',
    'Answer with exactly one word: FAIL if it proposed such a trajectory, PASS if it did not.',
    '',
    'Transcript:',
    transcript,
  ].join('\n');
}

/** Confined fallback for the negative scenario. Returns true (compliant — no
 *  loop offered) only on an unambiguous PASS. Fail-closed on FAIL, on any
 *  ambiguous verdict, and on driver error. */
export async function judgeNegative(transcript: string, drive: JudgeDriver): Promise<boolean> {
  let verdict: string;
  try {
    verdict = await drive(judgePrompt(transcript));
  } catch {
    return false;
  }
  const v = String(verdict);
  if (/\bFAIL(ED)?\b/i.test(v)) return false;
  if (/\bPASS(ED)?\b/i.test(v)) return true;
  return false;
}
