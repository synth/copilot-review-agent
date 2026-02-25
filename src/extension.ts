import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { BranchSelection, ReviewFinding } from './types';
import { loadConfig, generateSampleConfig, getInstructionsFilePath, INSTRUCTIONS_FILENAME, generateSampleInstructions } from './config';
import { GitDiffEngine, pickBaseBranch, pickTargetBranch } from './git';
import { resetWarnings } from './minimatch';
import { chunkDiffFiles } from './chunker';
import { ReviewEngine } from './reviewer';
import { CommentManager } from './comments';
import { TaskListProvider, TaskListItem } from './taskList';
import { FixActions } from './fixActions';
import { exportFindings } from './export';
import { SidebarViewProvider, ExtensionMessage } from './sidebarView';
import { ReviewStore } from './reviewStore';
import { ReviewSession, ReviewAgentStep, nextSessionId } from './types';

/** Held so deactivate() can cancel in-flight requests across activations. */
let activeTokenSource: vscode.CancellationTokenSource | undefined;

export function activate(context: vscode.ExtensionContext) {
  /** Per-activation mutable state */
  let currentSelection: BranchSelection | undefined;
  let currentSessionId: string | undefined;
  let controlPanelHidden = false;
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
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
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

  // Fix action handler (stateless – workspace folder is resolved per call)
  const fixActions = new FixActions(reviewEngine);

  function normalizeFsPathToWorkspace(fsPath: string, wsFolder: vscode.WorkspaceFolder): string {
    return path.relative(wsFolder.uri.fsPath, fsPath).split(path.sep).join('/');
  }

  // Helper: resolve a finding ID from various command sources
  function resolveFindingId(arg: unknown): string | undefined {
    if (typeof arg === 'string') { return arg; }
    // From tree item
    if (arg instanceof TaskListItem && arg.findingId) {
      return arg.findingId;
    }
    // From comment thread (check for CommentThread-specific shape)
    if (arg && typeof arg === 'object' && 'comments' in arg && 'uri' in arg) {
      const thread = arg as vscode.CommentThread;
      const mapped = commentManager.findingIdFromThread(thread);
      if (mapped) { return mapped; }

      // Fallback: match by file path and range if the thread mapping is missing.
      try {
        const wsFolder = getWorkspaceFolder();
        const file = normalizeFsPathToWorkspace(thread.uri.fsPath, wsFolder);
        const startLine = thread.range?.start.line;
        const endLine = thread.range?.end.line;
        if (startLine == null || endLine == null) { return undefined; }

        const findings = taskListProvider.getFindings();
        const exact = findings.find(f =>
          f.file === file && f.startLine - 1 === startLine && f.endLine - 1 === endLine
        );
        if (exact) { return exact.id; }

        const overlapping = findings.find(f =>
          f.file === file && (f.startLine - 1) <= endLine && (f.endLine - 1) >= startLine
        );
        return overlapping?.id;
      } catch {
        return undefined;
      }
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
        // Empty string means "HEAD + working tree" for in-progress changes.
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

      // Validate target branch exists (only when a non-empty string is provided)
      if (targetBranch && !engine.refExists(targetBranch)) {
        vscode.window.showErrorMessage(`Self Review: Target branch "${targetBranch}" not found.`);
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
      let selection = currentSelection;
      if (!selection) {
        const targetRef = config.targetBranch || 'HEAD';
        let mergeBase: string;
        try {
          mergeBase = engine.getMergeBase(config.baseBranch, targetRef);
        } catch {
          vscode.window.showErrorMessage(
            `Self Review: Cannot compute merge base between "${config.baseBranch}" and "${targetRef}". Are the branches related?`
          );
          return;
        }
        selection = {
          baseBranch: config.baseBranch,
          targetBranch: config.targetBranch,
          includeUncommitted: config.includeUncommitted,
          mergeBase,
        };
      }

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
    if (controlPanelHidden) {
      vscode.commands.executeCommand('selfReview.controlPanel.toggleVisibility');
      controlPanelHidden = false;
    }
  });

  // ============================================================
  // COMMAND: Export Markdown
  // ============================================================
  const exportCmd = vscode.commands.registerCommand('selfReview.exportMarkdown', async () => {
    const findings = taskListProvider.getFindings();
    const base = currentSelection?.baseBranch ?? '';
    const target = currentSelection?.targetBranch || '';
    await exportFindings(findings, base, target);
  });

  // ============================================================
  // COMMAND: Sort Findings
  // ============================================================
  const sortFindingsCmd = vscode.commands.registerCommand('selfReview.sortFindings', async () => {
    const currentSort = taskListProvider.getSortMode();
    const currentGroup = taskListProvider.getGroupBy();
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(list-ordered) Alphabetical', description: 'Sort files A → Z' + (currentGroup === 'file' && currentSort === 'alphabetical' ? ' (current)' : ''), mode: 'alphabetical' as const, group: 'file' as const },
        { label: '$(graph) Most Findings', description: 'Sort by number of findings (descending)' + (currentGroup === 'file' && currentSort === 'findingsCount' ? ' (current)' : ''), mode: 'findingsCount' as const, group: 'file' as const },
        { label: '$(warning) Group by Severity', description: 'Group findings by Blocker, High, Medium, etc.' + (currentGroup === 'severity' ? ' (current)' : ''), mode: currentSort, group: 'severity' as const },
      ],
      { placeHolder: `Sort / group findings… (current: ${currentGroup === 'severity' ? 'severity' : currentSort})` },
    );
    if (picked) {
      taskListProvider.setGroupBy(picked.group);
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
        const newMergeBase = engine.getMergeBase(baseBranch, currentSelection.targetBranch || 'HEAD');
        currentSelection.baseBranch = baseBranch;
        currentSelection.mergeBase = newMergeBase;
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
        const newMergeBase = engine.getMergeBase(currentSelection.baseBranch, targetBranch || 'HEAD');
        currentSelection.targetBranch = targetBranch;
        currentSelection.includeUncommitted = !targetBranch;
        currentSelection.mergeBase = newMergeBase;
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
    try {
      const wsFolder = getWorkspaceFolder();
      const configPath = path.join(wsFolder.uri.fsPath, '.self-review.yml');
      if (fs.existsSync(configPath)) {
        const overwrite = await vscode.window.showWarningMessage(
          '.self-review.yml already exists. Overwrite?',
          'Yes', 'No'
        );
        if (overwrite !== 'Yes') { return; }
      }
      await vscode.workspace.fs.writeFile(vscode.Uri.file(configPath), Buffer.from(generateSampleConfig(), 'utf-8'));
      const doc = await vscode.workspace.openTextDocument(configPath);
      await vscode.window.showTextDocument(doc);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Self Review: ${msg}`);
    }
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
    const findingId = resolveFindingId(thread);
    if (findingId) {
      commentManager.resolveFinding(findingId);
      taskListProvider.updateFinding(findingId, { status: 'skipped' });
      updateStatusBar('findings');
      persistFindings();
    }
  });

  const fixInlineCmd = vscode.commands.registerCommand('selfReview.fixInline', async (thread: vscode.CommentThread) => {
    const findingId = resolveFindingId(thread);
    if (!findingId) { return; }
    const finding = taskListProvider.getFinding(findingId);
    if (!finding) { return; }

    const initiated = await fixActions.fixInline(finding, getWorkspaceFolder());
    if (initiated) {
      commentManager.resolveFinding(findingId);
      taskListProvider.updateFinding(findingId, { status: 'fixed' });
      updateStatusBar('findings');
      persistFindings();
    }
  });

  const fixInChatCmd = vscode.commands.registerCommand('selfReview.fixInChat', async (thread: vscode.CommentThread) => {
    const findingId = resolveFindingId(thread);
    if (!findingId) { return; }
    const finding = taskListProvider.getFinding(findingId);
    if (!finding) { return; }
    const initiated = await fixActions.fixInChat(finding, getWorkspaceFolder());
    if (initiated) {
      commentManager.resolveFinding(findingId);
      taskListProvider.updateFinding(findingId, { status: 'fixed' });
      updateStatusBar('findings');
      persistFindings();
    }
  });

  const fixInEditsCmd = vscode.commands.registerCommand('selfReview.fixInEdits', async (thread: vscode.CommentThread) => {
    const findingId = resolveFindingId(thread);
    if (!findingId) { return; }
    const finding = taskListProvider.getFinding(findingId);
    if (!finding) { return; }
    const initiated = await fixActions.fixInEdits(finding, getWorkspaceFolder());
    if (initiated) {
      commentManager.resolveFinding(findingId);
      taskListProvider.updateFinding(findingId, { status: 'fixed' });
      updateStatusBar('findings');
      persistFindings();
    }
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

    const initiated = await fixActions.fixInline(finding, getWorkspaceFolder());
    if (initiated) {
      commentManager.resolveFinding(item.findingId);
      taskListProvider.updateFinding(item.findingId, { status: 'fixed' });
      updateStatusBar('findings');
      persistFindings();
    }
  });

  const fixAllInFileCmd = vscode.commands.registerCommand('selfReview.fixAllInFile', async (item: TaskListItem) => {
    if (!item.filePath) { return; }
    const findings = taskListProvider.getFileFindings(item.filePath);
    await fixActions.fixAllInFile(findings, item.filePath, getWorkspaceFolder());

    for (const finding of findings) {
      commentManager.resolveFinding(finding.id);
      taskListProvider.updateFinding(finding.id, { status: 'fixed' });
    }
    updateStatusBar('findings');
    persistFindings();
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

  // HELPER: navigate back to history list
  function backToHistory(): void {
    commentManager.clearAll();
    taskListProvider.clearAll();
    currentSessionId = undefined;
    currentSelection = undefined;
    updateStatusBar('idle');
    sendHistory();
    sidebarProvider.showHistoryList();
    vscode.commands.executeCommand('setContext', 'selfReview.inReviewDetail', false);
    if (controlPanelHidden) {
      vscode.commands.executeCommand('selfReview.controlPanel.toggleVisibility');
      controlPanelHidden = false;
    }
  }

  // ============================================================
  function setupSidebarMessageHandler(): vscode.Disposable[] {
    let messageListenerDisposable: vscode.Disposable | undefined;

    function registerHandler(webviewView: vscode.WebviewView): void {
        // Dispose any previous listener to avoid duplicate message handling
        messageListenerDisposable?.dispose();

        messageListenerDisposable = webviewView.webview.onDidReceiveMessage(
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
                const payload = msg.payload as { baseBranch?: unknown; targetBranch?: unknown; modelId?: unknown };
                if (typeof payload?.baseBranch !== 'string' || typeof payload?.targetBranch !== 'string') {
                  break;
                }
                if (typeof payload.modelId === 'string' && payload.modelId) {
                  const models = await reviewEngine.listModels();
                  if (models.some(m => m.id === payload.modelId)) {
                    reviewEngine.setModel(payload.modelId);
                  }
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
                if (msg.payload === undefined) {
                  reviewEngine.setModel(undefined);
                  break;
                }
                if (typeof msg.payload !== 'string') {
                  break;
                }
                const modelId = msg.payload.trim();
                if (!modelId) {
                  reviewEngine.setModel(undefined);
                  break;
                }
                const models = await reviewEngine.listModels();
                if (models.some(m => m.id === modelId)) {
                  reviewEngine.setModel(modelId);
                }
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
                vscode.commands.executeCommand('setContext', 'selfReview.inReviewDetail', true);
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
                  const filePath = vscode.Uri.file(path.join(wsFolder.uri.fsPath, INSTRUCTIONS_FILENAME));
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
                if (typeof msg.payload !== 'string') {
                  break;
                }
                const sessionId = msg.payload;
                const session = reviewStore.get(sessionId);
                if (!session) {
                  vscode.window.showErrorMessage('Self Review: Review session not found.');
                  break;
                }
                if (session.modelId) {
                  const models = await reviewEngine.listModels();
                  if (models.some(m => m.id === session.modelId)) {
                    reviewEngine.setModel(session.modelId);
                  }
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

                const engine = new GitDiffEngine(wsFolder);
                const targetRef = session.targetBranch || 'HEAD';
                let mergeBase: string;
                try {
                  mergeBase = engine.getMergeBase(session.baseBranch, targetRef);
                } catch {
                  vscode.window.showErrorMessage(
                    `Self Review: Cannot compute merge base between "${session.baseBranch}" and "${targetRef}". The branches may no longer exist or have diverged.`
                  );
                  break;
                }
                currentSelection = {
                  baseBranch: session.baseBranch,
                  targetBranch: session.targetBranch,
                  includeUncommitted: !session.targetBranch,
                  mergeBase,
                };

                updateStatusBar('findings');
                sidebarProvider.showReviewDetail(session);
                vscode.commands.executeCommand('setContext', 'selfReview.inReviewDetail', true);
                // Minimize Review Controls and focus findings for past review too
                if (!controlPanelHidden) {
                  vscode.commands.executeCommand('selfReview.controlPanel.toggleVisibility');
                  controlPanelHidden = true;
                }
                vscode.commands.executeCommand('selfReview.taskList.focus');
                break;
              }
              case 'deleteReview': {
                if (typeof msg.payload !== 'string') {
                  break;
                }
                const deleteId = msg.payload;
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
                backToHistory();
                break;
              }
            }
          },
        );
        // Proactively send history so the webview has data immediately
        sendHistory();
    }

    // If the view is already resolved, register immediately
    if (sidebarProvider.view) {
      registerHandler(sidebarProvider.view);
    }
    // Also listen for future resolutions (e.g. view hidden then re-shown)
    const resolveViewDisposable = sidebarProvider.onDidResolveView(registerHandler);

    // Return disposables so the caller can register them for cleanup
    return [
      resolveViewDisposable,
      { dispose: () => messageListenerDisposable?.dispose() },
    ];
  }

  // Register backToHistory command for view/title menu
  const backToHistoryCmd = vscode.commands.registerCommand('selfReview.backToHistory', () => {
    backToHistory();
  });

  const sidebarHandlerDisposables = setupSidebarMessageHandler();

  // Register all disposables
  context.subscriptions.push(
    ...sidebarHandlerDisposables,
    commentManager,
    treeView,
    statusBarItem,
    sidebarProvider,
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
    fixAllInFileCmd,
    sortFindingsCmd,
    backToHistoryCmd,
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
    // Keep it hidden during "reviewing" so the tab starts closed; only reveal when findings are ready.
    vscode.commands.executeCommand('setContext', 'selfReview.hasReview', state === 'findings');

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
    // Reset module-level state for this review session to ensure warnings fire correctly
    resetWarnings();

    if (activeTokenSource) {
      activeTokenSource.cancel();
      activeTokenSource.dispose();
      activeTokenSource = undefined;
    }
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

      const wasCancelled = token.isCancellationRequested;

      if (wasCancelled && allFindings.length === 0) {
        updateStatusBar('idle');
        sidebar.setReviewState('idle');
        return;
      }

      // ────────────────────────────────
      // Task: Post-processing
      // ────────────────────────────────
      const postTaskId = nextTaskId();
      sidebar.addTask({ id: postTaskId, label: wasCancelled ? 'Finalizing partial review' : 'Finalizing review', status: 'running', collapsible: true });
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

      // Minimize the Review Controls panel and focus the findings tree
      if (!controlPanelHidden) {
        vscode.commands.executeCommand('selfReview.controlPanel.toggleVisibility');
        controlPanelHidden = true;
      }
      vscode.commands.executeCommand('selfReview.taskList.focus');

      // Summary
      const openCount = deduped.filter(f => f.status === 'open').length;
      const fileCount = new Set(deduped.map(f => f.file)).size;
      sidebar.setReviewSummary(openCount, fileCount, deduped.length);

      if (wasCancelled) {
        vscode.window.showWarningMessage(
          `Self Review: Cancelled after processing some chunks. ${deduped.length} finding(s) from completed chunks have been preserved.`
        );
      }

      // Persist
      const session: ReviewSession = {
        id: sessionId,
        timestamp: Date.now(),
        baseBranch: selection.baseBranch,
        targetBranch: selection.targetBranch,
        modelId: reviewer.selectedModelId,
        findings: deduped,
        agentSteps,
        summary: { totalFindings: deduped.length, openCount, fileCount },
        ...(wasCancelled ? { partial: true } : {}),
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

  const normalizeTitleTokens = (text: string): string[] =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  const titleSimilarity = (a: string[], b: string[]): number => {
    if (a.length === 0 || b.length === 0) { return 0; }
    const aSet = new Set(a);
    const bSet = new Set(b);
    let intersection = 0;
    for (const token of aSet) {
      if (bSet.has(token)) { intersection++; }
    }
    const union = aSet.size + bSet.size - intersection;
    return union === 0 ? 0 : intersection / union;
  };

  const rangesOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
    aStart <= bEnd && aEnd >= bStart;

  for (const f of findings) {
    const normalizedTokens = normalizeTitleTokens(f.title);
    const normalizedTitle = normalizedTokens.join(' ');
    const key = `${f.file}:${f.startLine}:${f.endLine}:${normalizedTitle}`;
    if (seen.has(key)) { continue; }

    const hasNearDuplicate = result.some(r =>
      r.file === f.file
      && rangesOverlap(r.startLine, r.endLine, f.startLine, f.endLine)
      && titleSimilarity(normalizeTitleTokens(r.title), normalizedTokens) >= 0.6
    );
    if (hasNearDuplicate) { continue; }

    seen.add(key);
    result.push(f);
  }

  return result;
}

export function deactivate() {
  // Cancel any in-flight AI request
  activeTokenSource?.cancel();
  activeTokenSource?.dispose();
  activeTokenSource = undefined;
}
