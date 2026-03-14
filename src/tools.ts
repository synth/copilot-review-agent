import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

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

/**
 * Resolve a relative path to a workspace URI, rejecting traversal attempts.
 * Returns undefined if the path escapes the workspace.
 */
function resolveWorkspaceUri(workspacePath: string, relPath: string): vscode.Uri | undefined {
  const workspaceRoot = path.resolve(workspacePath);
  const resolved = path.resolve(workspaceRoot, relPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return vscode.Uri.file(resolved);
}

async function executeSearchCodebase(input: ToolCallInput, workspacePath: string): Promise<string> {
  const pattern = String(input.pattern || '');
  if (!pattern) { return 'Error: pattern is required'; }

  const fileGlob = input.fileGlob ? String(input.fileGlob) : undefined;

  // Use execFile with argv array — no shell, no quoting issues, correct argument order
  let raw: string;
  try {
    const args = [
      'grep', '-n', '-I', '--no-color',
      '-m', String(MAX_SEARCH_MATCHES),
      '-e', pattern,
    ];
    if (fileGlob) {
      args.push('--', fileGlob);
    }
    const { stdout } = await execFileAsync('git', args, {
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

  const fileUri = resolveWorkspaceUri(workspacePath, relPath);
  if (!fileUri) {
    return 'Error: path must be within the workspace';
  }

  let rawBytes: Uint8Array;
  try {
    rawBytes = await vscode.workspace.fs.readFile(fileUri);
  } catch {
    return `Error: file not found: ${relPath}`;
  }

  const content = Buffer.from(rawBytes).toString('utf-8');
  const allLines = content.split('\n');

  const startLine = Number(input.startLine) || 1;
  const endLine = Number(input.endLine) || startLine + 200;
  const clampedEnd = Math.min(endLine, startLine + MAX_RESULT_LINES - 1, allLines.length);

  const collected: string[] = [];
  for (let i = Math.max(startLine, 1); i <= clampedEnd; i++) {
    collected.push(`${String(i).padStart(5)} | ${allLines[i - 1]}`);
  }

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

  // Try VS Code reference provider first for semantic accuracy
  const lspResult = await tryLspReferenceCount(workspacePath, symbol);
  if (lspResult) { return lspResult; }

  // Fallback: use git grep with execFile (argv array, no shell)
  const countArgs = ['grep', '-w', '-c', '-I', '--no-color', '-e', symbol];
  if (fileGlob) { countArgs.push('--', fileGlob); }

  let countRaw: string;
  try {
    const { stdout } = await execFileAsync('git', countArgs, {
      cwd: workspacePath,
      maxBuffer: 1024 * 1024,
    });
    countRaw = stdout.trim();
  } catch (err: any) {
    if (err.code === 1) { return `Symbol "${symbol}": 0 references found.`; }
    return `Search error: ${err.message}`;
  }

  if (!countRaw) { return `Symbol "${symbol}": 0 references found.`; }

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

  // Fetch sample locations
  let sampleLines = '';
  try {
    const sampleArgs = ['grep', '-w', '-n', '-I', '--no-color', '-m', '10', '-e', symbol];
    if (fileGlob) { sampleArgs.push('--', fileGlob); }
    const { stdout } = await execFileAsync('git', sampleArgs, {
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

/**
 * Attempt to count symbol references via the VS Code reference provider (LSP).
 * Returns a formatted result string, or undefined if no references could be resolved
 * (e.g., no language server available, symbol not found in any open/indexed file).
 */
async function tryLspReferenceCount(workspacePath: string, symbol: string): Promise<string | undefined> {
  try {
    // Search for files containing the symbol to find a starting position
    const args = ['grep', '-w', '-n', '-I', '--no-color', '-m', '1', '-e', symbol];
    const { stdout } = await execFileAsync('git', args, {
      cwd: workspacePath,
      maxBuffer: 256 * 1024,
    });
    const firstMatch = stdout.trim().split('\n')[0];
    if (!firstMatch) { return undefined; }

    const matchParts = firstMatch.match(/^(.+?):(\d+):/);
    if (!matchParts) { return undefined; }

    const filePath = matchParts[1];
    const lineNum = Number(matchParts[2]) - 1;
    const fileUri = vscode.Uri.file(path.resolve(workspacePath, filePath));

    // Open the document to get the exact column position
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const lineText = doc.lineAt(lineNum).text;
    const col = lineText.indexOf(symbol);
    if (col < 0) { return undefined; }

    const position = new vscode.Position(lineNum, col);
    const locations: vscode.Location[] = await vscode.commands.executeCommand(
      'vscode.executeReferenceProvider',
      fileUri,
      position
    );

    if (!locations || locations.length === 0) { return undefined; }

    // Group by file
    const byFile = new Map<string, number>();
    for (const loc of locations) {
      const rel = path.relative(workspacePath, loc.uri.fsPath);
      byFile.set(rel, (byFile.get(rel) || 0) + 1);
    }

    const totalCount = locations.length;
    const summary = `Symbol "${symbol}": ${totalCount} reference${totalCount !== 1 ? 's' : ''} across ${byFile.size} file${byFile.size !== 1 ? 's' : ''} (via language server).`;
    const breakdown = [...byFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([file, count]) => `  ${file}: ${count}`)
      .join('\n');

    const samples = locations.slice(0, 10).map(loc => {
      const rel = path.relative(workspacePath, loc.uri.fsPath);
      return `${rel}:${loc.range.start.line + 1}`;
    });
    const sampleLines = samples.length > 0 ? '\n\nSample locations:\n' + samples.join('\n') : '';

    return `${summary}\n\n${breakdown}${sampleLines}`;
  } catch {
    return undefined;
  }
}

async function executeGetFileOutline(input: ToolCallInput, workspacePath: string): Promise<string> {
  const relPath = String(input.path || '');
  if (!relPath) { return 'Error: path is required'; }

  const fileUri = resolveWorkspaceUri(workspacePath, relPath);
  if (!fileUri) {
    return 'Error: path must be within the workspace';
  }

  // Try VS Code document symbol provider first (AST-based, language-server-aware)
  const lspOutline = await tryLspOutline(fileUri, relPath);
  if (lspOutline) { return lspOutline; }

  // Fallback: regex-based outline for files without language server support
  return executeRegexOutline(fileUri, relPath);
}

/**
 * Try to get a file outline via the VS Code document symbol provider.
 * Returns formatted outline, or undefined if no symbols are available.
 */
async function tryLspOutline(fileUri: vscode.Uri, relPath: string): Promise<string | undefined> {
  try {
    const symbols: vscode.DocumentSymbol[] = await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      fileUri
    );

    if (!symbols || symbols.length === 0) { return undefined; }

    const outline: string[] = [];
    const kindLabel = (kind: vscode.SymbolKind): string => {
      const map: Record<number, string> = {
        [vscode.SymbolKind.File]: 'file',
        [vscode.SymbolKind.Module]: 'module',
        [vscode.SymbolKind.Namespace]: 'namespace',
        [vscode.SymbolKind.Package]: 'package',
        [vscode.SymbolKind.Class]: 'class',
        [vscode.SymbolKind.Method]: 'method',
        [vscode.SymbolKind.Property]: 'property',
        [vscode.SymbolKind.Field]: 'field',
        [vscode.SymbolKind.Constructor]: 'constructor',
        [vscode.SymbolKind.Enum]: 'enum',
        [vscode.SymbolKind.Interface]: 'interface',
        [vscode.SymbolKind.Function]: 'function',
        [vscode.SymbolKind.Variable]: 'variable',
        [vscode.SymbolKind.Constant]: 'constant',
        [vscode.SymbolKind.TypeParameter]: 'type-param',
      };
      return map[kind] || 'symbol';
    };

    const flatten = (syms: vscode.DocumentSymbol[], indent: number) => {
      for (const sym of syms) {
        const lineNum = sym.range.start.line + 1;
        const prefix = '  '.repeat(indent);
        outline.push(`${String(lineNum).padStart(5)} | ${prefix}[${kindLabel(sym.kind)}] ${sym.name}`);
        if (sym.children && sym.children.length > 0) {
          flatten(sym.children, indent + 1);
        }
      }
    };

    flatten(symbols, 0);
    return `File outline for ${relPath}:\n\n${outline.join('\n')}`;
  } catch {
    return undefined;
  }
}

// Pre-compiled outline patterns with keyword pre-filters (regex fallback).
interface OutlinePattern {
  regex: RegExp;
  label: string;
  prefixes: string[];
}

const OUTLINE_PATTERNS: readonly OutlinePattern[] = [
  { regex: /^\s*(import\s|from\s|require\s*\(|const\s+\w+\s*=\s*require)/, label: 'import', prefixes: ['import ', 'from ', 'require', 'const '] },
  { regex: /^\s*export\s+(default\s+)?(class|function|const|let|var|interface|type|enum|abstract)/, label: 'export', prefixes: ['export '] },
  { regex: /^\s*module\.exports/, label: 'export', prefixes: ['module'] },
  { regex: /^\s*(export\s+)?(abstract\s+)?class\s+\w+/, label: 'class', prefixes: ['export ', 'abstract ', 'class '] },
  { regex: /^\s*(export\s+)?interface\s+\w+/, label: 'interface', prefixes: ['export ', 'interface '] },
  { regex: /^\s*(export\s+)?enum\s+\w+/, label: 'enum', prefixes: ['export ', 'enum '] },
  { regex: /^\s*(export\s+)?(async\s+)?function\s+\w+/, label: 'function', prefixes: ['export ', 'async ', 'function '] },
  { regex: /^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/, label: 'function', prefixes: ['export ', 'const ', 'let ', 'var '] },
  { regex: /^\s*(public|private|protected|static|async|get|set|\*)\s+\w+\s*[\(<]/, label: 'method', prefixes: ['public ', 'private ', 'protected ', 'static ', 'async ', 'get ', 'set ', '*'] },
  { regex: /^\s*(async\s+)?def\s+\w+/, label: 'function', prefixes: ['async ', 'def '] },
  { regex: /^\s*(class|module)\s+[A-Z]\w*/, label: 'class', prefixes: ['class ', 'module '] },
  { regex: /^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/, label: 'function', prefixes: ['func '] },
];

async function executeRegexOutline(fileUri: vscode.Uri, relPath: string): Promise<string> {
  let rawBytes: Uint8Array;
  try {
    rawBytes = await vscode.workspace.fs.readFile(fileUri);
  } catch {
    return `Error: file not found: ${relPath}`;
  }

  const content = Buffer.from(rawBytes).toString('utf-8');
  if (content.length > 1_000_000) {
    return `Error: file too large for outline (${(content.length / 1024).toFixed(0)} KB). Use read_file_section instead.`;
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
