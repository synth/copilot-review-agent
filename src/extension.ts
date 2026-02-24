import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { BranchSelection, ReviewFinding } from './types';
import { loadConfig, generateSampleConfig, getInstructionsFilePath, INSTRUCTIONS_FILENAME, generateSampleInstructions } from './config';
import { GitDiffEngine, pickBaseBranch, pickTargetBranch } from './git';
import { chunkDiffFiles } from './chunker';
import { ReviewEngine } from './reviewer';
import { CommentManager } from './comments';
import { TaskListProvider, TaskListItem } from './taskList';
import { FixActions } from './fixActions';
import { exportFindings } from './export';
import { SidebarViewProvider, ExtensionMessage } from './sidebarView';
import { ReviewStore } from './reviewStore';
import { ReviewSession, ReviewAgentStep, nextSessionId } from './types';

/** Current session state */
let currentSelection: BranchSelection | undefined;
let currentSessionId: string | undefined;
let statusBarItem: vscode.StatusBarItem;
let activeTokenSource: vscode.CancellationTokenSource | undefined;

export function activate(context: vscode.ExtensionContext) {
  // Core managers
  const commentManager = new CommentManager();
  const taskListProvider = new TaskListProvider();
  const reviewEngine = new ReviewEngine();

  // Sidebar webview provider
  const sidebarProvider = new SidebarViewProvider(context.extensionUri);
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    SidebarViewProvider.viewType,
    sidebarProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  );

  // Review history persistence
  const reviewStore = new ReviewStore(context.workspaceState);

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
  const reviewBranchCmd = vscode.commands.registerCommand('selfReview.reviewBranch', async (args?: { baseBranch?: string; targetBranch?: string }) => {
    try {
      const wsFolder = getWorkspaceFolder();
      const config = await loadConfig();
      const engine = new GitDiffEngine(wsFolder);

      let baseBranch: string | undefined;
      let targetBranch: string | undefined;

      if (args?.baseBranch) {
        // Called from sidebar with pre-selected branches
        baseBranch = args.baseBranch;
        targetBranch = args.targetBranch ?? '';
      } else {
        // Fallback: prompt via QuickPick
        baseBranch = await pickBaseBranch(engine, config.baseBranch);
        if (!baseBranch) { return; }

        targetBranch = await pickTargetBranch(engine);
        if (targetBranch === undefined) { return; }
      }

      // Validate base branch exists
      if (!engine.refExists(baseBranch)) {
        vscode.window.showErrorMessage(`Self Review: Base branch "${baseBranch}" not found.`);
        sidebarProvider.setReviewState('error');
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
        sidebarProvider.setReviewState('error');
        return;
      }

      currentSelection = {
        baseBranch,
        targetBranch: targetBranch ?? '',
        includeUncommitted: !targetBranch ? config.includeUncommitted : false,
        mergeBase,
      };

      await runReview(wsFolder, engine, config, currentSelection, commentManager, taskListProvider, reviewEngine, sidebarProvider);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Self Review: ${msg}`);
      sidebarProvider.setReviewState('error');
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

      await runReview(wsFolder, engine, config, selection, commentManager, taskListProvider, reviewEngine, sidebarProvider, [relativePath]);
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
      await runReview(wsFolder, engine, config, currentSelection, commentManager, taskListProvider, reviewEngine, sidebarProvider);
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
    sidebarProvider.resetReview();
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
  // COMMAND: Sort Findings
  // ============================================================
  const sortFindingsCmd = vscode.commands.registerCommand('selfReview.sortFindings', async () => {
    const current = taskListProvider.getSortMode();
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(list-ordered) Alphabetical', description: 'Sort files A → Z', mode: 'alphabetical' as const },
        { label: '$(graph) Most Findings', description: 'Sort by number of findings (descending)', mode: 'findingsCount' as const },
      ],
      { placeHolder: `Sort findings by… (current: ${current})` },
    );
    if (picked) {
      taskListProvider.setSortMode(picked.mode);
    }
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
  // HELPER: persist finding status changes to the store
  // ============================================================
  function persistFindings(): void {
    if (currentSessionId) {
      reviewStore.updateFindings(currentSessionId, taskListProvider.getFindings());
    }
  }

  // ============================================================
  // COMMENT THREAD ACTIONS: Skip, Fix Inline, Fix in Chat, Fix in Edits
  // ============================================================
  const skipFindingCmd = vscode.commands.registerCommand('selfReview.skipFinding', (thread: vscode.CommentThread) => {
    const findingId = commentManager.findingIdFromThread(thread);
    if (findingId) {
      commentManager.resolveFinding(findingId);
      taskListProvider.updateFinding(findingId, { status: 'skipped' });
      updateStatusBar('findings');
      persistFindings();
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
      persistFindings();
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
      persistFindings();
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
      persistFindings();
    }
  });

  // ============================================================
  // SIDEBAR MESSAGE HANDLER
  // ============================================================
  // HELPER: send history to sidebar
  // ============================================================
  function sendHistory(): void {
    const sessions = reviewStore.getAll();
    sidebarProvider.setHistory(sessions);
  }

  // ============================================================
  function setupSidebarMessageHandler(): void {
    // Watch for the view to become available, then listen for messages
    const checkView = setInterval(() => {
      if (sidebarProvider.view) {
        clearInterval(checkView);
        sidebarProvider.view.webview.onDidReceiveMessage(
          async (msg: ExtensionMessage) => {
            switch (msg.type) {
              case 'loadHistory': {
                sendHistory();
                break;
              }
              case 'refreshBranches': {
                try {
                  const wsFolder = getWorkspaceFolder();
                  const engine = new GitDiffEngine(wsFolder);
                  const config = await loadConfig();
                  const locals = engine.getLocalBranches();
                  const remotes = engine.getRemoteBranches();
                  const current = engine.getCurrentBranch();
                  sidebarProvider.setBranches(locals, remotes, current);
                  sidebarProvider.setSelectedBranches(config.baseBranch, config.targetBranch);
                } catch (err: unknown) {
                  const msg2 = err instanceof Error ? err.message : String(err);
                  vscode.window.showErrorMessage(`Self Review: ${msg2}`);
                }
                break;
              }
              case 'setBaseBranch': {
                break;
              }
              case 'setTargetBranch': {
                break;
              }
              case 'runReview': {
                const payload = msg.payload as { baseBranch: string; targetBranch: string; modelId?: string };
                if (payload.modelId) {
                  reviewEngine.setModel(payload.modelId);
                }
                await vscode.commands.executeCommand('selfReview.reviewBranch', {
                  baseBranch: payload.baseBranch,
                  targetBranch: payload.targetBranch,
                });
                break;
              }
              case 'stopReview': {
                if (activeTokenSource) {
                  activeTokenSource.cancel();
                }
                break;
              }
              case 'setModel': {
                const modelId = msg.payload as string;
                reviewEngine.setModel(modelId || undefined);
                break;
              }
              case 'clearReview': {
                await vscode.commands.executeCommand('selfReview.clearReview');
                break;
              }
              case 'exportMarkdown': {
                await vscode.commands.executeCommand('selfReview.exportMarkdown');
                break;
              }
              case 'newReview': {
                // Switch to new review detail screen and load branches
                sidebarProvider.showNewReview();
                try {
                  const wsFolder = getWorkspaceFolder();
                  const engine = new GitDiffEngine(wsFolder);
                  const config = await loadConfig();
                  const locals = engine.getLocalBranches();
                  const remotes = engine.getRemoteBranches();
                  const current = engine.getCurrentBranch();
                  sidebarProvider.setBranches(locals, remotes, current);
                  sidebarProvider.setSelectedBranches(config.baseBranch, config.targetBranch);

                  // Load available models
                  const models = await reviewEngine.listModels();
                  sidebarProvider.setModels(
                    models.map(m => ({ id: m.id, label: m.name || m.family })),
                    reviewEngine.selectedModelId
                  );

                  // Send instructions file status
                  const instrPath = await getInstructionsFilePath();
                  sidebarProvider.setInstructionsStatus(!!instrPath);
                } catch (err: unknown) {
                  const msg2 = err instanceof Error ? err.message : String(err);
                  vscode.window.showErrorMessage(`Self Review: ${msg2}`);
                }
                break;
              }
              case 'openInstructions': {
                try {
                  const instrPath = await getInstructionsFilePath();
                  if (instrPath) {
                    const doc = await vscode.workspace.openTextDocument(instrPath);
                    await vscode.window.showTextDocument(doc);
                  } else {
                    vscode.window.showWarningMessage(`Self Review: Instructions file not found. Create one first.`);
                  }
                } catch (err: unknown) {
                  const msg2 = err instanceof Error ? err.message : String(err);
                  vscode.window.showErrorMessage(`Self Review: ${msg2}`);
                }
                break;
              }
              case 'createInstructions': {
                try {
                  const wsFolder = getWorkspaceFolder();
                  const filePath = vscode.Uri.file(`${wsFolder}/${INSTRUCTIONS_FILENAME}`);
                  const content = generateSampleInstructions();
                  await vscode.workspace.fs.writeFile(filePath, Buffer.from(content, 'utf-8'));
                  const doc = await vscode.workspace.openTextDocument(filePath);
                  await vscode.window.showTextDocument(doc);
                  // Update sidebar to reflect the new file exists
                  sidebarProvider.setInstructionsStatus(true);
                } catch (err: unknown) {
                  const msg2 = err instanceof Error ? err.message : String(err);
                  vscode.window.showErrorMessage(`Self Review: ${msg2}`);
                }
                break;
              }
              case 'openReview': {
                const sessionId = msg.payload as string;
                const session = reviewStore.get(sessionId);
                if (!session) {
                  vscode.window.showErrorMessage('Self Review: Review session not found.');
                  break;
                }
                // Load this session's findings into the tree view and comments
                commentManager.clearAll();
                taskListProvider.clearAll();
                currentSessionId = session.id;

                taskListProvider.setFindings(session.findings);
                const wsFolder = getWorkspaceFolder();
                for (const finding of session.findings) {
                  commentManager.addFinding(finding, wsFolder);
                }

                currentSelection = {
                  baseBranch: session.baseBranch,
                  targetBranch: session.targetBranch,
                  includeUncommitted: !session.targetBranch,
                };

                updateStatusBar('findings');
                sidebarProvider.showReviewDetail(session);
                break;
              }
              case 'deleteReview': {
                const deleteId = msg.payload as string;
                await reviewStore.delete(deleteId);
                // If we're viewing the deleted review, clear it
                if (currentSessionId === deleteId) {
                  commentManager.clearAll();
                  taskListProvider.clearAll();
                  currentSessionId = undefined;
                  currentSelection = undefined;
                  updateStatusBar('idle');
                }
                sendHistory();
                break;
              }
              case 'backToHistory': {
                // Clear current review display (keep data persisted)
                commentManager.clearAll();
                taskListProvider.clearAll();
                currentSessionId = undefined;
                currentSelection = undefined;
                updateStatusBar('idle');
                sendHistory();
                sidebarProvider.showHistoryList();
                break;
              }
            }
          },
          undefined,
          context.subscriptions
        );
      }
    }, 200);

    // Clean up the interval after 30 seconds if view never appeared
    setTimeout(() => clearInterval(checkView), 30_000);
  }

  setupSidebarMessageHandler();

  // Register all disposables
  context.subscriptions.push(
    commentManager,
    treeView,
    statusBarItem,
    sidebarRegistration,
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
    sortFindingsCmd,
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

    // Show/hide the Review Findings tree view based on state
    vscode.commands.executeCommand('setContext', 'selfReview.hasReview', state !== 'idle');

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
    sidebar: SidebarViewProvider,
    filePaths?: string[]
  ): Promise<void> {
    updateStatusBar('reviewing');
    sidebar.setReviewState('reviewing');

    // Track agent steps for persistence (legacy format for the store)
    const agentSteps: ReviewAgentStep[] = [];

    function legacyStep(label: string, status: 'running' | 'done' | 'error', detail?: string) {
      const existing = agentSteps.find(s => s.label === label);
      if (existing) {
        existing.status = status;
        existing.detail = detail;
      } else {
        agentSteps.push({ label, status, detail });
      }
    }

    // Task ID counter
    let taskSeq = 0;
    function nextTaskId(): string { return 't' + (++taskSeq); }
    let subSeq = 0;
    function nextSubId(): string { return 's' + (++subSeq); }

    const sessionId = nextSessionId();
    currentSessionId = sessionId;

    const tokenSource = new vscode.CancellationTokenSource();
    activeTokenSource = tokenSource;
    const token = tokenSource.token;

    try {
      // ────────────────────────────────
      // Task 1: Compute diff
      // ────────────────────────────────
      const diffTaskId = nextTaskId();
      sidebar.addTask({ id: diffTaskId, label: 'Analyzing diff', status: 'running', collapsible: true });
      legacyStep('Computing diff', 'running');

      // Sub-step: merge base
      const mergeBaseSubId = nextSubId();
      sidebar.addSubStep({ taskId: diffTaskId, id: mergeBaseSubId, label: 'Computing merge base', status: 'running' });

      const targetRef = selection.targetBranch || 'HEAD';
      sidebar.updateSubStep({ taskId: diffTaskId, id: mergeBaseSubId, label: 'Computing merge base', status: 'done', detail: `${selection.baseBranch}..${targetRef}` });

      // Sub-step: git diff
      const gitDiffSubId = nextSubId();
      sidebar.addSubStep({ taskId: diffTaskId, id: gitDiffSubId, label: 'Running git diff', status: 'running' });

      const rawDiff = engine.getDiff(selection, filePaths);
      if (!rawDiff.trim()) {
        sidebar.updateSubStep({ taskId: diffTaskId, id: gitDiffSubId, label: 'Running git diff', status: 'done', detail: 'No changes' });
        sidebar.updateTask({ id: diffTaskId, status: 'done', detail: 'No changes found' });
        legacyStep('Computing diff', 'done', 'No changes found');
        vscode.window.showInformationMessage('Self Review: No changes found between the branches.');
        updateStatusBar('idle');
        sidebar.setReviewState('idle');
        return;
      }
      sidebar.updateSubStep({ taskId: diffTaskId, id: gitDiffSubId, label: 'Running git diff', status: 'done' });

      // Sub-step: parse diff
      const parseSubId = nextSubId();
      sidebar.addSubStep({ taskId: diffTaskId, id: parseSubId, label: 'Parsing diff output', status: 'running' });
      const diffFiles = engine.parseDiff(rawDiff, config.excludePaths);

      if (diffFiles.length === 0) {
        sidebar.updateSubStep({ taskId: diffTaskId, id: parseSubId, label: 'Parsing diff output', status: 'done', detail: 'All files excluded' });
        sidebar.updateTask({ id: diffTaskId, status: 'done', detail: 'All files excluded' });
        legacyStep('Computing diff', 'done', 'All files excluded');
        vscode.window.showInformationMessage('Self Review: All changed files are excluded.');
        updateStatusBar('idle');
        sidebar.setReviewState('idle');
        return;
      }
      sidebar.updateSubStep({ taskId: diffTaskId, id: parseSubId, label: 'Parsing diff output', status: 'done', detail: `${diffFiles.length} file${diffFiles.length !== 1 ? 's' : ''} changed` });
      legacyStep('Computing diff', 'done');
      legacyStep('Parsing diff', 'done', `${diffFiles.length} file${diffFiles.length !== 1 ? 's' : ''}`);

      // Sub-step: list changed files
      for (const df of diffFiles) {
        const fileSubId = nextSubId();
        const sizeInfo = df.hunks.reduce((n, h) => n + h.addedLines.length, 0);
        sidebar.addSubStep({ taskId: diffTaskId, id: fileSubId, label: df.path, status: 'done', detail: `+${sizeInfo} lines` });
      }

      // Sub-step: resolve file contents
      const resolveSubId = nextSubId();
      sidebar.addSubStep({ taskId: diffTaskId, id: resolveSubId, label: 'Loading full file contents', status: 'running' });
      engine.resolveFileContents(diffFiles, selection);
      sidebar.updateSubStep({ taskId: diffTaskId, id: resolveSubId, label: 'Loading full file contents', status: 'done', detail: `${diffFiles.length} files` });
      legacyStep('Loading file contents', 'done', `${diffFiles.length} files`);

      sidebar.updateTask({ id: diffTaskId, status: 'done', detail: `${diffFiles.length} file${diffFiles.length !== 1 ? 's' : ''}` });

      // ────────────────────────────────
      // Task 2: Prepare chunks
      // ────────────────────────────────
      const chunkTaskId = nextTaskId();
      sidebar.addTask({ id: chunkTaskId, label: 'Preparing review chunks', status: 'running', collapsible: true });
      legacyStep('Preparing review chunks', 'running');

      const chunks = chunkDiffFiles(diffFiles, config);

      for (let i = 0; i < chunks.length; i++) {
        const files = chunks[i].files.map(f => f.path).join(', ');
        const tokens = Math.round(chunks[i].tokenEstimate / 1000);
        const chunkSubId = nextSubId();
        sidebar.addSubStep({
          taskId: chunkTaskId, id: chunkSubId,
          label: `Chunk ${i + 1}: ${chunks[i].files.length} file${chunks[i].files.length !== 1 ? 's' : ''}`,
          status: 'done',
          detail: `~${tokens}k tokens — ${files}`,
        });
      }

      sidebar.updateTask({ id: chunkTaskId, status: 'done', detail: `${chunks.length} chunk${chunks.length !== 1 ? 's' : ''}` });
      legacyStep('Preparing review chunks', 'done', `${chunks.length} chunk${chunks.length !== 1 ? 's' : ''}`);

      // ────────────────────────────────
      // Task 3+: AI review per chunk
      // ────────────────────────────────
      const allFindings: ReviewFinding[] = [];

      for (let i = 0; i < chunks.length; i++) {
        if (token.isCancellationRequested) { break; }

        const chunk = chunks[i];
        const chunkFiles = chunk.files.map(f => f.path);
        const reviewTaskId = nextTaskId();
        const taskLabel = chunks.length === 1
          ? 'Reviewing code with AI'
          : `Reviewing chunk ${i + 1} of ${chunks.length}`;

        sidebar.addTask({
          id: reviewTaskId,
          label: taskLabel,
          status: 'running',
          detail: chunkFiles.length + ' file' + (chunkFiles.length !== 1 ? 's' : ''),
          collapsible: true,
        });

        // Sub-step: list files being reviewed
        for (const fp of chunkFiles) {
          const fpSubId = nextSubId();
          sidebar.addSubStep({ taskId: reviewTaskId, id: fpSubId, label: fp, status: 'done' });
        }

        // Sub-step: AI analysis (with streaming tokens)
        const aiSubId = nextSubId();
        sidebar.addSubStep({ taskId: reviewTaskId, id: aiSubId, label: 'Waiting for AI response…', status: 'running' });

        const chunkLabel = `Reviewing chunk ${i + 1}/${chunks.length}`;
        legacyStep(chunkLabel, 'running', chunkFiles.join(', '));

        try {
          const findings = await reviewer.reviewChunk(chunk, config, token, (fragment) => {
            sidebar.streamToken(reviewTaskId, aiSubId, fragment);
          });

          allFindings.push(...findings);

          sidebar.updateSubStep({
            taskId: reviewTaskId, id: aiSubId,
            label: 'AI analysis complete',
            status: 'done',
            detail: `${findings.length} finding${findings.length !== 1 ? 's' : ''}`,
          });

          // Sub-steps: list each finding
          for (const f of findings) {
            const findSubId = nextSubId();
            const sevIcon = f.severity === 'blocker' ? '🔴' : f.severity === 'high' ? '🟠' : f.severity === 'medium' ? '🟡' : '🔵';
            sidebar.addSubStep({
              taskId: reviewTaskId, id: findSubId,
              label: `${sevIcon} ${f.title}`,
              status: 'done',
              detail: `${f.file}:${f.startLine}`,
            });
          }

          sidebar.updateTask({ id: reviewTaskId, status: 'done', detail: `${findings.length} finding${findings.length !== 1 ? 's' : ''}` });
          legacyStep(chunkLabel, 'done', `${findings.length} finding${findings.length !== 1 ? 's' : ''}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          sidebar.updateSubStep({ taskId: reviewTaskId, id: aiSubId, label: 'AI analysis failed', status: 'error', detail: msg });
          sidebar.updateTask({ id: reviewTaskId, status: 'error', detail: msg });
          legacyStep(chunkLabel, 'error', msg);
          vscode.window.showWarningMessage(`Self Review: Chunk ${i + 1} failed: ${msg}`);
        }
      }

      if (token.isCancellationRequested) {
        updateStatusBar('idle');
        sidebar.setReviewState('idle');
        return;
      }

      // ────────────────────────────────
      // Task: Post-processing
      // ────────────────────────────────
      const postTaskId = nextTaskId();
      sidebar.addTask({ id: postTaskId, label: 'Finalizing review', status: 'running', collapsible: true });
      legacyStep('Deduplicating findings', 'running');

      // Deduplicate
      const dedupSubId = nextSubId();
      sidebar.addSubStep({ taskId: postTaskId, id: dedupSubId, label: 'Deduplicating findings', status: 'running' });
      const deduped = deduplicateFindings(allFindings);
      sidebar.updateSubStep({ taskId: postTaskId, id: dedupSubId, label: 'Deduplicating findings', status: 'done', detail: `${deduped.length} unique of ${allFindings.length} total` });
      legacyStep('Deduplicating findings', 'done', `${deduped.length} unique`);

      // Create comments
      const commentSubId = nextSubId();
      sidebar.addSubStep({ taskId: postTaskId, id: commentSubId, label: 'Creating inline comments', status: 'running' });
      legacyStep('Creating review comments', 'running');
      taskList.setFindings(deduped);
      for (const finding of deduped) {
        comments.addFinding(finding, wsFolder);
      }
      sidebar.updateSubStep({ taskId: postTaskId, id: commentSubId, label: 'Creating inline comments', status: 'done', detail: `${deduped.length} comments` });
      legacyStep('Creating review comments', 'done');

      // Populate tree
      const treeSubId = nextSubId();
      sidebar.addSubStep({ taskId: postTaskId, id: treeSubId, label: 'Populating findings tree', status: 'done' });

      sidebar.updateTask({ id: postTaskId, status: 'done', detail: 'Done' });

      updateStatusBar('findings');
      sidebar.setReviewState('done');

      // Summary
      const openCount = deduped.filter(f => f.status === 'open').length;
      const fileCount = new Set(deduped.map(f => f.file)).size;
      sidebar.setReviewSummary(openCount, fileCount, deduped.length);

      // Persist
      const session: ReviewSession = {
        id: sessionId,
        timestamp: Date.now(),
        baseBranch: selection.baseBranch,
        targetBranch: selection.targetBranch,
        findings: deduped,
        agentSteps,
        summary: { totalFindings: deduped.length, openCount, fileCount },
      };
      await reviewStore.save(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const errTaskId = nextTaskId();
      sidebar.addTask({ id: errTaskId, label: 'Error', status: 'error', detail: msg });
      legacyStep('Error', 'error', msg);
      vscode.window.showErrorMessage(`Self Review: ${msg}`);
      updateStatusBar('idle');
      sidebar.setReviewState('error');
    } finally {
      activeTokenSource = undefined;
      tokenSource.dispose();
    }
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
