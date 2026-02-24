import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { DiffFile, DiffHunk, BranchSelection } from './types';
import { minimatch } from './minimatch';

/**
 * Git operations for computing diffs between branches.
 * Uses child_process for reliability (the Git Extension API diff methods
 * don't support arbitrary ref comparisons as flexibly).
 */
export class GitDiffEngine {
  private cwd: string;

  constructor(private workspaceFolder: vscode.WorkspaceFolder) {
    this.cwd = workspaceFolder.uri.fsPath;
  }

  /** Run a git command and return stdout */
  private git(args: string, maxBuffer = 10 * 1024 * 1024): string {
    try {
      return execSync(`git ${args}`, {
        cwd: this.cwd,
        encoding: 'utf-8',
        maxBuffer,
      }).trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`git ${args.split(' ')[0]} failed: ${msg}`);
    }
  }

  /** Get the current branch name */
  getCurrentBranch(): string {
    return this.git('rev-parse --abbrev-ref HEAD');
  }

  /** List local branches */
  getLocalBranches(): string[] {
    const raw = this.git("branch --format='%(refname:short)'");
    return raw.split('\n').filter(Boolean);
  }

  /** List remote branches */
  getRemoteBranches(): string[] {
    const raw = this.git("branch -r --format='%(refname:short)'");
    return raw.split('\n').filter(Boolean).map(b => b.replace(/^origin\//, ''));
  }

  /** Compute merge base between two refs.
   *  Falls back to the base ref itself when branches are unrelated (orphan). */
  getMergeBase(ref1: string, ref2: string): string {
    try {
      return this.git(`merge-base ${ref1} ${ref2}`);
    } catch {
      // Branches share no common ancestor (orphan) — fall back to the base ref
      // directly. `git diff <base>..<target>` works fine without shared history.
      return ref1;
    }
  }

  /** Check if a ref exists */
  refExists(ref: string): boolean {
    try {
      this.git(`rev-parse --verify ${ref}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the unified diff between the merge base and the target.
   * @param selection Branch selection with base/target/mergeBase
   * @param filePaths Optional: limit to specific files
   */
  getDiff(selection: BranchSelection, filePaths?: string[]): string {
    const mergeBase = selection.mergeBase || this.getMergeBase(selection.baseBranch, selection.targetBranch || 'HEAD');

    let diffCmd: string;

    if (!selection.targetBranch || selection.targetBranch === this.getCurrentBranch()) {
      // Target is working tree: include uncommitted changes
      if (selection.includeUncommitted) {
        diffCmd = `diff ${mergeBase}`;
      } else {
        diffCmd = `diff ${mergeBase}..HEAD`;
      }
    } else {
      // Target is a specific branch: committed diff only
      diffCmd = `diff ${mergeBase}..${selection.targetBranch}`;
    }

    if (filePaths && filePaths.length > 0) {
      diffCmd += ` -- ${filePaths.join(' ')}`;
    }

    return this.git(diffCmd);
  }

  /**
   * Parse a unified diff string into structured DiffFile objects.
   */
  parseDiff(rawDiff: string, excludePaths: string[]): DiffFile[] {
    const files: DiffFile[] = [];
    // Split on "diff --git" boundaries
    const fileDiffs = rawDiff.split(/^diff --git /m).filter(Boolean);

    for (const fileDiff of fileDiffs) {
      const lines = fileDiff.split('\n');
      const headerLine = lines[0]; // a/path b/path

      // Extract file path from "a/old b/new"
      const match = headerLine.match(/a\/(.*?) b\/(.*)/);
      if (!match) { continue; }

      const filePath = match[2];

      // Check exclusions
      if (excludePaths.some(pattern => minimatch(filePath, pattern))) {
        continue;
      }

      const isNew = fileDiff.includes('new file mode');
      const isDeleted = fileDiff.includes('deleted file mode');
      const isBinary = fileDiff.includes('Binary files');

      if (isBinary) {
        files.push({ path: filePath, hunks: [], isNew, isDeleted, isBinary: true });
        continue;
      }

      // Parse hunks
      const hunks: DiffHunk[] = [];
      let currentHunk: DiffHunk | null = null;
      let lineContent: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];

        // Hunk header: @@ -old,count +new,count @@ optional context
        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
        if (hunkMatch) {
          // Save previous hunk
          if (currentHunk) {
            currentHunk.content = lineContent.join('\n');
            hunks.push(currentHunk);
          }

          const newStart = parseInt(hunkMatch[3], 10);
          const newLines = parseInt(hunkMatch[4] || '1', 10);

          currentHunk = {
            file: filePath,
            oldStart: parseInt(hunkMatch[1], 10),
            oldLines: parseInt(hunkMatch[2] || '1', 10),
            newStart,
            newLines,
            header: hunkMatch[5]?.trim() || '',
            content: '',
            addedLines: [],
            removedLines: [],
          };
          lineContent = [line];

          // Track added/removed line numbers
          let newLineNum = newStart;
          for (let j = i + 1; j < lines.length; j++) {
            const dl = lines[j];
            if (dl.startsWith('@@') || dl.startsWith('diff --git')) { break; }

            if (dl.startsWith('+')) {
              currentHunk.addedLines.push(newLineNum);
              newLineNum++;
            } else if (dl.startsWith('-')) {
              currentHunk.removedLines.push(newLineNum);
              // Don't increment newLineNum for removed lines
            } else {
              newLineNum++;
            }
          }
          continue;
        }

        // Skip diff metadata lines (index, ---, +++)
        if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('new file') || line.startsWith('deleted file')) {
          continue;
        }

        if (currentHunk) {
          lineContent.push(line);
        }
      }

      // Save last hunk
      if (currentHunk) {
        currentHunk.content = lineContent.join('\n');
        hunks.push(currentHunk);
      }

      files.push({ path: filePath, hunks, isNew, isDeleted, isBinary: false });
    }

    return files;
  }

  /**
   * Read the full content of a file at the given ref (or from disk for working tree).
   */
  getFileContent(filePath: string, ref?: string): string | undefined {
    try {
      if (!ref) {
        // Working tree: read from disk
        const fullPath = path.join(this.cwd, filePath);
        if (fs.existsSync(fullPath)) {
          return fs.readFileSync(fullPath, 'utf-8');
        }
        return undefined;
      }
      return this.git(`show ${ref}:${filePath}`);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve full file contents for all diff files.
   * Uses the target ref or working tree depending on selection.
   */
  resolveFileContents(files: DiffFile[], selection: BranchSelection): void {
    for (const file of files) {
      if (file.isDeleted || file.isBinary) { continue; }

      const ref = (!selection.targetBranch || selection.targetBranch === this.getCurrentBranch())
        ? undefined // working tree
        : selection.targetBranch;

      file.fullContent = this.getFileContent(file.path, ref);
    }
  }
}

/** Prompt user to select a base branch */
export async function pickBaseBranch(engine: GitDiffEngine, defaultBranch: string): Promise<string | undefined> {
  const locals = engine.getLocalBranches();
  const remotes = engine.getRemoteBranches().filter(b => !locals.includes(b));
  const current = engine.getCurrentBranch();

  const items: vscode.QuickPickItem[] = [];

  // Put default first
  if (locals.includes(defaultBranch)) {
    items.push({
      label: defaultBranch,
      description: defaultBranch === current ? '(current branch) — default' : '— default',
      picked: true,
    });
  }

  // Then other local branches
  for (const b of locals) {
    if (b === defaultBranch) { continue; }
    items.push({
      label: b,
      description: b === current ? '(current branch)' : '',
    });
  }

  // Then remote-only branches
  for (const b of remotes) {
    if (b === defaultBranch || b === 'HEAD') { continue; }
    items.push({
      label: `origin/${b}`,
      description: '(remote)',
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Select base branch (default: ${defaultBranch})`,
    title: 'Self Review — Base Branch',
    matchOnDescription: true,
  });

  return picked?.label;
}

/** Prompt user to select a target branch */
export async function pickTargetBranch(engine: GitDiffEngine): Promise<string | undefined> {
  const current = engine.getCurrentBranch();

  const items: vscode.QuickPickItem[] = [
    {
      label: `${current} + working tree`,
      description: '(current branch + uncommitted changes) — default',
    },
    {
      label: current,
      description: '(committed changes only)',
    },
  ];

  // Other local branches
  const locals = engine.getLocalBranches();
  for (const b of locals) {
    if (b === current) { continue; }
    items.push({ label: b });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select target to review',
    title: 'Self Review — Target',
    matchOnDescription: true,
  });

  if (!picked) { return undefined; }

  if (picked.label === `${current} + working tree`) {
    return ''; // empty = working tree
  }

  return picked.label;
}
