
import { DiffFile, DiffChunk, SelfReviewConfig } from './types';

/**
 * Priority ordering for file review (lower number = reviewed first).
 *   0 – Security-sensitive (controllers, auth)
 *   1 – Routing / configuration
 *   2 – Domain logic (models, services, jobs)
 *   3 – Database (migrations, db/)
 *   4 – Views / templates
 *   5 – Tests / specs
 *   6 – Everything else
 */
function filePriority(filePath: string): number {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  const segments = p.split('/').filter(Boolean);
  const tokens = segments.flatMap(segment =>
    segment.split(/[^a-z0-9]+/).filter(Boolean)
  );

  const hasToken = (value: string) => tokens.includes(value);
  const hasAnyToken = (values: string[]) => values.some(hasToken);

  // Tests/specs should always be lowest priority, even if they mention controllers/auth.
  if (hasAnyToken(['test', 'tests', 'spec', 'specs'])) { return 5; }

  if (hasAnyToken(['controller', 'controllers', 'auth', 'authorization'])) { return 0; }
  if (hasAnyToken(['route', 'routes', 'config', 'configs'])) { return 1; }
  if (hasAnyToken(['model', 'models', 'service', 'services', 'job', 'jobs'])) { return 2; }
  if (hasAnyToken(['migration', 'migrations', 'db', 'database'])) { return 3; }
  if (hasAnyToken(['view', 'views', 'template', 'templates']) || p.includes('.erb') || p.includes('.html')) { return 4; }
  return 6;
}

/**
 * Build context strings for a file: the diff hunks plus surrounding file content.
 */
function buildFileContext(file: DiffFile, contextLines: number = 30): string {
  const parts: string[] = [];
  parts.push(`## File: ${file.path}${file.isNew ? ' (new)' : ''}${file.isDeleted ? ' (deleted)' : ''}`);

  if (file.fullContent && !file.isDeleted) {
    const fileLines = file.fullContent.split('\n');

    for (const hunk of file.hunks) {
      const start = Math.max(0, hunk.newStart - 1 - contextLines);
      const end = Math.min(fileLines.length, hunk.newStart - 1 + hunk.newLines + contextLines);
      const contextSlice = fileLines.slice(start, end);
      const addedSet = new Set(hunk.addedLines);

      parts.push(`\n### Hunk at line ${hunk.newStart} ${hunk.header}`);
      parts.push('```');
      contextSlice.forEach((line, idx) => {
        const lineNum = start + idx + 1;
        const isAdded = addedSet.has(lineNum);
        const prefix = isAdded ? '+' : ' ';
        parts.push(`${prefix}${String(lineNum).padStart(5)} | ${line}`);
      });
      parts.push('```');
    }
  } else {
    // No full content available — use raw diff
    for (const hunk of file.hunks) {
      parts.push(`\n### Diff hunk at line ${hunk.newStart}`);
      parts.push('```diff');
      parts.push(hunk.content);
      parts.push('```');
    }
  }

  return parts.join('\n');
}

/**
 * Estimate token count from a string.
 * Uses a rough heuristic (~3.5 chars per token) as a fallback.
 * When a model is available, use model.countTokens() for accuracy.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Chunks diff files into batches sized for AI model token limits.
 *
 * Strategy:
 * - Sort files by priority (security-sensitive first)
 * - Group files into chunks that fit within the token budget
 * - Large files get their own chunk (split across hunks if needed)
 */
export function chunkDiffFiles(
  files: DiffFile[],
  config: SelfReviewConfig,
  tokenBudget: number = 40_000
): DiffChunk[] {
  // Filter out files with no hunks (binary, no changes)
  const reviewable = files.filter(f => f.hunks.length > 0 && !f.isBinary);

  // Sort by priority
  const sorted = [...reviewable].sort((a, b) => filePriority(a.path) - filePriority(b.path));

  const chunks: DiffChunk[] = [];
  let currentFiles: DiffFile[] = [];
  let currentTokens = 0;

  for (const file of sorted) {
    const context = buildFileContext(file);
    const tokens = estimateTokens(context);

    // If this single file exceeds the budget, give it its own chunk
    if (tokens > tokenBudget) {
      // Flush current chunk
      if (currentFiles.length > 0) {
        chunks.push({ files: currentFiles, tokenEstimate: currentTokens });
        currentFiles = [];
        currentTokens = 0;
      }
      chunks.push({ files: [file], tokenEstimate: tokens });
      continue;
    }

    // If adding this file exceeds the budget or max files, start a new chunk
    if (
      currentTokens + tokens > tokenBudget ||
      currentFiles.length >= config.maxFilesPerChunk
    ) {
      if (currentFiles.length > 0) {
        chunks.push({ files: currentFiles, tokenEstimate: currentTokens });
      }
      currentFiles = [file];
      currentTokens = tokens;
    } else {
      currentFiles.push(file);
      currentTokens += tokens;
    }
  }

  // Flush remaining
  if (currentFiles.length > 0) {
    chunks.push({ files: currentFiles, tokenEstimate: currentTokens });
  }

  return chunks;
}

/**
 * Build the full context string for a chunk, ready to be sent to the AI.
 */
export function buildChunkContext(chunk: DiffChunk): string {
  return chunk.files.map(f => buildFileContext(f)).join('\n\n---\n\n');
}
