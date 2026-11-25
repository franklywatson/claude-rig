import type { EnforcementViolation, HarnessConfig } from '../types.js';

const scriptsByCommand = new Map<string, string[]>([
  ['npm run build && npm test', ['build', 'test']],
  ['npm test && npm run lint', ['test']],
  ['npx vitest run && npm run lint', []],
]);
const ADVICE = 'The combined command failed and its output contains a Vitest summary reporting a failure. ' +
  'Run the test step separately to confirm its own exit status.';

const TRUNCATION = [
  /\[\d+ characters truncated\]/,
  /(?:\.\.\. \d+ tokens truncated \.\.\.|… \+\d+ lines \(ctrl\+o to expand\))/,
  /output truncated to \d+ bytes/,
  /<persisted-output>/,
];
const BANNER = /^> (?:(\S+@[\w.+-]+) )?(\S+)$/;

function isLifecycleHeader(banner: RegExpMatchArray | null) {
  return banner !== null && (banner[1] !== undefined || /^(?:pre|post)?(?:build|test|lint)$/.test(banner[2]));
}

function testSection(lines: string[], scripts: string[]): string[] | null {
  let seen = 0;
  let start = 1;
  let pkg: string | undefined;
  for (let i = start; i < lines.length; i++) {
    const banner = lines[i].match(BANNER);
    if (!banner) continue;
    const echo = lines[i + 1];
    if (!/^> \S/.test(echo)) {
      if (isLifecycleHeader(banner)) return null;
      continue; // A diagnostic can contain a standalone "> text".
    }
    if (banner[2] !== scripts[seen] || (seen > 0 && pkg !== banner[1])) return null;
    if (isLifecycleHeader(echo.match(BANNER))) return null;
    pkg = banner[1];
    seen++;
    i++; // Skip the command echo.
    start = i + 1;
  }
  return seen === scripts.length ? lines.slice(start) : null;
}

function hasFailedSummary(lines: string[]): boolean {
  const markers: number[] = [];
  for (const [i, line] of lines.entries()) {
    if (/^[ \t]*(?:RUN[ \t]+v|(?:Test Files|Tests)(?=[: \t]|$))/.test(line)) markers.push(i);
  }
  const [header, files, tests] = markers;
  if (markers.length !== 3 || tests !== files + 1) return false;
  if (!/^[ \t]*RUN[ \t]+v\d+\.\d+\.\d+(?:[-+][\w.+-]+)?(?:[ \t]|$)/.test(lines[header])) return false;
  const row = lines[files].match(/^[ \t]*Test Files[ \t]+(.*)$/)?.[1];
  if (!row || !/\(\d+\)$/.test(row) || !/^[ \t]*Tests[ \t]+(?:\d|no tests$)/.test(lines[tests])) return false;
  return row.split('|').some(field => /^[ \t]*[1-9]\d*[ \t]+failed(?=[ \t]|$)/.test(field));
}

export function checkCompoundTestFailure(
  command: string, output: string, config: HarnessConfig,
): EnforcementViolation | null {
  if (config.rules.zero_defect?.unrelated_errors === 'silent') return null;
  const literal = command.replace(/[ \t]+/g, ' ').replace(/ ?&& ?/g, ' && ').replace(/^ | $/g, '');
  const scripts = scriptsByCommand.get(literal);
  if (!scripts || output.length > 128 * 1024) return null;
  const lines = output.split(/\r?\n/).map(line => line.replace(/\x1b\[[\d;:]*m/g, ''));
  if (!/^Exit code [1-9]\d*[ \t]*$/.test(lines[0])) return null;
  if (lines.some(line => /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/.test(line) ||
    TRUNCATION.some(marker => marker.test(line)))) return null;
  const section = testSection(lines, scripts);
  // A preceding step can replay these bytes. Only the combined status is known.
  return section && hasFailedSummary(section) ? { level: 'advise', message: ADVICE } : null;
}
