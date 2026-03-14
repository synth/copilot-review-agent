import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const execAsync = promisify(exec);

/** Maximum lines returned by a single tool invocation */
const MAX_RESULT_LINES = 500;
/** Maximum matches returned by search_codebase */
const MAX_SEARCH_MATCHES = 50;

// ──────────────────────────────────────────────
// Tool schemas (LanguageModelChatTool format)
// ──────────────────────────────────────────────

export const REVIEW_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: 'search_codebase',
    description:
      'Search the codebase for a pattern using git grep. Returns matching lines with file paths and line numbers. Use this to find references, callers, or usages of symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The search pattern (basic regex supported).',
        },
        fileGlob: {
          type: 'string',
          description: 'Optional glob to restrict search to specific files, e.g. "*.ts" or "src/**/*.py".',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file_section',
    description:
      'Read a section of a file by line range. Returns the file content with line numbers. Use this to examine code around a specific location.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path from the repository root.',
        },
        startLine: {
          type: 'number',
          description: 'Start line number (1-based, inclusive).',
        },
        endLine: {
          type: 'number',
          description: 'End line number (1-based, inclusive).',
        },
      },
      required: ['path', 'startLine', 'endLine'],
    },
  },
  {
    name: 'check_symbol_usage',
    description:
      'Check how many times a symbol (function, class, variable name) is referenced in the codebase. Returns the count and sample locations. Use this to verify if something is actually used.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'The exact symbol name to search for.',
        },
        fileGlob: {
          type: 'string',
          description: 'Optional glob to restrict search, e.g. "*.ts".',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_file_outline',
    description:
      'Get a structural outline of a file: class definitions, function/method signatures, exports, and imports. Use this to understand file structure without reading every line.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path from the repository root.',
        },
      },
      required: ['path'],
    },
  },
];

// ──────────────────────────────────────────────
// Tool execution handlers
// ──────────────────────────────────────────────

export interface ToolCallInput {
  [key: string]: unknown;
}

/**
 * Execute a tool by name and return a text result.
 * All results are truncated to MAX_RESULT_LINES to stay within token budgets.
 */
export async function executeTool(
  toolName: string,
  input: ToolCallInput,
  workspacePath: string
): Promise<string> {
  switch (toolName) {
    case 'search_codebase':
      return executeSearchCodebase(input, workspacePath);
    case 'read_file_section':
      return executeReadFileSection(input, workspacePath);
    case 'check_symbol_usage':
      return executeCheckSymbolUsage(input, workspacePath);
    case 'get_file_outline':
      return executeGetFileOutline(input, workspacePath);
    default:
      return `Unknown tool: ${toolName}`;
  }
}

function escapeShellArg(arg: string): string {
  // Wrap in single quotes, escape any embedded single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

async function executeSearchCodebase(input: ToolCallInput, workspacePath: string): Promise<string> {
  const pattern = String(input.pattern || '');
  if (!pattern) { return 'Error: pattern is required'; }

  const fileGlob = input.fileGlob ? String(input.fileGlob) : undefined;

  // Use git grep with line numbers; -m limits matches per file at the source
  let raw: string;
  try {
    const globArgs = fileGlob ? `-- ${escapeShellArg(fileGlob)}` : '';
    const cmd = `git grep -n -I --no-color -m ${MAX_SEARCH_MATCHES} -- ${escapeShellArg(pattern)} ${globArgs}`;
    const { stdout } = await execAsync(cmd, {
      cwd: workspacePath,
      maxBuffer: 1024 * 1024,
    });
    raw = stdout.trim();
  } catch (err: any) {
    if (err.code === 1) { return 'No matches found.'; }
    return `Search error: ${err.message}`;
  }

  if (!raw) { return 'No matches found.'; }

  const lines = raw.split('\n');
  const total = lines.length;
  const truncated = lines.slice(0, MAX_SEARCH_MATCHES);
  let result = truncated.join('\n');
  if (total > MAX_SEARCH_MATCHES) {
    result += `\n\n... (${total - MAX_SEARCH_MATCHES} more matches truncated, ${total} total)`;
  }
  return result;
}

async function executeReadFileSection(input: ToolCallInput, workspacePath: string): Promise<string> {
  const relPath = String(input.path || '');
  if (!relPath) { return 'Error: path is required'; }

  // Prevent path traversal
  const resolved = path.resolve(workspacePath, relPath);
  if (!resolved.startsWith(workspacePath)) {
    return 'Error: path must be within the workspace';
  }

  try {
    await fs.promises.access(resolved);
  } catch {
    return `Error: file not found: ${relPath}`;
  }

  const startLine = Number(input.startLine) || 1;
  const endLine = Number(input.endLine) || startLine + 200;
  const clampedEnd = Math.min(endLine, startLine + MAX_RESULT_LINES - 1);

  const collected: string[] = [];
  let lineNum = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(resolved, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      lineNum++;
      if (lineNum >= startLine && lineNum <= clampedEnd) {
        collected.push(`${String(lineNum).padStart(5)} | ${line}`);
      }
      if (lineNum >= clampedEnd) {
        rl.close();
      }
    });
    rl.on('close', () => {
      stream.destroy();
      resolve();
    });
    rl.on('error', (err) => {
      stream.destroy();
      reject(err);
    });
  });

  let result = collected.join('\n');
  if (clampedEnd < endLine) {
    result += `\n\n... (truncated at ${MAX_RESULT_LINES} lines)`;
  }
  return result;
}

async function executeCheckSymbolUsage(input: ToolCallInput, workspacePath: string): Promise<string> {
  const symbol = String(input.symbol || '');
  if (!symbol) { return 'Error: symbol is required'; }

  const fileGlob = input.fileGlob ? String(input.fileGlob) : undefined;

  const globArgs = fileGlob ? `-- ${escapeShellArg(fileGlob)}` : '';
  const escapedSymbol = escapeShellArg(symbol);

  // Use git grep -c (count mode) to get per-file counts without buffering all lines
  let countRaw: string;
  try {
    const countCmd = `git grep -w -c -I --no-color -- ${escapedSymbol} ${globArgs}`;
    const { stdout } = await execAsync(countCmd, {
      cwd: workspacePath,
      maxBuffer: 1024 * 1024,
    });
    countRaw = stdout.trim();
  } catch (err: any) {
    if (err.code === 1) { return `Symbol "${symbol}": 0 references found.`; }
    return `Search error: ${err.message}`;
  }

  if (!countRaw) { return `Symbol "${symbol}": 0 references found.`; }

  // Parse per-file counts from "file:count" lines
  let totalCount = 0;
  const fileCounts: Array<{ file: string; count: number }> = [];
  for (const line of countRaw.split('\n')) {
    const match = line.match(/^(.+):(\d+)$/);
    if (match) {
      const count = Number(match[2]);
      totalCount += count;
      fileCounts.push({ file: match[1], count });
    }
  }

  // Fetch a small set of sample locations with -m 10 to limit output
  let sampleLines = '';
  try {
    const sampleCmd = `git grep -w -n -I --no-color -m 10 -- ${escapedSymbol} ${globArgs}`;
    const { stdout } = await execAsync(sampleCmd, {
      cwd: workspacePath,
      maxBuffer: 512 * 1024,
    });
    const sampleRaw = stdout.trim();
    if (sampleRaw) {
      sampleLines = '\n\nSample locations:\n' + sampleRaw.split('\n').slice(0, 10).join('\n');
    }
  } catch {
    // Non-critical; proceed without samples
  }

  const summary = `Symbol "${symbol}": ${totalCount} reference${totalCount !== 1 ? 's' : ''} across ${fileCounts.length} file${fileCounts.length !== 1 ? 's' : ''}.`;
  const breakdown = fileCounts
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map(fc => `  ${fc.file}: ${fc.count}`)
    .join('\n');

  return `${summary}\n\n${breakdown}${sampleLines}`;
}

// Pre-compiled outline patterns with keyword pre-filters.
// Tested in order; first match wins.
interface OutlinePattern {
  regex: RegExp;
  label: string;
  /** Trimmed line must start with one of these before regex is tested. */
  prefixes: string[];
}

const OUTLINE_PATTERNS: readonly OutlinePattern[] = [
  // Imports
  { regex: /^\s*(import\s|from\s|require\s*\(|const\s+\w+\s*=\s*require)/, label: 'import', prefixes: ['import ', 'from ', 'require', 'const '] },
  // Exports
  { regex: /^\s*export\s+(default\s+)?(class|function|const|let|var|interface|type|enum|abstract)/, label: 'export', prefixes: ['export '] },
  { regex: /^\s*module\.exports/, label: 'export', prefixes: ['module'] },
  // Class / interface / enum
  { regex: /^\s*(export\s+)?(abstract\s+)?class\s+\w+/, label: 'class', prefixes: ['export ', 'abstract ', 'class '] },
  { regex: /^\s*(export\s+)?interface\s+\w+/, label: 'interface', prefixes: ['export ', 'interface '] },
  { regex: /^\s*(export\s+)?enum\s+\w+/, label: 'enum', prefixes: ['export ', 'enum '] },
  // Functions
  { regex: /^\s*(export\s+)?(async\s+)?function\s+\w+/, label: 'function', prefixes: ['export ', 'async ', 'function '] },
  { regex: /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/, label: 'function', prefixes: ['export ', 'const ', 'let ', 'var '] },
  // Class methods (JS/TS)
  { regex: /^\s*(public|private|protected|static|async|get|set|\*)\s+\w+\s*[\(<]/, label: 'method', prefixes: ['public ', 'private ', 'protected ', 'static ', 'async ', 'get ', 'set ', '*'] },
  // Python def
  { regex: /^\s*(async\s+)?def\s+\w+/, label: 'function', prefixes: ['async ', 'def '] },
  // Ruby / Python class / module
  { regex: /^\s*(class|module)\s+[A-Z]\w*/, label: 'class', prefixes: ['class ', 'module '] },
  // Go func
  { regex: /^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/, label: 'function', prefixes: ['func '] },
];

async function executeGetFileOutline(input: ToolCallInput, workspacePath: string): Promise<string> {
  const relPath = String(input.path || '');
  if (!relPath) { return 'Error: path is required'; }

  const resolved = path.resolve(workspacePath, relPath);
  if (!resolved.startsWith(workspacePath)) {
    return 'Error: path must be within the workspace';
  }

  let stat: Awaited<ReturnType<typeof fs.promises.stat>>;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return `Error: file not found: ${relPath}`;
  }

  if (stat.size > 1_000_000) {
    return `Error: file too large for outline (${(stat.size / 1024).toFixed(0)} KB). Use read_file_section instead.`;
  }

  let content: string;
  try {
    content = await fs.promises.readFile(resolved, "utf-8");
  } catch (err) {
    return `Error reading file "${resolved}": ${err instanceof Error ? err.message : String(err)}`;
  }

  const lines = content.split('\n');
  const outline: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trimStart();

    for (const { regex, label, prefixes } of OUTLINE_PATTERNS) {
      if (prefixes.some(p => trimmed.startsWith(p)) && regex.test(line)) {
        outline.push(`${String(lineNum).padStart(5)} | [${label}] ${line.trim()}`);
        break;
      }
    }
  }

  if (outline.length === 0) {
    return `File outline for ${relPath}: (no structural elements detected)`;
  }

  return `File outline for ${relPath}:\n\n${outline.join('\n')}`;
}
