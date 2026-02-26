import * as vscode from 'vscode';
import { CopilotReviewAgentConfig, Severity, Category } from './types';

const DEFAULT_CONFIG: CopilotReviewAgentConfig = {
  baseBranch: 'main',
  targetBranch: '',
  includeUncommitted: true,
  severityThreshold: 'low',
  excludePaths: ['vendor/**', 'node_modules/**', 'db/schema.rb'],
  maxFilesPerChunk: 5,
  contextLines: 10,
  categories: ['security', 'performance', 'correctness', 'maintainability', 'testing', 'style'],
  customInstructions: '',
  maxFindings: 50,
};

const validSeverities: Severity[] = ['blocker', 'high', 'medium', 'low', 'nit'];

const validCategories: Category[] = [
  'security',
  'performance',
  'correctness',
  'maintainability',
  'testing',
  'style',
  'other',
];

function isValidSeverity(s: unknown): s is Severity {
  return typeof s === 'string' && validSeverities.includes(s as Severity);
}

function isValidCategory(c: unknown): c is Category {
  return typeof c === 'string' && validCategories.includes(c as Category);
}

/**
 * Loads the merged configuration from VS Code settings and .copilot-review-agent.yml.
 *
 * Precedence order (highest to lowest) for all settings:
 *   1. VS Code user/workspace settings (only if explicitly set, not package.json defaults)
 *   2. .copilot-review-agent.yml values (including explicit empty arrays like `exclude_paths: []`)
 *   3. Built-in defaults
 *
 * .copilot-review-agent-instructions.md content is appended to any yaml custom_instructions.
 */
export async function loadConfig(): Promise<CopilotReviewAgentConfig> {
  const vsConfig = vscode.workspace.getConfiguration('copilotReviewAgent');
  const fileConfig = await loadYamlConfig();
  const instructionsFile = await loadInstructionsFile();

  // Merge: instructions file content gets appended to any yaml custom_instructions
  const yamlInstructions = fileConfig.customInstructions || '';
  const combinedInstructions = [yamlInstructions, instructionsFile].filter(Boolean).join('\n\n');

  // Use inspect() to distinguish user-set values from package.json defaults.
  // vsConfig.get() returns the default even when the user hasn't configured anything,
  // so with `??` the YAML file values would never take effect.
  const userValue = <T>(key: string): T | undefined => {
    const i = vsConfig.inspect<T>(key);
    return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
  };

  const userBaseBranch = userValue<string>('baseBranch');
  const userTargetBranch = userValue<string>('targetBranch');
  const userIncludeUncommitted = userValue<boolean>('includeUncommitted');
  const userSeverity = userValue<string>('severityThreshold');
  const userExcludePaths = userValue<string[]>('excludePaths');
  const userMaxFilesPerChunk = userValue<number>('maxFilesPerChunk');
  const userContextLines = userValue<number>('contextLines');

  if (userSeverity !== undefined && !isValidSeverity(userSeverity)) {
    vscode.window.showWarningMessage(`Copilot Review Agent: Invalid severityThreshold "${userSeverity}". Using default.`);
  }

  // Validate categories from YAML: an explicit empty array would produce a useless
  // review prompt with no focus areas. Warn and fall back to defaults in that case.
  let resolvedCategories: Category[];
  if (fileConfig.categories === undefined) {
    resolvedCategories = DEFAULT_CONFIG.categories;
  } else if (fileConfig.categories.length === 0) {
    void vscode.window.showWarningMessage(
      'Copilot Review Agent: `categories` is set to an empty array in .copilot-review-agent.yml. Using default categories.'
    );
    resolvedCategories = DEFAULT_CONFIG.categories;
  } else {
    resolvedCategories = fileConfig.categories;
  }

  return {
    baseBranch: userBaseBranch ?? fileConfig.baseBranch ?? DEFAULT_CONFIG.baseBranch,
    targetBranch: userTargetBranch ?? fileConfig.targetBranch ?? DEFAULT_CONFIG.targetBranch,
    includeUncommitted: userIncludeUncommitted ?? fileConfig.includeUncommitted ?? DEFAULT_CONFIG.includeUncommitted,
    severityThreshold: isValidSeverity(userSeverity) ? userSeverity : (fileConfig.severityThreshold ?? DEFAULT_CONFIG.severityThreshold),
    excludePaths: userExcludePaths ?? fileConfig.excludePaths ?? DEFAULT_CONFIG.excludePaths,
    maxFilesPerChunk: userMaxFilesPerChunk ?? fileConfig.maxFilesPerChunk ?? DEFAULT_CONFIG.maxFilesPerChunk,
    contextLines: userContextLines ?? fileConfig.contextLines ?? DEFAULT_CONFIG.contextLines,
    categories: resolvedCategories,
    customInstructions: combinedInstructions || DEFAULT_CONFIG.customInstructions,
    maxFindings: fileConfig.maxFindings ?? DEFAULT_CONFIG.maxFindings,
  };
}

/** The conventional filename for custom review instructions */
export const INSTRUCTIONS_FILENAME = '.copilot-review-agent-instructions.md';

/**
 * Check whether the instructions file exists and return its URI.
 */
export async function getInstructionsFilePath(): Promise<vscode.Uri | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) { return undefined; }
  const uri = vscode.Uri.joinPath(workspaceFolder.uri, INSTRUCTIONS_FILENAME);
  try {
    await vscode.workspace.fs.stat(uri);
    return uri;
  } catch {
    return undefined;
  }
}

/**
 * Load the .copilot-review-agent-instructions.md file contents, if it exists.
 */
async function loadInstructionsFile(): Promise<string> {
  const uri = await getInstructionsFilePath();
  if (!uri) { return ''; }
  try {
    const content = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(content).toString('utf-8').trim();
  } catch {
    return '';
  }
}

/** Generate a sample .copilot-review-agent-instructions.md file */
export function generateSampleInstructions(): string {
  return `# Copilot Review Agent — Custom Instructions

These instructions are automatically included in every AI code review for this repository.
Edit this file to customize how the AI reviews your code.

## Project Context

<!-- Describe your project so the AI understands the codebase -->
- Language / framework: 
- Architecture patterns: 
- Key conventions: 

## Review Focus Areas

<!-- Tell the AI what to prioritize -->
- Pay special attention to authorization and access control
- Flag potential N+1 query issues
- Check for proper error handling in async code

## Things to Ignore

<!-- Tell the AI what NOT to flag -->
- Don't flag missing tests for private methods
- Ignore formatting / style issues (handled by linter)
`;
}

interface FileConfig {
  baseBranch?: string;
  targetBranch?: string;
  includeUncommitted?: boolean;
  severityThreshold?: Severity;
  excludePaths?: string[];
  maxFilesPerChunk?: number;
  contextLines?: number;
  categories?: Category[];
  customInstructions?: string;
  maxFindings?: number;
}

async function loadYamlConfig(): Promise<FileConfig> {
  const empty: FileConfig = {};

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return empty;
  }

  const configUri = vscode.Uri.joinPath(workspaceFolder.uri, '.copilot-review-agent.yml');
  let content: string;
  try {
    const raw = await vscode.workspace.fs.readFile(configUri);
    content = Buffer.from(raw).toString('utf-8');
  } catch {
    return empty;
  }

  try {
    const parsed = parseSimpleYaml(content);

    const rawIncludeUncommitted = parsed['include_uncommitted'];
    const rawSeverityThreshold = parsed['severity_threshold'];
    const rawMaxFilesPerChunk = parsed['max_files_per_chunk'];
    const rawContextLines = parsed['context_lines'];
    const rawMaxFindings = parsed['max_findings'];

    if (rawSeverityThreshold !== undefined && !isValidSeverity(rawSeverityThreshold)) {
      vscode.window.showWarningMessage(
        `Copilot Review Agent: Invalid severity_threshold "${String(rawSeverityThreshold)}" in .copilot-review-agent.yml. Ignoring.`
      );
    }

    return {
      baseBranch: typeof parsed['base_branch'] === 'string' ? parsed['base_branch'] : undefined,
      targetBranch: typeof parsed['target_branch'] === 'string' ? parsed['target_branch'] : undefined,
      includeUncommitted: typeof rawIncludeUncommitted === 'boolean' ? rawIncludeUncommitted : undefined,
      severityThreshold: isValidSeverity(rawSeverityThreshold) ? rawSeverityThreshold : undefined,
      excludePaths: Array.isArray(parsed['exclude_paths']) && parsed['exclude_paths'].every(item => typeof item === 'string')
        ? parsed['exclude_paths']
        : undefined,
      maxFilesPerChunk: Number.isFinite(rawMaxFilesPerChunk) ? rawMaxFilesPerChunk as number : undefined,
      contextLines: Number.isFinite(rawContextLines) ? rawContextLines as number : undefined,
      categories: Array.isArray(parsed['categories']) && parsed['categories'].every(isValidCategory)
        ? parsed['categories']
        : undefined,
      customInstructions: typeof parsed['custom_instructions'] === 'string' ? parsed['custom_instructions'] : undefined,
      maxFindings: Number.isFinite(rawMaxFindings) ? rawMaxFindings as number : undefined,
    };
  } catch (err) {
    vscode.window.showWarningMessage(`Copilot Review Agent: Failed to parse .copilot-review-agent.yml: ${err}`);
    return empty;
  }
}

/**
 * Minimal YAML parser for flat key-value configs.
 * Handles strings, numbers, booleans, arrays (flow and block), and multiline strings (|).
 * No dependency on external yaml library.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let i = 0;
  let warnedIndentedTopLevel = false;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    // Only parse top-level mapping entries; ignore indented lines here.
    if (/^\s/.test(line)) {
      if (!warnedIndentedTopLevel && /^\s+[A-Za-z0-9_-]+\s*:\s*.*$/.test(line)) {
        warnedIndentedTopLevel = true;
        vscode.window.showWarningMessage(
          'Copilot Review Agent: Ignoring indented top-level YAML keys in .copilot-review-agent.yml. Remove leading spaces to apply those settings.'
        );
      }
      i++;
      continue;
    }

    const keyValueMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!keyValueMatch) {
      i++;
      continue;
    }

    const key = keyValueMatch[1];
    let value = keyValueMatch[2].trim();

    // Multiline string (|)
    if (value === '|') {
      const multiLines: string[] = [];
      const indents: number[] = [];
      i++;
      while (i < lines.length) {
        const ml = lines[i];
        if (ml.trim() === '') {
          multiLines.push('');
          i++;
        } else if (/^\s/.test(ml)) {
          indents.push(ml.match(/^(\s*)/)![1].length);
          multiLines.push(ml);
          i++;
        } else {
          break;
        }
      }
      const blockIndent = indents.length > 0 ? Math.min(...indents) : 0;
      const normalized = multiLines.map(line => {
        if (line === '') { return ''; }
        return line.length >= blockIndent ? line.slice(blockIndent) : line.trimStart();
      });
      result[key] = normalized.join('\n').trimEnd();
      continue;
    }

    // Flow-style array: [item1, item2]
    // Note: only handles single-line arrays without nested brackets.
    // Values containing '[' or ']' inside (e.g. ["item]with]brackets"]) are
    // intentionally left unparsed and will fall through to string handling.
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      if (!inner.includes('[') && !inner.includes(']')) {
        if (inner.trim() === '') {
          result[key] = [];
          i++;
          continue;
        }
        result[key] = inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        i++;
        continue;
      }
      // Nested brackets: fall through to string handling below
    }

    // Block-style array (value is empty, next lines are indented list items)
    if (!value) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') { j++; }

      if (j < lines.length && /^\s+-/.test(lines[j])) {
        const arr: string[] = [];
        i++;
        while (i < lines.length && (/^\s+-/.test(lines[i]) || lines[i].trim() === '')) {
          if (/^\s+-/.test(lines[i])) {
            arr.push(lines[i].trim().slice(1).trim().replace(/^["']|["']$/g, ''));
          }
          i++;
        }
        result[key] = arr;
        continue;
      }

      result[key] = '';
      i++;
      continue;
    }

    // Boolean
    if (value === 'true') { result[key] = true; i++; continue; }
    if (value === 'false') { result[key] = false; i++; continue; }

    // Number (only if not quoted)
    if (!/^["']/.test(value)) {
      const num = Number(value);
      if (!isNaN(num) && value !== '') { result[key] = num; i++; continue; }
    }

    // String (strip quotes)
    result[key] = value.replace(/^["']|["']$/g, '');
    i++;
  }

  return result;
}

/** Generates a sample .copilot-review-agent.yml config file */
export function generateSampleConfig(): string {
  return `# Copilot Review Agent Configuration
# See https://github.com/recognize/self-review-vscode for docs

# Default base branch to compare against
base_branch: main

# Default target branch (empty = current HEAD + working tree)
target_branch: ""

# Include uncommitted changes when target matches current checkout
include_uncommitted: true

# Minimum severity to report: low, medium, high
severity_threshold: low

# Glob patterns to exclude from review
exclude_paths:
  - vendor/**
  - node_modules/**
  - db/schema.rb
  - "*.min.js"
  - coverage/**

# Review categories to check
categories:
  - security
  - performance
  - correctness
  - maintainability
  - testing
  - style

# Custom instructions appended to the AI review prompt
custom_instructions: |
  This is a Ruby on Rails application.
  Pay attention to authorization rules and N+1 queries.

# Maximum findings to return per review
max_findings: 50
`;
}
