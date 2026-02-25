import * as vscode from 'vscode';
import { SelfReviewConfig, Severity, Category } from './types';

const DEFAULT_CONFIG: SelfReviewConfig = {
  baseBranch: 'develop',
  targetBranch: '',
  includeUncommitted: true,
  severityThreshold: 'low',
  excludePaths: ['vendor/**', 'node_modules/**', 'db/schema.rb'],
  maxFilesPerChunk: 5,
  categories: ['security', 'performance', 'correctness', 'maintainability', 'testing', 'style'],
  customInstructions: '',
  maxFindings: 50,
};

const validSeverities: Severity[] = ['low', 'medium', 'high'];

function isValidSeverity(s: unknown): s is Severity {
  return typeof s === 'string' && validSeverities.includes(s as Severity);
}

/**
 * Loads the merged configuration from VS Code settings and .self-review.yml.
 * VS Code settings take precedence for baseBranch, targetBranch, severityThreshold.
 * .self-review.yml provides review-specific rules (categories, custom_instructions, etc.).
 * .self-review-instructions.md provides custom instructions as a markdown file (like CLAUDE.md).
 */
export async function loadConfig(): Promise<SelfReviewConfig> {
  const vsConfig = vscode.workspace.getConfiguration('selfReview');
  const fileConfig = await loadYamlConfig();
  const instructionsFile = await loadInstructionsFile();

  // Merge: instructions file content gets appended to any yaml custom_instructions
  const yamlInstructions = fileConfig.customInstructions || '';
  const combinedInstructions = [yamlInstructions, instructionsFile].filter(Boolean).join('\n\n');
  const rawSev = vsConfig.get<string>('severityThreshold');

  return {
    baseBranch: vsConfig.get<string>('baseBranch') ?? fileConfig.baseBranch ?? DEFAULT_CONFIG.baseBranch,
    targetBranch: vsConfig.get<string>('targetBranch') ?? fileConfig.targetBranch ?? DEFAULT_CONFIG.targetBranch,
    includeUncommitted: vsConfig.get<boolean>('includeUncommitted') ?? fileConfig.includeUncommitted ?? DEFAULT_CONFIG.includeUncommitted,
    severityThreshold: isValidSeverity(rawSev) ? rawSev : (fileConfig.severityThreshold || DEFAULT_CONFIG.severityThreshold),
    excludePaths: fileConfig.excludePaths.length > 0 ? fileConfig.excludePaths : (vsConfig.get<string[]>('excludePaths') || DEFAULT_CONFIG.excludePaths),
    maxFilesPerChunk: vsConfig.get<number>('maxFilesPerChunk') || fileConfig.maxFilesPerChunk || DEFAULT_CONFIG.maxFilesPerChunk,
    categories: fileConfig.categories.length > 0 ? fileConfig.categories : DEFAULT_CONFIG.categories,
    customInstructions: combinedInstructions || DEFAULT_CONFIG.customInstructions,
    maxFindings: fileConfig.maxFindings || DEFAULT_CONFIG.maxFindings,
  };
}

/** The conventional filename for custom review instructions */
export const INSTRUCTIONS_FILENAME = '.self-review-instructions.md';

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
 * Load the .self-review-instructions.md file contents, if it exists.
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

/** Generate a sample .self-review-instructions.md file */
export function generateSampleInstructions(): string {
  return `# Self Review — Custom Instructions

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
  excludePaths: string[];
  maxFilesPerChunk?: number;
  categories: Category[];
  customInstructions?: string;
  maxFindings?: number;
}

async function loadYamlConfig(): Promise<FileConfig> {
  const empty: FileConfig = { excludePaths: [], categories: [] };

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return empty;
  }

  const configUri = vscode.Uri.joinPath(workspaceFolder.uri, '.self-review.yml');
  let content: string;
  try {
    const raw = await vscode.workspace.fs.readFile(configUri);
    content = Buffer.from(raw).toString('utf-8');
  } catch {
    return empty;
  }

  try {
    const parsed = parseSimpleYaml(content);

    return {
      baseBranch: parsed['base_branch'] as string | undefined,
      targetBranch: parsed['target_branch'] as string | undefined,
      includeUncommitted: parsed['include_uncommitted'] as boolean | undefined,
      severityThreshold: parsed['severity_threshold'] as Severity | undefined,
      excludePaths: Array.isArray(parsed['exclude_paths']) ? parsed['exclude_paths'] : [],
      maxFilesPerChunk: parsed['max_files_per_chunk'] as number | undefined,
      categories: Array.isArray(parsed['categories']) ? parsed['categories'] : [],
      customInstructions: parsed['custom_instructions'] as string | undefined,
      maxFindings: parsed['max_findings'] as number | undefined,
    };
  } catch (err) {
    vscode.window.showWarningMessage(`Self Review: Failed to parse .self-review.yml: ${err}`);
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
      i++;
      continue;
    }

    const keyValueMatch = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!keyValueMatch) {
      i++;
      continue;
    }

    const key = keyValueMatch[1];
    let value = keyValueMatch[2].trim();

    // Multiline string (|)
    if (value === '|') {
      const multiLines: string[] = [];
      i++;
      while (i < lines.length) {
        const ml = lines[i];
        if (ml.match(/^\s/) && ml.trim()) {
          multiLines.push(ml.trim());
          i++;
        } else if (ml.trim() === '') {
          multiLines.push('');
          i++;
        } else {
          break;
        }
      }
      result[key] = multiLines.join('\n').trimEnd();
      continue;
    }

    // Flow-style array: [item1, item2]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      result[key] = inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      i++;
      continue;
    }

    // Block-style array (value is empty, next lines start with -)
    if (!value) {
      const arr: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim().startsWith('-')) {
        arr.push(lines[i].trim().slice(1).trim().replace(/^["']|["']$/g, ''));
        i++;
      }
      if (arr.length > 0) {
        result[key] = arr;
        continue;
      }
      // Not an array, just empty value
      result[key] = '';
      continue;
    }

    // Boolean
    if (value === 'true') { result[key] = true; i++; continue; }
    if (value === 'false') { result[key] = false; i++; continue; }

    // Number
    const num = Number(value);
    if (!isNaN(num) && value !== '') { result[key] = num; i++; continue; }

    // String (strip quotes)
    result[key] = value.replace(/^["']|["']$/g, '');
    i++;
  }

  return result;
}

/** Generates a sample .self-review.yml config file */
export function generateSampleConfig(): string {
  return `# Self Review Configuration
# See https://github.com/recognize/self-review-vscode for docs

# Default base branch to compare against
base_branch: develop

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
