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

const braceWarned = new Set<string>();
const MAX_BRACE_WARNING_CACHE = 100;
let braceLimitWarned = false;

const regexCache = new Map<string, RegExp>();
const MAX_REGEX_CACHE = 100;

/** Clears the brace-warning state. Useful when re-running tests in the same process. */
export function resetWarnings(): void {
  braceWarned.clear();
  braceLimitWarned = false;
  regexCache.clear();
}

export function minimatch(filePath: string, pattern: string): boolean {
  if (pattern.includes('{') && !braceWarned.has(pattern)) {
    if (braceWarned.size < MAX_BRACE_WARNING_CACHE) {
      braceWarned.add(pattern);
      console.warn(
        `[copilot-review-agent] Glob pattern "${pattern}" contains "{" which looks like brace expansion. ` +
        `Brace expansion is not supported — the pattern will be matched literally.`
      );
    } else if (!braceLimitWarned) {
      braceLimitWarned = true;
      console.warn(
        `[copilot-review-agent] Further brace-expansion warnings suppressed (more than ${MAX_BRACE_WARNING_CACHE} distinct patterns seen). ` +
        `These patterns are still matched literally, not expanded.`
      );
    }
  }

  const regex = globToRegex(pattern);
  return regex.test(filePath);
}

/**
 * Escape a single character if it is special in a regular expression.
 * Covers the full set of RegExp-special characters:
 *   \ ^ $ . + ( ) [ ] { } | -
 * `*` and `?` are intentionally omitted — they are glob metacharacters
 * consumed by the parser above and must not be re-escaped here.
 */
const REGEX_SPECIAL = /[-\\^$.+()[\]{}|]/g;

function globToRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) {
    return cached;
  }

  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` — matches zero or more directory segments.
          //   `**/foo.ts`  → matches `foo.ts` and `dir/foo.ts`
          //   `foo/**/bar` → matches `foo/bar` and `foo/x/bar`
          regexStr += '(?:.*/)?';
          i += 3;
        } else {
          // `**` without trailing `/` — matches any characters
          // including `/` (greedy, to end of path).
          //   `foo/**` → matches `foo/`, `foo/a`, `foo/a/b`
          //   `**`     → matches every path
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

  const regex = new RegExp(`^${regexStr}$`);
  if (regexCache.size < MAX_REGEX_CACHE) {
    regexCache.set(pattern, regex);
  }
  return regex;
}
