import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ReviewSession } from './types';

// ────────────────────────────────────────────────
// Message types
// ────────────────────────────────────────────────

/** Extension → Webview */
export interface WebviewMessage {
  type:
    | 'setBranches'
    | 'setSelectedBranches'
    | 'setModels'
    | 'setReviewState'
    | 'addTask'
    | 'updateTask'
    | 'addSubStep'
    | 'updateSubStep'
    | 'streamToken'
    | 'setReviewSummary'
    | 'resetReview'
    | 'setHistory'
    | 'showReviewDetail'
    | 'showHistoryList'
    | 'setInstructionsStatus';
  payload?: unknown;
}

/** Webview → Extension */
export interface ExtensionMessage {
  type:
    | 'runReview'
    | 'stopReview'
    | 'clearReview'
    | 'exportMarkdown'
    | 'refreshBranches'
    | 'setBaseBranch'
    | 'setTargetBranch'
    | 'setModel'
    | 'ready'
    | 'loadHistory'
    | 'openReview'
    | 'deleteReview'
    | 'backToHistory'
    | 'newReview'
    | 'openInstructions'
    | 'createInstructions';
  payload?: unknown;
}

export type ReviewState = 'idle' | 'reviewing' | 'done' | 'error';

/** Top-level task in the agent loop */
export interface AgentTask {
  id: string;
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  collapsible?: boolean;
}

/** Sub-step under a task */
export interface AgentSubStep {
  taskId: string;
  id: string;
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
}

/** Legacy compat for history persistence */
export interface AgentStep {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
}

// ────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'copilotReviewAgent.controlPanel';
  private static readonly MAX_PENDING = 500;
  private static readonly READY_TIMEOUT_MS = 5000;
  private _view?: vscode.WebviewView;
  private _webviewReady = false;
  private _pendingMessages: WebviewMessage[] = [];
  private _readyListener?: vscode.Disposable;
  private _readyTimeout?: ReturnType<typeof setTimeout>;

  private readonly _onDidResolveView = new vscode.EventEmitter<vscode.WebviewView>();
  /**
   * Fires when the webview view is resolved.
   *
   * **Registering message handlers** (`onDidReceiveMessage`): safe to do synchronously
   * here — the handler will be attached before any webview messages arrive.
   *
   * **Posting messages** (`postMessage`): the real sidebar HTML is loaded
   * asynchronously after this event fires. Messages posted before the HTML sends its
   * `'ready'` signal are queued and flushed automatically once it does. However, the
   * queue is capped at `SidebarViewProvider.MAX_PENDING` (currently
   * {@link SidebarViewProvider.MAX_PENDING}) entries — older messages are dropped when
   * the cap is reached. Avoid sending large bursts of messages from this callback;
   * prefer deferring them until after the webview is ready.
   */
  public readonly onDidResolveView = this._onDidResolveView.event;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  dispose(): void {
    this._onDidResolveView.dispose();
    this._view = undefined;
    this._webviewReady = false;
    this._pendingMessages = [];
    clearTimeout(this._readyTimeout);
    this._readyListener?.dispose();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    // Clear any stale state from a previous resolution. This ensures that if
    // resolveWebviewView is called again (e.g., sidebar hidden and re-shown)
    // before the old webview's onDidDispose fires, we don't hold stale references.
    this._pendingMessages = [];
    this._webviewReady = false;
    clearTimeout(this._readyTimeout);
    this._readyListener?.dispose();
    this._readyListener = undefined;

    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getPlaceholderHtml();
    // The ready listener and timeout are set up inside _loadHtmlAsync, after the real
    // HTML is loaded. Registering them here (on the placeholder) would create a race:
    // if readyTimeout fired before the async load completed, flushPending() would mark
    // _webviewReady = true and flush messages into the placeholder; when _loadHtmlAsync
    // then replaced the HTML the webview would reset and those messages would be lost.
    void this._loadHtmlAsync(webviewView);

    webviewView.onDidDispose(() => {
      clearTimeout(this._readyTimeout);
      this._readyListener?.dispose();
      this._readyListener = undefined;
      this._view = undefined;
      this._webviewReady = false;
      this._pendingMessages = [];
    });

    this._onDidResolveView.fire(webviewView);
  }

  get view(): vscode.WebviewView | undefined { return this._view; }

  postMessage(message: WebviewMessage): void {
    if (this._view && this._webviewReady) {
      this._view.webview.postMessage(message);
    } else {
      if (this._pendingMessages.length >= SidebarViewProvider.MAX_PENDING) {
        this._pendingMessages.shift(); // drop oldest
      }
      this._pendingMessages.push(message);
    }
  }

  // ── Convenience helpers ──

  setBranches(locals: string[], remotes: string[], currentBranch: string): void {
    this.postMessage({ type: 'setBranches', payload: { locals, remotes, currentBranch } });
  }
  setSelectedBranches(baseBranch: string, targetBranch: string): void {
    this.postMessage({ type: 'setSelectedBranches', payload: { baseBranch, targetBranch } });
  }
  setModels(models: { id: string; label: string }[], selectedId?: string): void {
    this.postMessage({ type: 'setModels', payload: { models, selectedId } });
  }
  setReviewState(state: ReviewState): void {
    this.postMessage({ type: 'setReviewState', payload: { state } });
  }
  addTask(task: AgentTask): void {
    this.postMessage({ type: 'addTask', payload: task });
  }
  updateTask(task: Partial<AgentTask> & { id: string }): void {
    this.postMessage({ type: 'updateTask', payload: task });
  }
  addSubStep(step: AgentSubStep): void {
    this.postMessage({ type: 'addSubStep', payload: step });
  }
  updateSubStep(step: Partial<AgentSubStep> & { taskId: string; id: string }): void {
    this.postMessage({ type: 'updateSubStep', payload: step });
  }
  streamToken(taskId: string, subStepId: string, token: string): void {
    this.postMessage({ type: 'streamToken', payload: { taskId, subStepId, token } });
  }
  private legacyIdCounter = 0;
  /** Legacy compat for history replays */
  addAgentStep(step: AgentStep): void {
    const id = 'legacy-' + step.label.replace(/[^a-zA-Z0-9]/g, '_') + '-' + (this.legacyIdCounter++);
    this.addTask({
      id, label: step.label,
      status: step.status === 'pending' ? 'running' : step.status as 'running' | 'done' | 'error',
      detail: step.detail, collapsible: false,
    });
  }
  setReviewSummary(openCount: number, fileCount: number, totalFindings: number): void {
    this.postMessage({ type: 'setReviewSummary', payload: { openCount, fileCount, totalFindings } });
  }
  resetReview(): void {
    this.postMessage({ type: 'resetReview' });
  }
  setHistory(sessions: ReviewSession[]): void {
    const items = sessions.map(s => ({
      id: s.id,
      timestamp: s.timestamp,
      baseBranch: s.baseBranch,
      targetBranch: s.targetBranch,
      totalFindings: s.summary?.totalFindings ?? s.findings.length,
      openCount: s.summary?.openCount ?? s.findings.filter(f => f.status === 'open').length,
      fileCount: s.summary?.fileCount ?? new Set(s.findings.map(f => f.file)).size,
    }));
    this.postMessage({ type: 'setHistory', payload: items });
  }
  showReviewDetail(session: ReviewSession): void {
    this.postMessage({
      type: 'showReviewDetail',
      payload: {
        isPastReview: true,
        id: session.id,
        timestamp: session.timestamp,
        baseBranch: session.baseBranch,
        targetBranch: session.targetBranch,
        agentSteps: session.agentSteps,
        summary: session.summary,
      },
    });
  }
  showNewReview(): void {
    this.postMessage({ type: 'showReviewDetail', payload: { isPastReview: false } });
  }
  showHistoryList(): void {
    this.postMessage({ type: 'showHistoryList' });
  }
  setInstructionsStatus(exists: boolean, path?: string): void {
    this.postMessage({ type: 'setInstructionsStatus', payload: { exists, path } });
  }

  // ────────────────────────────────────────────────
  // HTML
  // ────────────────────────────────────────────────
  private _getPlaceholderHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
  <title>Code Review</title>
  <style nonce="${nonce}">
    #loading {
      padding: 20px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="loading">
    <p>Loading...</p>
  </div>
  <script nonce="${nonce}"></script>
</body>
</html>`;
  }

  private async _loadHtmlAsync(webviewView: vscode.WebviewView): Promise<void> {
    try {
      // Use vscode.workspace.fs.readFile which handles virtual file systems correctly
      // (e.g., SSH, WSL, Codespaces) and doesn't block the extension host main thread.
      const htmlUri = vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.html');
      const htmlBytes = await vscode.workspace.fs.readFile(htmlUri);
      const html = new TextDecoder().decode(htmlBytes);

      // Warn if any <script> or <style> tag is missing the nonce placeholder — such
      // tags will be silently blocked by the Content-Security-Policy at runtime.
      validateNonces(html);

      const nonce = getNonce();
      const htmlWithNonce = html.replace(/\{\{NONCE\}\}/g, nonce);

      // Bail out if the webview was disposed while we were awaiting the file read.
      if (this._view !== webviewView) { return; }

      // Reset ready state before swapping HTML. If a previous readyTimeout already
      // fired and flushed messages into the placeholder, those messages are now lost
      // (the placeholder had no real handlers). Resetting here ensures the pending
      // queue is flushed again once the real HTML signals 'ready'.
      this._webviewReady = false;
      clearTimeout(this._readyTimeout);
      this._readyListener?.dispose();

      webviewView.webview.html = htmlWithNonce;

      // Set up the flush-on-ready mechanism now that the real HTML is in place.
      // Placing this here (not in resolveWebviewView) eliminates the race condition
      // described above.
      const flushPending = () => {
        if (this._view !== webviewView) { return; } // view disposed; don't post into a stale webview
        if (this._webviewReady) { return; }
        this._webviewReady = true;
        this._readyListener?.dispose();
        this._readyListener = undefined;
        clearTimeout(this._readyTimeout);
        for (const pending of this._pendingMessages) {
          webviewView.webview.postMessage(pending);
        }
        this._pendingMessages = [];
      };
      // Note: This listener only acts on 'ready' messages. Other messages sent by the
      // webview before the main handler is set up will still fire to other listeners.
      // The extension host registers its onDidReceiveMessage handler synchronously in
      // the onDidResolveView callback, so those messages won't be lost.
      this._readyListener = webviewView.webview.onDidReceiveMessage((msg: ExtensionMessage) => {
        if (msg.type === 'ready') {
          flushPending();
        }
      });
      this._readyTimeout = setTimeout(flushPending, SidebarViewProvider.READY_TIMEOUT_MS);
    } catch (error) {
      console.error('Failed to load sidebar HTML:', error);
      // Keep the placeholder HTML if loading fails
    }
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Warns at runtime if any `<script>` or `<style>` opening tag in the HTML template
 * is missing a `nonce="{{NONCE}}"` attribute. The Content-Security-Policy set by the
 * template blocks all such tags silently, making this easy to miss.
 */
function validateNonces(html: string): void {
  const openingTagPattern = /<(script|style)(\s[^>]*)?>/gi;
  let match: RegExpExecArray | null;
  const missing: string[] = [];
  while ((match = openingTagPattern.exec(html)) !== null) {
    const [fullTag] = match;
    if (!fullTag.includes('nonce=')) {
      missing.push(fullTag.length > 80 ? fullTag.substring(0, 77) + '...' : fullTag);
    }
  }
  if (missing.length > 0) {
    console.error(
      '[copilot-review-agent] sidebar.html contains <script>/<style> tags without a nonce attribute.\n' +
      'These will be silently blocked by the Content-Security-Policy. ' +
      'Add nonce="{{NONCE}}" to each:\n' +
      missing.map(t => `  ${t}`).join('\n')
    );
  }
}

