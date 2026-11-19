import { normalize } from 'node:path';

// Characters a tool-supplied path must not contain to be placed inside a
// double-quoted shell argument. Inside double quotes /bin/sh gives meaning to
// " $ ` and \; cmd.exe gives meaning to " and a newline ends its command line.
// The other ASCII control characters are rejected with it to keep the rule
// simple. Backslash, space, & | ; ' ( ) and non-ASCII stay out of this set on
// purpose: real paths contain them (Windows separators, "R&D", accented
// names). The two backslash cases that matter are checked separately below.
const UNSAFE_PATH_CHARS = /["$`\u0000-\u001f\u007f]/;

// Only cmd.exe expands % (variables) and ! (delayed expansion). /bin/sh leaves
// both alone inside double quotes, and real directories such as
// "/Users/x/100% done" must keep working there.
const WIN32_UNSAFE_PATH_CHARS = /[%!]/;

/**
 * Whether a tool-supplied directory path can be placed inside a double-quoted
 * shell command (`test -f "<p>"`, `graphify update "<p>"`, `jcodemunch
 * index_folder --path "<p>"`, and the report/benchmark reads) without changing
 * what it runs or which directory it names. A path is rejected when it is not
 * a non-empty string, contains a character in {@link UNSAFE_PATH_CHARS} (or, on
 * win32, `%` or `!`), ends with a backslash, contains a doubled backslash
 * outside Windows, or starts with `-` as given or once normalized (so it
 * cannot be read as a command option). For a rejected path the caller skips
 * the optional command and runs nothing.
 */
export function isShellQuotablePath(
  path: unknown,
  platform: NodeJS.Platform = process.platform,
): path is string {
  if (typeof path !== 'string' || path.length === 0) return false;
  // Next to the closing quote a backslash would escape it.
  if (path.endsWith('\\')) return false;
  // /bin/sh reads a doubled backslash inside double quotes as one, which would
  // name a different directory. cmd.exe keeps both (UNC paths start with two).
  if (platform !== 'win32' && path.includes('\\\\')) return false;
  // The commands receive the path both as given and joined (normalized).
  if (path.startsWith('-') || normalize(path).startsWith('-')) return false;
  if (platform === 'win32' && WIN32_UNSAFE_PATH_CHARS.test(path)) return false;
  return !UNSAFE_PATH_CHARS.test(path);
}
