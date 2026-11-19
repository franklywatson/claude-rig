// A literal shell argument. Quotes allow spaces in paths, test names and filters.
// Shell expansions and redirects outside the supported grammar are ambiguous.
const word = String.raw`(?:[^\s;&|<>()$\x60\\"'#]+|'[^']*'|"[^"$\x60\\]*")`;
const prefix = new RegExp(String.raw`^(?:cd\s+${word}\s*&&\s*)?(?:[A-Za-z_]\w*=(?:${word})?\s+)*`);
const testCommands = [
  String.raw`(?:npx\s+)?(?:vitest|jest|pytest|mocha)`,
  String.raw`(?:npm|pnpm|yarn|bun)(?:\s+(?:-w|--prefix)\s+${word})?\s+(?:run\s+)?test(?::[\w:-]+)?`,
  String.raw`npm\s+t|(?:go|cargo)\s+test|python\s+-m\s+(?:pytest|unittest)`,
].join('|');
const args = String.raw`(?:\s+${word})*`;
const singleStep = new RegExp(String.raw`^(?:${testCommands})${args}(?:\s+2>&1)?(?:\s*\|\s*(?:tail|head|grep|tee)${args})?$`);

/** Recognize one test invocation, optionally followed by one output filter. */
export function isSingleTestCommand(command: string): boolean {
  // Bash separates words with spaces and tabs. A newline starts another command.
  if (/[^\S \t]/.test(command)) return false;
  return singleStep.test(command.trim().replace(prefix, ''));
}
