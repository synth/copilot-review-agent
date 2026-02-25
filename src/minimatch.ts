/**
 * Minimal glob/minimatch implementation for path matching.
 *
 * Supported syntax:
 *  - `*`   matches any characters except `/`
 *  - `**`  matches any characters including `/` (any depth)
 *  - `?`   matches a single character except `/`
 *
 * **Not supported:** brace expansion (`{a,b}`), extglobs (`@(…)`),
 * character classes (`[abc]`), negation (`!`).
 * Patterns containing `{` are treated as literal text and a
 * diagnostic warning is logged on first occurrence.
 */

let braceWarningEmitted = false;

export function minimatch(filePath: string, pattern: string): boolean {
  if (!braceWarningEmitted && pattern.includes('{')) {
    braceWarningEmitted = true;
    console.warn(
      `[self-review] Glob pattern "${pattern}" contains "{" which looks like brace expansion. ` +
      `Brace expansion is not supported — the pattern will be matched literally.`
    );
  }

  const regex = globToRegex(pattern);
  return regex.test(filePath);
}

/**
 * Escape a single character if it is special in a regular expression.
 * Covers the full set of RegExp-special characters:
 *   \ ^ $ . * + ? ( ) [ ] { } | -
 * `*` and `?` are handled by the glob parser above, so they never
 * reach this helper during normal operation.
 */
const REGEX_SPECIAL = /[-\\^$.*+?()[\]{}|]/g;

function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any number of directories
        if (pattern[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        // * matches anything except /
        regexStr += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      regexStr += '[^/]';
      i++;
    } else {
      regexStr += c.replace(REGEX_SPECIAL, '\\$&');
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`);
}
