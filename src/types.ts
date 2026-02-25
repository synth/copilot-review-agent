import * as vscode from 'vscode';

/** Severity levels for review findings */
export type Severity = 'blocker' | 'high' | 'medium' | 'low' | 'nit';

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
  addedLines: number[];
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

/** Extension configuration merged from settings + .self-review.yml */
export interface SelfReviewConfig {
  baseBranch: string;
  targetBranch: string;
  includeUncommitted: boolean;
  severityThreshold: Severity;
  excludePaths: string[];
  maxFilesPerChunk: number;
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
  return `sr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A persisted review session (for history) */
export interface ReviewSession {
  id: string;
  timestamp: number;
  baseBranch: string;
  targetBranch: string;
  findings: ReviewFinding[];
  agentSteps: ReviewAgentStep[];
  summary?: ReviewSessionSummary;
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
  return `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
