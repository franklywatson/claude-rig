// v1 behavioral eval scenarios. Each drives a headless brain+ run against a
// fixture brief and asserts a model-robust behavioral invariant.
//
// The prompt deliberately instructs the model to do brain+'s assessment itself
// without dispatching subagents — this isolates the loop-fit elicitation under
// test and keeps the headless run reliable (see evals/spike-findings.md).

import type { Scenario } from './types.js';

const ASSESS_PROMPT =
  'Read the brief in BRIEF.md. Use the brain+ skill to begin designing this system. ' +
  "In THIS turn, do brain+'s context assessment and loop-fit assessment yourself " +
  '(do NOT dispatch any subagents), then end your turn by asking me the single most ' +
  "important next question per the skill's procedure.";

export const SCENARIOS: Scenario[] = [
  {
    id: 'loop-fit-positive',
    mode: 'positive',
    briefFile: 'evals/fixtures/loop-fit-positive.md',
    prompt: ASSESS_PROMPT,
    invariants: [
      {
        kind: 'loop-optin-present',
        description: 'brain+ offers the agent-loop trajectory for a fitting (headless/scheduled/model/long-lived) project',
      },
    ],
  },
  {
    id: 'loop-fit-negative',
    mode: 'negative',
    briefFile: 'evals/fixtures/loop-fit-negative.md',
    prompt: ASSESS_PROMPT,
    invariants: [
      {
        kind: 'loop-optin-absent',
        description: 'brain+ does NOT raise the loop trajectory for a one-off CLI tool',
      },
    ],
  },
  {
    id: 'loop-optin-sections',
    mode: 'sections',
    briefFile: 'evals/fixtures/loop-optin-sections.md',
    prompt:
      'Read the brief in BRIEF.md. Use the brain+ skill. This project fits the agent-loop ' +
      'pattern and I am telling you now: YES, include the signal stack and maintainer ' +
      'trajectory. In THIS turn (do NOT dispatch subagents), produce the design covering, ' +
      'with clear headings, the signal stack for each applicable layer, the primary/loop ' +
      'boundary (the primary system operable with the loop disabled), and the autonomy ceiling.',
    invariants: [
      {
        kind: 'sections-present',
        description: 'an opted-in design carries the signal stack, primary/loop boundary, and autonomy ceiling sections',
      },
    ],
  },
  {
    // Live-model reliability check for the Step 2.5 jcodemunch divert. Scaffolds
    // a fixture codebase, invites a symbol search (which the router diverts to
    // mcp__jcodemunch__search_symbols), and asserts the agent FOLLOWED the
    // advisory — i.e. an mcp__jcodemunch__ tool_use appears in the transcript.
    // The deterministic logic is covered by tests/router/; this is the
    // model-driven gap those tests cannot reach. Run: npm run eval -- --scenario
    // divert-jcodemunch-used (needs local claude auth + jcodemunch installed).
    id: 'divert-jcodemunch-used',
    mode: 'positive',
    briefFile: 'evals/fixtures/divert-positive.md',
    // Tool-neutral on purpose. The v1 prompt said "Use grep or rg to find …",
    // which contradicts the graded behavior: observed live (Opus 4.8,
    // 2026-11-22), the agent SAW the divert advisory, explicitly reasoned that
    // the user's tool mandate takes precedence over a hook advisory, and
    // declined — correctly. Grading "follows the divert" while instructing
    // "use grep" measured instruction-priority, not divert-following. The
    // prompt now asks for a search without naming a tool; a text search is
    // still the natural first move (Bash grep/rg → Step 2.5 divert, or the
    // native Grep tool → native_grep advisory), and following the advisory no
    // longer disobeys the user.
    prompt:
      'A small TypeScript project is in this directory (see BRIEF.md). Search the project ' +
      'for where the function `routeRequest` is defined, then state its parameter list.',
    invariants: [
      {
        kind: 'jcodemunch-tool-used',
        description: 'the agent follows the Step 2.5 divert and locates the symbol via an mcp__jcodemunch__ tool',
      },
    ],
    projectFiles: [
      { dest: 'src/router.ts', src: 'evals/fixtures/divert-project/src/router.ts' },
    ],
  },
];
