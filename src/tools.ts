import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
export function executeTool(
  toolName: string,
  input: ToolCallInput,
  workspacePath: string
): string {
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

function gitGrep(pattern: string, workspacePath: string, extraArgs: string = ''): string {
  try {
    // Use -I to skip binary files, --no-color for clean output
    const cmd = `git grep -n -I --no-color ${extraArgs} -- ${escapeShellArg(pattern)}`;
    return execSync(cmd, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    }).trim();
  } catch (err: any) {
    // git grep returns exit code 1 when no matches found — that's not an error
    if (err.status === 1) { return ''; }
    throw err;
  }
}

function escapeShellArg(arg: string): string {
  // Wrap in single quotes, escape any embedded single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function executeSearchCodebase(input: ToolCallInput, workspacePath: string): string {
  const pattern = String(input.pattern || '');
  if (!pattern) { return 'Error: pattern is required'; }

  const fileGlob = input.fileGlob ? String(input.fileGlob) : undefined;
  const extraArgs = fileGlob ? `-- ${escapeShellArg(fileGlob)}` : '';

  // Use git grep with line numbers
  let raw: string;
  try {
    const globArgs = fileGlob ? `-- ${escapeShellArg(fileGlob)}` : '';
    const cmd = `git grep -n -I --no-color -- ${escapeShellArg(pattern)} ${globArgs}`;
    raw = execSync(cmd, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    }).trim();
  } catch (err: any) {
    if (err.status === 1) { return 'No matches found.'; }
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

function executeReadFileSection(input: ToolCallInput, workspacePath: string): string {
  const relPath = String(input.path || '');
  if (!relPath) { return 'Error: path is required'; }

  // Prevent path traversal
  const resolved = path.resolve(workspacePath, relPath);
  if (!resolved.startsWith(workspacePath)) {
    return 'Error: path must be within the workspace';
  }

  if (!fs.existsSync(resolved)) {
    return `Error: file not found: ${relPath}`;
  }

  const startLine = Number(input.startLine) || 1;
  const endLine = Number(input.endLine) || startLine + 200;
  const clampedEnd = Math.min(endLine, startLine + MAX_RESULT_LINES - 1);

  const content = fs.readFileSync(resolved, 'utf-8');
  const allLines = content.split('\n');
  const slice = allLines.slice(startLine - 1, clampedEnd);

  const numbered = slice.map((line, idx) => `${String(startLine + idx).padStart(5)} | ${line}`);
  let result = numbered.join('\n');
  if (clampedEnd < endLine) {
    result += `\n\n... (truncated at ${MAX_RESULT_LINES} lines)`;
  }
  return result;
}

function executeCheckSymbolUsage(input: ToolCallInput, workspacePath: string): string {
  const symbol = String(input.symbol || '');
  if (!symbol) { return 'Error: symbol is required'; }

  const fileGlob = input.fileGlob ? String(input.fileGlob) : undefined;

  // Use git grep -c to count occurrences per file
  let raw: string;
  try {
    const globArgs = fileGlob ? `-- ${escapeShellArg(fileGlob)}` : '';
    const cmd = `git grep -c -I --no-color -- ${escapeShellArg(symbol)} ${globArgs}`;
    raw = execSync(cmd, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    }).trim();
  } catch (err: any) {
    if (err.status === 1) { return `Symbol "${symbol}": 0 references found.`; }
    return `Search error: ${err.message}`;
  }

  if (!raw) { return `Symbol "${symbol}": 0 references found.`; }

  const fileLines = raw.split('\n').filter(Boolean);
  let totalCount = 0;
  const fileCounts: Array<{ file: string; count: number }> = [];

  for (const line of fileLines) {
    const match = line.match(/^(.+):(\d+)$/);
    if (match) {
      const count = parseInt(match[2], 10);
      totalCount += count;
      fileCounts.push({ file: match[1], count });
    }
  }

  // Also get a few sample lines with context
  let sampleLines = '';
  try {
    const globArgs = fileGlob ? `-- ${escapeShellArg(fileGlob)}` : '';
    const cmd = `git grep -n -I --no-color -- ${escapeShellArg(symbol)} ${globArgs}`;
    const sampleRaw = execSync(cmd, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    }).trim();
    const lines = sampleRaw.split('\n').slice(0, 10);
    sampleLines = '\n\nSample locations:\n' + lines.join('\n');
  } catch {
    // ignore
  }

  const summary = `Symbol "${symbol}": ${totalCount} reference${totalCount !== 1 ? 's' : ''} across ${fileCounts.length} file${fileCounts.length !== 1 ? 's' : ''}.`;
  const breakdown = fileCounts
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map(fc => `  ${fc.file}: ${fc.count}`)
    .join('\n');

  return `${summary}\n\n${breakdown}${sampleLines}`;
}

function executeGetFileOutline(input: ToolCallInput, workspacePath: string): string {
  const relPath = String(input.path || '');
  if (!relPath) { return 'Error: path is required'; }

  const resolved = path.resolve(workspacePath, relPath);
  if (!resolved.startsWith(workspacePath)) {
    return 'Error: path must be within the workspace';
  }

  if (!fs.existsSync(resolved)) {
    return `Error: file not found: ${relPath}`;
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  const lines = content.split('\n');
  const outline: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Imports
    if (/^\s*(import\s|from\s|require\s*\(|const\s+\w+\s*=\s*require)/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [import] ${line.trim()}`);
      continue;
    }

    // Exports
    if (/^\s*export\s+(default\s+)?(class|function|const|let|var|interface|type|enum|abstract)/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [export] ${line.trim()}`);
      continue;
    }
    if (/^\s*module\.exports/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [export] ${line.trim()}`);
      continue;
    }

    // Class / interface / enum definitions
    if (/^\s*(export\s+)?(abstract\s+)?class\s+\w+/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [class] ${line.trim()}`);
      continue;
    }
    if (/^\s*(export\s+)?interface\s+\w+/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [interface] ${line.trim()}`);
      continue;
    }
    if (/^\s*(export\s+)?enum\s+\w+/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [enum] ${line.trim()}`);
      continue;
    }

    // Function / method definitions (JS/TS, Python, Ruby, Go, Java, C#)
    if (/^\s*(export\s+)?(async\s+)?function\s+\w+/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [function] ${line.trim()}`);
      continue;
    }
    // Arrow functions assigned to const/let
    if (/^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [function] ${line.trim()}`);
      continue;
    }
    // Class methods (JS/TS): includes async, static, private, public, protected, get, set
    if (/^\s*(public|private|protected|static|async|get|set|\*)\s+\w+\s*[\(<]/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [method] ${line.trim()}`);
      continue;
    }
    // Shorthand method in class body: methodName( or methodName<
    if (/^\s+\w+\s*[\(<]/.test(line) && /[{,]\s*$/.test(lines[i - 1] || '')) {
      // Skip — too noisy
    }

    // Python: def / class
    if (/^\s*(async\s+)?def\s+\w+/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [function] ${line.trim()}`);
      continue;
    }
    if (/^\s*class\s+\w+/.test(line) && !outline[outline.length - 1]?.includes(line.trim())) {
      outline.push(`${String(lineNum).padStart(5)} | [class] ${line.trim()}`);
      continue;
    }

    // Ruby: def / class / module
    if (/^\s*def\s+\w+/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [method] ${line.trim()}`);
      continue;
    }
    if (/^\s*(class|module)\s+[A-Z]\w*/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [class] ${line.trim()}`);
      continue;
    }

    // Go: func
    if (/^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/.test(line)) {
      outline.push(`${String(lineNum).padStart(5)} | [function] ${line.trim()}`);
      continue;
    }
  }

  if (outline.length === 0) {
    return `File outline for ${relPath}: (no structural elements detected)`;
  }

  return `File outline for ${relPath}:\n\n${outline.join('\n')}`;
}
