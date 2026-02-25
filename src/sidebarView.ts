import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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
  public static readonly viewType = 'selfReview.controlPanel';
  private static readonly MAX_PENDING = 500;
  private static readonly READY_TIMEOUT_MS = 5000;
  private _view?: vscode.WebviewView;
  private _webviewReady = false;
  private _pendingMessages: WebviewMessage[] = [];

  private readonly _onDidResolveView = new vscode.EventEmitter<vscode.WebviewView>();
  /** Fires when the webview view is resolved and ready for messages.
   * Consumers should register webview message handlers synchronously in this callback
   * to avoid missing early messages from the webview.
   */
  public readonly onDidResolveView = this._onDidResolveView.event;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  dispose(): void {
    this._onDidResolveView.dispose();
    this._view = undefined;
    this._webviewReady = false;
    this._pendingMessages = [];
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getHtml();

    // Wait for the webview JS to signal readiness before flushing queued messages.
    // A timeout fallback ensures messages aren't queued forever if 'ready' is missed.
    this._webviewReady = false;
    const flushPending = () => {
      if (this._webviewReady) { return; }
      this._webviewReady = true;
      readyListener.dispose();
      for (const pending of this._pendingMessages) {
        webviewView.webview.postMessage(pending);
      }
      this._pendingMessages = [];
    };
    const readyListener = webviewView.webview.onDidReceiveMessage((msg: ExtensionMessage) => {
      if (msg.type === 'ready') {
        clearTimeout(readyTimeout);
        flushPending();
      }
    });
    const readyTimeout = setTimeout(flushPending, SidebarViewProvider.READY_TIMEOUT_MS);
    webviewView.onDidDispose(() => {
      clearTimeout(readyTimeout);
      readyListener.dispose();
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
  private _getHtml(): string {
    const nonce = getNonce();
    const htmlPath = path.join(this._extensionUri.fsPath, 'media', 'sidebar.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    return html.replace(/\{\{NONCE\}\}/g, nonce);
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

