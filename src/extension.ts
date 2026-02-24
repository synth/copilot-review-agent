import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { BranchSelection, ReviewFinding } from './types';
import { loadConfig, generateSampleConfig } from './config';
import { GitDiffEngine, pickBaseBranch, pickTargetBranch } from './git';
import { chunkDiffFiles } from './chunker';
import { ReviewEngine } from './reviewer';
import { CommentManager } from './comments';
import { TaskListProvider, TaskListItem } from './taskList';
import { FixActions } from './fixActions';
import { exportFindings } from './export';

/** Current session state */
let currentSelection: BranchSelection | undefined;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  // Core managers
  const commentManager = new CommentManager();
  const taskListProvider = new TaskListProvider();
  const reviewEngine = new ReviewEngine();

  // Register TreeView
  const treeView = vscode.window.createTreeView('selfReview.taskList', {
    treeDataProvider: taskListProvider,
    showCollapseAll: true,
  });

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.command = 'selfReview.reviewBranch';
  updateStatusBar('idle');
  statusBarItem.show();

  // Helper: get workspace folder
  function getWorkspaceFolder(): vscode.WorkspaceFolder {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace folder open.');
    }
    return folders[0];
  }

  // Helper: get FixActions
  function getFixActions(): FixActions {
    return new FixActions(reviewEngine, getWorkspaceFolder());
  }

  // Helper: resolve a finding ID from various command sources
  function resolveFindingId(arg: unknown): string | undefined {
    if (typeof arg === 'string') { return arg; }
    // From comment thread context
    if (arg && typeof arg === 'object' && 'contextValue' in arg) {
      return (arg as vscode.CommentThread).contextValue || undefined;
    }
    // From tree item
    if (arg instanceof TaskListItem && arg.findingId) {
      return arg.findingId;
    }
    return undefined;
  }

  // ============================================================
  // COMMAND: Review Branch
  // ============================================================
  const reviewBranchCmd = vscode.commands.registerCommand('selfReview.reviewBranch', async () => {
    try {
      const wsFolder = getWorkspaceFolder();
      const config = await loadConfig();
      const engine = new GitDiffEngine(wsFolder);

      // Prompt for branches
      const baseBranch = await pickBaseBranch(engine, config.baseBranch);
      if (!baseBranch) { return; } // cancelled

      const targetBranch = await pickTargetBranch(engine);
      if (targetBranch === undefined) { return; } // cancelled

      // Validate base branch exists
      if (!engine.refExists(baseBranch)) {
        vscode.window.showErrorMessage(`Self Review: Base branch "${baseBranch}" not found.`);
        return;
      }

      // Compute merge base
      const targetRef = targetBranch || 'HEAD';
      let mergeBase: string;
      try {
        mergeBase = engine.getMergeBase(baseBranch, targetRef);
      } catch {
        vscode.window.showErrorMessage(
          `Self Review: Cannot compute merge base between "${baseBranch}" and "${targetRef}". Are the branches related?`
        );
        return;
      }

      currentSelection = {
        baseBranch,
        targetBranch,
        includeUncommitted: !targetBranch ? config.includeUncommitted : false,
        mergeBase,
      };

      await runReview(wsFolder, engine, config, currentSelection, commentManager, taskListProvider, reviewEngine);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Self Review: ${msg}`);
    }
  });

  // ============================================================
  // COMMAND: Review Current File
  // ============================================================
  const reviewFileCmd = vscode.commands.registerCommand('selfReview.reviewFile', async () => {
    try {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Self Review: No active file.');
        return;
      }

      const wsFolder = getWorkspaceFolder();
      const config = await loadConfig();
      const engine = new GitDiffEngine(wsFolder);
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);

      // Use current selection or defaults
      const selection = currentSelection || {
        baseBranch: config.baseBranch,
        targetBranch: config.targetBranch,
        includeUncommitted: config.includeUncommitted,
        mergeBase: engine.getMergeBase(config.baseBranch, config.targetBranch || 'HEAD'),
      };

      await runReview(wsFolder, engine, config, selection, commentManager, taskListProvider, reviewEngine, [relativePath]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Self Review: ${msg}`);
    }
  });

  // ============================================================
  // COMMAND: Refresh Review (re-run with same branches)
  // ============================================================
  const refreshCmd = vscode.commands.registerCommand('selfReview.refreshReview', async () => {
    if (!currentSelection) {
      vscode.commands.executeCommand('selfReview.reviewBranch');
      return;
    }
    try {
      const wsFolder = getWorkspaceFolder();
      const config = await loadConfig();
      const engine = new GitDiffEngine(wsFolder);
      commentManager.clearAll();
      taskListProvider.clearAll();
      await runReview(wsFolder, engine, config, currentSelection, commentManager, taskListProvider, reviewEngine);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Self Review: ${msg}`);
    }
  });

  // ============================================================
  // COMMAND: Clear Review
  // ============================================================
  const clearCmd = vscode.commands.registerCommand('selfReview.clearReview', () => {
    commentManager.clearAll();
    taskListProvider.clearAll();
    currentSelection = undefined;
    updateStatusBar('idle');
  });

  // ============================================================
  // COMMAND: Export Markdown
  // ============================================================
  const exportCmd = vscode.commands.registerCommand('selfReview.exportMarkdown', async () => {
    const findings = taskListProvider.getFindings();
    const base = currentSelection?.baseBranch || 'develop';
    const target = currentSelection?.targetBranch || '';
    await exportFindings(findings, base, target);
  });

  // ============================================================
  // COMMAND: Select Base Branch
  // ============================================================
  const selectBaseCmd = vscode.commands.registerCommand('selfReview.selectBaseBranch', async () => {
    try {
      const wsFolder = getWorkspaceFolder();
      const config = await loadConfig();
      const engine = new GitDiffEngine(wsFolder);
      const baseBranch = await pickBaseBranch(engine, config.baseBranch);
      if (baseBranch && currentSelection) {
        currentSelection.baseBranch = baseBranch;
        currentSelection.mergeBase = engine.getMergeBase(baseBranch, currentSelection.targetBranch || 'HEAD');
        updateStatusBar('idle');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Self Review: ${msg}`);
    }
  });

  // ============================================================
  // COMMAND: Select Target Branch
  // ============================================================
  const selectTargetCmd = vscode.commands.registerCommand('selfReview.selectTargetBranch', async () => {
    try {
      const wsFolder = getWorkspaceFolder();
      const engine = new GitDiffEngine(wsFolder);
      const targetBranch = await pickTargetBranch(engine);
      if (targetBranch !== undefined && currentSelection) {
        currentSelection.targetBranch = targetBranch;
        currentSelection.includeUncommitted = !targetBranch;
        currentSelection.mergeBase = engine.getMergeBase(currentSelection.baseBranch, targetBranch || 'HEAD');
        updateStatusBar('idle');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Self Review: ${msg}`);
    }
  });

  // ============================================================
  // COMMAND: Init Config
  // ============================================================
  const initConfigCmd = vscode.commands.registerCommand('selfReview.initConfig', async () => {
    const wsFolder = getWorkspaceFolder();
    const configPath = path.join(wsFolder.uri.fsPath, '.self-review.yml');
    if (fs.existsSync(configPath)) {
      const overwrite = await vscode.window.showWarningMessage(
        '.self-review.yml already exists. Overwrite?',
        'Yes', 'No'
      );
      if (overwrite !== 'Yes') { return; }
    }
    fs.writeFileSync(configPath, generateSampleConfig(), 'utf-8');
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
  });

  // ============================================================
  // COMMENT THREAD ACTIONS: Skip, Fix Inline, Fix in Chat, Fix in Edits
  // ============================================================
  const skipFindingCmd = vscode.commands.registerCommand('selfReview.skipFinding', (thread: vscode.CommentThread) => {
    const findingId = commentManager.findingIdFromThread(thread);
    if (findingId) {
      commentManager.resolveFinding(findingId);
      taskListProvider.updateFinding(findingId, { status: 'skipped' });
      updateStatusBar('findings');
    }
  });

  const fixInlineCmd = vscode.commands.registerCommand('selfReview.fixInline', async (thread: vscode.CommentThread) => {
    const findingId = commentManager.findingIdFromThread(thread);
    if (!findingId) { return; }
    const finding = taskListProvider.getFinding(findingId);
    if (!finding) { return; }

    const success = await getFixActions().fixInline(finding);
    if (success) {
      commentManager.resolveFinding(findingId);
      taskListProvider.updateFinding(findingId, { status: 'fixed' });
      updateStatusBar('findings');
    }
  });

  const fixInChatCmd = vscode.commands.registerCommand('selfReview.fixInChat', async (thread: vscode.CommentThread) => {
    const findingId = commentManager.findingIdFromThread(thread);
    if (!findingId) { return; }
    const finding = taskListProvider.getFinding(findingId);
    if (!finding) { return; }
    await getFixActions().fixInChat(finding);
  });

  const fixInEditsCmd = vscode.commands.registerCommand('selfReview.fixInEdits', async (thread: vscode.CommentThread) => {
    const findingId = commentManager.findingIdFromThread(thread);
    if (!findingId) { return; }
    const finding = taskListProvider.getFinding(findingId);
    if (!finding) { return; }
    await getFixActions().fixInEdits(finding);
  });

  // ============================================================
  // TREE VIEW ACTIONS: Go To, Skip, Fix
  // ============================================================
  const goToFindingCmd = vscode.commands.registerCommand('selfReview.goToFinding', async (arg: unknown) => {
    const findingId = resolveFindingId(arg);
    if (!findingId) { return; }

    const finding = taskListProvider.getFinding(findingId);
    if (!finding) { return; }

    const wsFolder = getWorkspaceFolder();
    const uri = vscode.Uri.joinPath(wsFolder.uri, finding.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    const startLine = Math.max(0, finding.startLine - 1);
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(startLine, 0)
    );
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(range.start, range.start);
  });

  const skipTreeItemCmd = vscode.commands.registerCommand('selfReview.skipTreeItem', (item: TaskListItem) => {
    if (item.findingId) {
      commentManager.resolveFinding(item.findingId);
      taskListProvider.updateFinding(item.findingId, { status: 'skipped' });
      updateStatusBar('findings');
    }
  });

  const fixTreeItemCmd = vscode.commands.registerCommand('selfReview.fixTreeItem', async (item: TaskListItem) => {
    if (!item.findingId) { return; }
    const finding = taskListProvider.getFinding(item.findingId);
    if (!finding) { return; }

    const success = await getFixActions().fixInline(finding);
    if (success) {
      commentManager.resolveFinding(item.findingId);
      taskListProvider.updateFinding(item.findingId, { status: 'fixed' });
      updateStatusBar('findings');
    }
  });

  // Register all disposables
  context.subscriptions.push(
    commentManager,
    treeView,
    statusBarItem,
    reviewBranchCmd,
    reviewFileCmd,
    refreshCmd,
    clearCmd,
    exportCmd,
    selectBaseCmd,
    selectTargetCmd,
    initConfigCmd,
    skipFindingCmd,
    fixInlineCmd,
    fixInChatCmd,
    fixInEditsCmd,
    goToFindingCmd,
    skipTreeItemCmd,
    fixTreeItemCmd,
  );

  // ============================================================
  // Status bar helpers
  // ============================================================
  function updateStatusBar(state: 'idle' | 'reviewing' | 'findings') {
    const findings = taskListProvider.getFindings();
    const open = findings.filter(f => f.status === 'open').length;
    const branchInfo = currentSelection
      ? `${currentSelection.baseBranch}..${currentSelection.targetBranch || 'HEAD+wt'}`
      : '';

    switch (state) {
      case 'idle':
        statusBarItem.text = branchInfo ? `$(git-compare) Self Review: ${branchInfo}` : '$(git-compare) Self Review';
        statusBarItem.tooltip = 'Click to run Self Review';
        break;
      case 'reviewing':
        statusBarItem.text = `$(loading~spin) Self Review: Analyzing...`;
        statusBarItem.tooltip = 'Review in progress...';
        break;
      case 'findings':
        statusBarItem.text = `$(checklist) Self Review: ${open} open ${branchInfo ? `(${branchInfo})` : ''}`;
        statusBarItem.tooltip = `${findings.length} total findings, ${open} open`;
        break;
    }
  }

  // ============================================================
  // Core review runner
  // ============================================================
  async function runReview(
    wsFolder: vscode.WorkspaceFolder,
    engine: GitDiffEngine,
    config: import('./types').SelfReviewConfig,
    selection: BranchSelection,
    comments: CommentManager,
    taskList: TaskListProvider,
    reviewer: ReviewEngine,
    filePaths?: string[]
  ): Promise<void> {
    updateStatusBar('reviewing');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Self Review',
        cancellable: true,
      },
      async (progress, token) => {
        try {
          // Step 1: Get diff
          progress.report({ message: 'Computing diff...', increment: 10 });
          const rawDiff = engine.getDiff(selection, filePaths);

          if (!rawDiff.trim()) {
            vscode.window.showInformationMessage('Self Review: No changes found between the branches.');
            updateStatusBar('idle');
            return;
          }

          // Step 2: Parse diff
          progress.report({ message: 'Parsing diff...', increment: 10 });
          const diffFiles = engine.parseDiff(rawDiff, config.excludePaths);

          if (diffFiles.length === 0) {
            vscode.window.showInformationMessage('Self Review: All changed files are excluded.');
            updateStatusBar('idle');
            return;
          }

          // Step 3: Resolve file contents
          progress.report({ message: `Loading ${diffFiles.length} files...`, increment: 10 });
          engine.resolveFileContents(diffFiles, selection);

          // Step 4: Chunk for AI
          progress.report({ message: 'Preparing review chunks...', increment: 5 });
          const chunks = chunkDiffFiles(diffFiles, config);

          // Step 5: Run AI review on each chunk
          const allFindings: ReviewFinding[] = [];
          for (let i = 0; i < chunks.length; i++) {
            if (token.isCancellationRequested) { break; }

            progress.report({
              message: `Reviewing chunk ${i + 1}/${chunks.length} (${chunks[i].files.map(f => f.path).join(', ')})...`,
              increment: Math.floor(55 / chunks.length),
            });

            try {
              const findings = await reviewer.reviewChunk(chunks[i], config, token);
              allFindings.push(...findings);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              vscode.window.showWarningMessage(`Self Review: Chunk ${i + 1} failed: ${msg}`);
            }
          }

          if (token.isCancellationRequested) {
            updateStatusBar('idle');
            return;
          }

          // Step 6: Deduplicate findings (same file + overlapping lines)
          const deduped = deduplicateFindings(allFindings);

          // Step 7: Create comments and populate tree
          progress.report({ message: 'Creating review comments...', increment: 10 });
          taskList.setFindings(deduped);
          for (const finding of deduped) {
            comments.addFinding(finding, wsFolder);
          }

          updateStatusBar('findings');

          // Show summary notification
          const openCount = deduped.filter(f => f.status === 'open').length;
          const fileCount = new Set(deduped.map(f => f.file)).size;
          const action = await vscode.window.showInformationMessage(
            `Self Review: Found ${openCount} issue${openCount !== 1 ? 's' : ''} across ${fileCount} file${fileCount !== 1 ? 's' : ''}.`,
            'Show Task List',
            'Export'
          );

          if (action === 'Show Task List') {
            vscode.commands.executeCommand('selfReview.taskList.focus');
          } else if (action === 'Export') {
            vscode.commands.executeCommand('selfReview.exportMarkdown');
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Self Review: ${msg}`);
          updateStatusBar('idle');
        }
      }
    );
  }
}

/** Remove duplicate findings with overlapping file + line ranges */
function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const result: ReviewFinding[] = [];

  for (const f of findings) {
    const key = `${f.file}:${f.startLine}:${f.title.toLowerCase().slice(0, 40)}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    result.push(f);
  }

  return result;
}

export function deactivate() {
  // Cleanup handled by disposables
}
