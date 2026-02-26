import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

/** Severity levels for review findings */
export type Severity = 'blocker' | 'high' | 'medium' | 'low' | 'nit';

/** Shared emoji map for severity levels */
export const SEVERITY_EMOJI: Record<Severity, string> = {
  blocker: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  nit: '⚪',
};

/** Categories for review findings */
export type Category =
  | 'security'
  | 'performance'
  | 'correctness'
  | 'maintainability'
  | 'testing'
  | 'style'
  | 'other';

/** A single review finding produced by the AI */
export interface ReviewFinding {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  title: string;
  description: string;
  suggestedFix?: string;
  category: Category;
  status: 'open' | 'skipped' | 'fixed' | 'in-progress';
}

/** A parsed diff hunk */
export interface DiffHunk {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  content: string;
  /** 1-based line numbers (in the new file) that were added by this hunk. */
  addedLines: number[];
  /** 1-based line numbers (in the old file) that were removed by this hunk. */
  removedLines: number[];
}

/** A file with its diff hunks and full content */
export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  fullContent?: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
}

/** A chunk of diff data sized for one AI request */
export interface DiffChunk {
  files: DiffFile[];
  tokenEstimate: number;
}

/** Branch selection state for a review session */
export interface BranchSelection {
  baseBranch: string;
  targetBranch: string; // empty string means HEAD + working tree
  includeUncommitted: boolean;
  mergeBase?: string;
}

/** Extension configuration merged from settings + .copilot-review-agent.yml */
export interface CopilotReviewAgentConfig {
  baseBranch: string;
  targetBranch: string;
  includeUncommitted: boolean;
  severityThreshold: Severity;
  excludePaths: string[];
  maxFilesPerChunk: number;
  contextLines: number;
  categories: Category[];
  customInstructions: string;
  maxFindings: number;
}

/** Maps severity to ThemeIcon */
export function severityIcon(severity: Severity): vscode.ThemeIcon {
  switch (severity) {
    case 'blocker':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    case 'high':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
    case 'medium':
      return new vscode.ThemeIcon('warning');
    case 'low':
      return new vscode.ThemeIcon('info');
    case 'nit':
      return new vscode.ThemeIcon('lightbulb');
  }
}

/** Severity comparison for filtering */
export function severityRank(severity: Severity): number {
  const ranks: Record<Severity, number> = {
    blocker: 5,
    high: 4,
    medium: 3,
    low: 2,
    nit: 1,
  };
  return ranks[severity];
}

/** Generates a unique finding ID */
export function nextFindingId(): string {
  return `sr-${randomUUID()}`;
}

/** A persisted review session (for history) */
export interface ReviewSession {
  id: string;
  timestamp: number;
  baseBranch: string;
  targetBranch: string;
  modelId?: string;
  findings: ReviewFinding[];
  agentSteps: ReviewAgentStep[];
  summary?: ReviewSessionSummary;
  /** True when the review was cancelled before all chunks were processed */
  partial?: boolean;
}

export interface ReviewAgentStep {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
}

export interface ReviewSessionSummary {
  totalFindings: number;
  openCount: number;
  fileCount: number;
}

/** Generates a unique review session ID */
export function nextSessionId(): string {
  return `review-${randomUUID()}`;
}
