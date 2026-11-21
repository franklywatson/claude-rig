// A literal shell argument. Quotes allow spaces in paths, test names and filters.
// Shell expansions and redirects outside the supported grammar are ambiguous.
const word = String.raw`(?:[^\s;&|<>()$\x60\\"'#]|\\.|'[^']*'|"(?:[^"$\x60\\]|\\.)*")+`;
const prefix = new RegExp(String.raw`^(?:cd\s+${word}\s*&&\s*)?(?:[A-Za-z_]\w*=(?:${word})?\s+)*`);
// Direct executables may live in a project venv or node_modules/.bin.
const directory = String.raw`(?:[\w.@+/\-]*/)?`;
const testCommands = [
  String.raw`(?:npx\s+|${directory})(?:vitest|jest|pytest|mocha)`,
  String.raw`(?:npm|pnpm|yarn|bun)(?:\s+(?:-w|--prefix)\s+${word})?\s+(?:run\s+)?test(?::[\w:-]+)?`,
  String.raw`npm\s+t|(?:go|cargo)\s+test|${directory}python\s+-m\s+(?:pytest|unittest)`,
].join('|');
const args = String.raw`(?:\s+${word})*`;
const singleStep = new RegExp(String.raw`^(?:${testCommands})${args}(?:\s+2>&1)?(?:\s*\|\s*(?:tail|head|tee)${args})?$`);

/**
 * Recognize one test invocation, optionally followed by one output filter.
 * grep is not accepted as a filter: it exits 1 when nothing matches, so a
 * passing run piped to grep would reach the failure hook as a test failure.
 */
export function isSingleTestCommand(command: string): boolean {
  // Bash separates words with spaces and tabs. A newline starts another command.
  if (/[^\S \t]/.test(command)) return false;
  return singleStep.test(command.trim().replace(prefix, ''));
}
