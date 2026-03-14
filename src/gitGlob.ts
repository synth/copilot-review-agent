/**
 * Convert a user-provided file glob into a git pathspec with glob magic.
 * This preserves recursive patterns when passed to git grep.
 */
export function toGitGlobPathspec(fileGlob: string): string {
  const normalized = fileGlob.replace(/\\/g, '/').replace(/^\.\//, '');
  return `:(glob)${normalized}`;
}