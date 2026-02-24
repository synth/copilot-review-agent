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

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'selfReview.controlPanel';
  private _view?: vscode.WebviewView;

  private readonly _onDidResolveView = new vscode.EventEmitter<vscode.WebviewView>();
  /** Fires when the webview view is resolved and ready for messages. */
  public readonly onDidResolveView = this._onDidResolveView.event;

  constructor(private readonly _extensionUri: vscode.Uri) {}

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
    this._onDidResolveView.fire(webviewView);
  }

  get view(): vscode.WebviewView | undefined { return this._view; }

  postMessage(message: WebviewMessage): void {
    this._view?.webview.postMessage(message);
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
  /** Legacy compat for history replays */
  addAgentStep(step: AgentStep): void {
    const id = 'legacy-' + step.label.replace(/[^a-zA-Z0-9]/g, '_');
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
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
/* ═══════════════════════════════════════════════
   Reset & base
   ═══════════════════════════════════════════════ */
:root { --vscode-font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif); }
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  padding: 12px;
  overflow-x: hidden;
}
h3 {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
  margin-bottom: 8px;
}
.section { margin-bottom: 14px; }
label {
  display: block; font-size: 11px;
  color: var(--vscode-descriptionForeground); margin-bottom: 3px;
}
select {
  width: 100%; padding: 4px 6px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px; font-size: 12px; font-family: var(--vscode-font);
  outline: none; margin-bottom: 8px;
}
select:focus { border-color: var(--vscode-focusBorder); }
button {
  width: 100%; padding: 6px 14px; font-size: 13px;
  font-family: var(--vscode-font); cursor: pointer;
  border: none; border-radius: 2px;
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.primary:disabled { opacity: 0.5; cursor: default; }
button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn-row { display: flex; gap: 6px; margin-top: 4px; }
.btn-row button { width: auto; flex: 1; }
.run-row { display: flex; gap: 6px; align-items: stretch; }
.run-row .primary { flex: 1; }
.stop-btn {
  width: 32px !important; min-width: 32px; padding: 0; flex-shrink: 0;
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  color: var(--vscode-errorForeground, #f44747);
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  border-radius: 2px; cursor: pointer; font-size: 14px;
  display: flex; align-items: center; justify-content: center;
}
.stop-btn:hover { opacity: 0.9; }
.link-btn {
  background: none; border: none; width: auto; padding: 0;
  color: var(--vscode-textLink-foreground); cursor: pointer;
  font-size: 11px; display: inline; text-decoration: underline;
}
.link-btn:hover { color: var(--vscode-textLink-activeForeground); }

/* ═══════════════════════════════════════════════
   Branch / model display
   ═══════════════════════════════════════════════ */
.branch-display {
  display: flex; align-items: center; gap: 6px; padding: 4px 6px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px; font-size: 12px; margin-bottom: 8px; min-height: 26px;
}
.branch-tag {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  border-radius: 10px; font-size: 11px; font-weight: 500;
}
.arrow { color: var(--vscode-descriptionForeground); font-size: 14px; margin: 0 2px; }

/* ═══════════════════════════════════════════════
   Screens
   ═══════════════════════════════════════════════ */
.screen { display: none; }
.screen.active { display: block; }

/* ═══════════════════════════════════════════════
   History list
   ═══════════════════════════════════════════════ */
.history-item {
  padding: 8px 10px; border-radius: 3px; cursor: pointer;
  margin-bottom: 4px; border: 1px solid transparent; transition: background 0.1s;
}
.history-item:hover { background: var(--vscode-list-hoverBackground); }
.history-item .hi-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 3px;
}
.history-item .hi-branches {
  font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 4px;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.history-item .hi-date {
  font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; margin-left: 8px;
}
.history-item .hi-stats {
  font-size: 11px; color: var(--vscode-descriptionForeground); display: flex; align-items: center;
}
.hi-badge {
  display: inline-block; padding: 0 5px; border-radius: 8px;
  font-size: 10px; font-weight: 600; margin-right: 4px;
}
.hi-badge.open {
  background: var(--vscode-editorWarning-foreground, #cca700);
  color: var(--vscode-editor-background, #1e1e1e);
}
.hi-badge.clear {
  background: var(--vscode-testing-iconPassed, #388a34);
  color: var(--vscode-editor-background, #1e1e1e);
}
.history-item .hi-delete {
  display: none; background: none; border: none;
  color: var(--vscode-descriptionForeground); cursor: pointer;
  padding: 2px 4px; font-size: 14px; width: auto; line-height: 1; margin-left: auto;
}
.history-item:hover .hi-delete { display: inline-block; }
.history-item .hi-delete:hover { color: var(--vscode-errorForeground); }
.empty-state {
  text-align: center; color: var(--vscode-descriptionForeground);
  padding: 24px 12px; font-size: 12px; line-height: 1.6;
}
.empty-state .es-icon { font-size: 28px; margin-bottom: 8px; display: block; }

.back-btn {
  background: none; border: none; color: var(--vscode-textLink-foreground);
  cursor: pointer; padding: 0 0 8px 0; font-size: 12px;
  display: flex; align-items: center; gap: 4px; width: auto;
}
.back-btn:hover { text-decoration: underline; }

/* ═══════════════════════════════════════════════
   Detail header
   ═══════════════════════════════════════════════ */
.detail-header {
  padding: 6px 0 10px 0;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #333);
  margin-bottom: 12px;
}
.detail-header .dh-branches { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.detail-header .dh-date { font-size: 11px; color: var(--vscode-descriptionForeground); }

/* ═══════════════════════════════════════════════
   Instructions indicator
   ═══════════════════════════════════════════════ */
.instructions-row {
  display: flex; align-items: center; gap: 6px; font-size: 11px;
  color: var(--vscode-descriptionForeground); margin-bottom: 8px;
  padding: 4px 0;
}
.instructions-row .dot {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
}
.instructions-row .dot.active { background: var(--vscode-testing-iconPassed, #388a34); }
.instructions-row .dot.inactive { background: var(--vscode-descriptionForeground); opacity: 0.4; }

/* ═══════════════════════════════════════════════
   Agent loop — Copilot-style
   ═══════════════════════════════════════════════ */
#agent-loop { display: none; }
#agent-loop.visible { display: block; margin-top: 12px; }

.task-group { margin-bottom: 2px; border-radius: 4px; overflow: hidden; }
.task-header {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  font-size: 12px; font-weight: 500; cursor: pointer; user-select: none;
  border-radius: 4px; background: transparent; transition: background 0.1s;
}
.task-header:hover { background: var(--vscode-list-hoverBackground); }
.task-header .task-chevron {
  flex-shrink: 0; width: 16px; text-align: center; font-size: 10px;
  color: var(--vscode-descriptionForeground); transition: transform 0.15s ease;
}
.task-group.collapsed .task-chevron { transform: rotate(-90deg); }
.task-header .task-icon { flex-shrink: 0; width: 16px; text-align: center; font-size: 13px; }
.task-header .task-label { flex: 1; min-width: 0; }
.task-header .task-detail {
  font-size: 11px; font-weight: 400; color: var(--vscode-descriptionForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;
}
.task-body { overflow: hidden; transition: max-height 0.2s ease; max-height: 2000px; }
.task-group.collapsed .task-body { max-height: 0; }
.sub-steps { padding: 2px 0 6px 32px; }
.sub-step {
  display: flex; align-items: flex-start; gap: 6px; padding: 2px 0;
  font-size: 11px; line-height: 1.5; color: var(--vscode-descriptionForeground);
}
.sub-step .ss-icon { flex-shrink: 0; width: 14px; text-align: center; font-size: 11px; }
.sub-step .ss-label { flex: 1; min-width: 0; word-break: break-word; }
.sub-step .ss-detail {
  display: block; font-size: 10px; color: var(--vscode-descriptionForeground);
  opacity: 0.8; margin-top: 1px;
}
.ss-stream {
  display: block;
  font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
  font-size: 11px; line-height: 1.4; color: var(--vscode-descriptionForeground);
  opacity: 0.7; white-space: pre-wrap; word-break: break-word;
  max-height: 60px; overflow: hidden; margin-top: 2px;
}
.task-group.status-running .task-header { color: var(--vscode-foreground); }
.task-group.status-done .task-header { color: var(--vscode-descriptionForeground); }
.task-group.status-error .task-header { color: var(--vscode-errorForeground); }

@keyframes spin { to { transform: rotate(360deg); } }
.spinner {
  display: inline-block; width: 12px; height: 12px;
  border: 1.5px solid var(--vscode-descriptionForeground);
  border-top-color: var(--vscode-progressBar-background, #0078d4);
  border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle;
}
.spinner-sm {
  display: inline-block; width: 10px; height: 10px;
  border: 1.5px solid var(--vscode-descriptionForeground);
  border-top-color: var(--vscode-progressBar-background, #0078d4);
  border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle;
}
.progress-bar-track {
  width: 100%; height: 2px;
  background: var(--vscode-editorWidget-border, #333);
  border-radius: 1px; margin-bottom: 10px; overflow: hidden;
}
.progress-bar-fill {
  height: 100%; background: var(--vscode-progressBar-background, #0078d4);
  border-radius: 1px; transition: width 0.3s ease; width: 0%;
}

/* ═══════════════════════════════════════════════
   Summary
   ═══════════════════════════════════════════════ */
#summary {
  display: none; padding: 10px 12px; border-radius: 4px;
  font-size: 12px; line-height: 1.5;
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.05));
  border: 1px solid var(--vscode-editorWidget-border, #333);
  margin-top: 8px;
}
#summary.visible { display: block; }
#summary .sum-headline { font-weight: 600; margin-bottom: 4px; display: block; }
#summary .count { font-weight: 600; }

/* ═══════════════════════════════════════════════
   Separator
   ═══════════════════════════════════════════════ */
.separator {
  height: 1px; background: var(--vscode-editorWidget-border, #333);
  margin: 12px 0;
}
</style>
</head>
<body>

<!-- ========== SCREEN: History ========== -->
<div id="screen-history" class="screen active">
  <div class="section" style="display:flex; align-items:center; justify-content:space-between;">
    <h3 style="margin-bottom:0">Review History</h3>
  </div>
  <div class="section">
    <button id="new-review-btn" class="primary"><span>＋</span><span>New Review</span></button>
  </div>
  <div id="history-list"></div>
</div>

<!-- ========== SCREEN: Detail ========== -->
<div id="screen-detail" class="screen">
  <button class="back-btn" id="back-btn">← History</button>

  <!-- Past review header -->
  <div id="past-review-header" class="detail-header" style="display:none">
    <div class="dh-branches">
      <span class="branch-tag" id="dh-base">—</span>
      <span class="arrow">←</span>
      <span class="branch-tag" id="dh-target">—</span>
    </div>
    <div class="dh-date" id="dh-date"></div>
  </div>

  <!-- New review controls -->
  <div id="new-review-controls">
    <div class="section">
      <h3>Branch Selection</h3>
      <label for="base-branch">Base branch</label>
      <select id="base-branch"><option value="">Loading branches…</option></select>
      <label for="target-branch">Target</label>
      <select id="target-branch"><option value="">Loading branches…</option></select>
      <div id="branch-summary" class="branch-display" style="display:none">
        <span class="branch-tag" id="base-tag">—</span>
        <span class="arrow">←</span>
        <span class="branch-tag" id="target-tag">—</span>
      </div>
    </div>

    <div class="section">
      <label for="model-select">Model</label>
      <select id="model-select"><option value="">Loading models…</option></select>
    </div>

    <div id="instructions-row" class="instructions-row" style="display:none">
      <span class="dot" id="instr-dot"></span>
      <span id="instr-text"></span>
      <button class="link-btn" id="instr-action"></button>
    </div>

    <div class="section" id="action-buttons">
      <div class="run-row">
        <button id="run-btn" class="primary" disabled>
          <span id="run-icon">▶</span>
          <span id="run-label">Run Review</span>
        </button>
        <button id="stop-btn" class="stop-btn" style="display:none" title="Stop review">■</button>
      </div>
    </div>
  </div>

  <div class="btn-row" id="post-actions" style="display:none">
    <button id="clear-btn" class="secondary">Clear</button>
    <button id="export-btn" class="secondary">Export</button>
  </div>

  <div id="agent-loop" class="section">
    <div class="progress-bar-track"><div class="progress-bar-fill" id="progress-fill"></div></div>
    <div id="tasks-container"></div>
  </div>

  <div id="summary"></div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();

  // ── DOM refs ──
  const screenHistory = document.getElementById('screen-history');
  const screenDetail  = document.getElementById('screen-detail');
  const historyList   = document.getElementById('history-list');
  const newReviewBtn  = document.getElementById('new-review-btn');
  const backBtn       = document.getElementById('back-btn');
  const pastReviewHeader  = document.getElementById('past-review-header');
  const newReviewControls = document.getElementById('new-review-controls');
  const dhBase   = document.getElementById('dh-base');
  const dhTarget = document.getElementById('dh-target');
  const dhDate   = document.getElementById('dh-date');

  const baseSelect   = document.getElementById('base-branch');
  const targetSelect = document.getElementById('target-branch');
  const branchSummary = document.getElementById('branch-summary');
  const baseTag  = document.getElementById('base-tag');
  const targetTag = document.getElementById('target-tag');

  const modelSelect = document.getElementById('model-select');

  const instrRow    = document.getElementById('instructions-row');
  const instrDot    = document.getElementById('instr-dot');
  const instrText   = document.getElementById('instr-text');
  const instrAction = document.getElementById('instr-action');

  const runBtn       = document.getElementById('run-btn');
  const runIcon      = document.getElementById('run-icon');
  const runLabel     = document.getElementById('run-label');
  const stopBtn      = document.getElementById('stop-btn');
  const postActions  = document.getElementById('post-actions');
  const clearBtn     = document.getElementById('clear-btn');
  const exportBtn    = document.getElementById('export-btn');

  const agentLoop      = document.getElementById('agent-loop');
  const tasksContainer = document.getElementById('tasks-container');
  const progressFill   = document.getElementById('progress-fill');
  const summaryEl      = document.getElementById('summary');

  let reviewState = 'idle';

  // ── Task registry ──
  const tasks = new Map();

  function showScreen(name) {
    screenHistory.classList.toggle('active', name === 'history');
    screenDetail.classList.toggle('active', name === 'detail');
  }

  // ═════════════════════════════════════════════
  //  History
  // ═════════════════════════════════════════════
  newReviewBtn.addEventListener('click', () => vscode.postMessage({ type: 'newReview' }));
  backBtn.addEventListener('click', () => vscode.postMessage({ type: 'backToHistory' }));

  function renderHistory(items) {
    historyList.innerHTML = '';
    if (!items || items.length === 0) {
      historyList.innerHTML =
        '<div class="empty-state"><span class="es-icon">📋</span>No reviews yet.<br>Click <b>New Review</b> to get started.</div>';
      return;
    }
    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'history-item';
      const target = item.targetBranch || 'HEAD + wt';
      const dateStr = formatDate(item.timestamp);
      const hasOpen = item.openCount > 0;
      el.innerHTML =
        '<div class="hi-header">' +
          '<span class="hi-branches">' +
            '<span class="branch-tag">' + esc(item.baseBranch) + '</span>' +
            ' <span class="arrow">←</span> ' +
            '<span class="branch-tag">' + esc(target) + '</span>' +
          '</span>' +
          '<span class="hi-date">' + dateStr + '</span>' +
        '</div>' +
        '<div class="hi-stats">' +
          '<span class="hi-badge ' + (hasOpen ? 'open' : 'clear') + '">' +
            (hasOpen ? item.openCount + ' open' : 'clear') + '</span>' +
          item.totalFindings + ' finding' + (item.totalFindings !== 1 ? 's' : '') +
          ' in ' + item.fileCount + ' file' + (item.fileCount !== 1 ? 's' : '') +
          '<button class="hi-delete" data-id="' + item.id + '" title="Delete review">✕</button>' +
        '</div>';
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('hi-delete')) return;
        vscode.postMessage({ type: 'openReview', payload: item.id });
      });
      const del = el.querySelector('.hi-delete');
      if (del) del.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteReview', payload: item.id });
      });
      historyList.appendChild(el);
    }
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const diffMs = Date.now() - d.getTime();
    const min = Math.floor(diffMs / 60000);
    const hr  = Math.floor(diffMs / 3600000);
    const day = Math.floor(diffMs / 86400000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    if (hr < 24) return hr + 'h ago';
    if (day < 7) return day + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function esc(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

  // ═════════════════════════════════════════════
  //  Branch / model / controls
  // ═════════════════════════════════════════════
  baseSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setBaseBranch', payload: baseSelect.value });
    updateBranchSummary();
  });
  targetSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setTargetBranch', payload: targetSelect.value });
    updateBranchSummary();
  });
  modelSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setModel', payload: modelSelect.value });
  });

  function updateBranchSummary() {
    const base = baseSelect.value;
    const target = targetSelect.value;
    if (base) {
      branchSummary.style.display = 'flex';
      baseTag.textContent = base;
      targetTag.textContent = target || 'HEAD + working tree';
      runBtn.disabled = false;
    } else {
      branchSummary.style.display = 'none';
      runBtn.disabled = true;
    }
  }

  runBtn.addEventListener('click', () => {
    if (reviewState === 'reviewing') return;
    vscode.postMessage({
      type: 'runReview',
      payload: {
        baseBranch: baseSelect.value,
        targetBranch: targetSelect.value,
        modelId: modelSelect.value || undefined,
      },
    });
  });
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stopReview' }));
  clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearReview' }));
  exportBtn.addEventListener('click', () => vscode.postMessage({ type: 'exportMarkdown' }));

  // ═════════════════════════════════════════════
  //  Agent loop — task management
  // ═════════════════════════════════════════════
  function statusIcon(status, small) {
    if (status === 'running') return small ? '<span class="spinner-sm"></span>' : '<span class="spinner"></span>';
    if (status === 'done') return '<span style="color:var(--vscode-testing-iconPassed,#388a34)">✓</span>';
    if (status === 'error') return '<span style="color:var(--vscode-errorForeground,#f44747)">✗</span>';
    return '○';
  }

  function createTaskEl(task) {
    const group = document.createElement('div');
    group.className = 'task-group status-' + task.status;
    group.id = 'task-' + task.id;
    const header = document.createElement('div');
    header.className = 'task-header';
    header.innerHTML =
      '<span class="task-chevron">▼</span>' +
      '<span class="task-icon">' + statusIcon(task.status, false) + '</span>' +
      '<span class="task-label">' + esc(task.label) + '</span>' +
      (task.detail ? '<span class="task-detail">' + esc(task.detail) + '</span>' : '');
    header.addEventListener('click', () => group.classList.toggle('collapsed'));
    const body = document.createElement('div');
    body.className = 'task-body';
    const subSteps = document.createElement('div');
    subSteps.className = 'sub-steps';
    body.appendChild(subSteps);
    group.appendChild(header);
    group.appendChild(body);
    return { el: group, header, subStepsEl: subSteps, status: task.status, subSteps: new Map() };
  }

  function handleAddTask(task) {
    if (tasks.has(task.id)) { handleUpdateTask(task); return; }
    const t = createTaskEl(task);
    tasks.set(task.id, t);
    tasksContainer.appendChild(t.el);
    scrollToBottom();
  }

  function handleUpdateTask(update) {
    const t = tasks.get(update.id);
    if (!t) return;
    if (update.status) {
      t.status = update.status;
      t.el.className = 'task-group status-' + update.status;
      t.header.querySelector('.task-icon').innerHTML = statusIcon(update.status, false);
      if ((update.status === 'done' || update.status === 'error') && update.collapsible !== false) {
        setTimeout(() => t.el.classList.add('collapsed'), 400);
      }
    }
    if (update.label) t.header.querySelector('.task-label').textContent = update.label;
    if (update.detail !== undefined) {
      let d = t.header.querySelector('.task-detail');
      if (!d) { d = document.createElement('span'); d.className = 'task-detail'; t.header.appendChild(d); }
      d.textContent = update.detail;
    }
  }

  function handleAddSubStep(step) {
    const t = tasks.get(step.taskId);
    if (!t) return;
    const el = document.createElement('div');
    el.className = 'sub-step';
    el.id = 'ss-' + step.taskId + '-' + step.id;
    el.innerHTML =
      '<span class="ss-icon">' + statusIcon(step.status, true) + '</span>' +
      '<span class="ss-label">' + esc(step.label) +
        (step.detail ? '<span class="ss-detail">' + esc(step.detail) + '</span>' : '') +
      '</span>';
    t.subStepsEl.appendChild(el);
    t.subSteps.set(step.id, el);
    scrollToBottom();
  }

  function handleUpdateSubStep(update) {
    const t = tasks.get(update.taskId);
    if (!t) return;
    const el = t.subSteps.get(update.id);
    if (!el) return;
    if (update.status) el.querySelector('.ss-icon').innerHTML = statusIcon(update.status, true);
    if (update.label) {
      const labelEl = el.querySelector('.ss-label');
      const detailSpan = labelEl.querySelector('.ss-detail');
      const streamSpan = labelEl.querySelector('.ss-stream');
      labelEl.textContent = update.label;
      if (update.detail) {
        const d = document.createElement('span'); d.className = 'ss-detail';
        d.textContent = update.detail; labelEl.appendChild(d);
      } else if (detailSpan) labelEl.appendChild(detailSpan);
      if (streamSpan) labelEl.appendChild(streamSpan);
    }
    if (update.detail !== undefined) {
      let d = el.querySelector('.ss-detail');
      if (!d) { d = document.createElement('span'); d.className = 'ss-detail'; el.querySelector('.ss-label').appendChild(d); }
      d.textContent = update.detail;
    }
  }

  function handleStreamToken(data) {
    const t = tasks.get(data.taskId);
    if (!t) return;
    const ssEl = t.subSteps.get(data.subStepId);
    if (!ssEl) return;
    let stream = ssEl.querySelector('.ss-stream');
    if (!stream) { stream = document.createElement('span'); stream.className = 'ss-stream'; ssEl.querySelector('.ss-label').appendChild(stream); }
    stream.textContent += data.token;
    if (stream.textContent.length > 200) stream.textContent = '…' + stream.textContent.slice(-180);
    scrollToBottom();
  }

  function updateProgressBar() {
    const all = Array.from(tasks.values());
    if (all.length === 0) { progressFill.style.width = '0%'; return; }
    const done = all.filter(t => t.status === 'done' || t.status === 'error').length;
    const running = all.filter(t => t.status === 'running').length;
    const pct = Math.round(((done + running * 0.3) / all.length) * 100);
    progressFill.style.width = Math.min(pct, 100) + '%';
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { tasksContainer.scrollTop = tasksContainer.scrollHeight; });
  }

  // ═════════════════════════════════════════════
  //  Message handler
  // ═════════════════════════════════════════════
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {

      case 'setHistory': renderHistory(msg.payload); break;
      case 'showHistoryList': showScreen('history'); resetDetailState(); break;

      case 'showReviewDetail': {
        showScreen('detail');
        const data = msg.payload;
        if (data.isPastReview) {
          pastReviewHeader.style.display = 'block';
          newReviewControls.style.display = 'none';
          dhBase.textContent = data.baseBranch;
          dhTarget.textContent = data.targetBranch || 'HEAD + wt';
          dhDate.textContent = new Date(data.timestamp).toLocaleString();
          tasksContainer.innerHTML = '';
          tasks.clear();
          agentLoop.classList.add('visible');
          if (data.agentSteps && data.agentSteps.length > 0) {
            for (const step of data.agentSteps) {
              const id = 'h-' + step.label.replace(/[^a-zA-Z0-9]/g, '_');
              handleAddTask({ id, label: step.label, status: step.status === 'pending' ? 'done' : step.status, detail: step.detail, collapsible: true });
              const t = tasks.get(id);
              if (t) t.el.classList.add('collapsed');
            }
          }
          progressFill.style.width = '100%';
          if (data.summary) {
            summaryEl.innerHTML =
              '<span class="sum-headline">Review Complete</span>' +
              '<span class="count">' + data.summary.totalFindings + '</span> finding' + (data.summary.totalFindings !== 1 ? 's' : '') +
              ' across <span class="count">' + data.summary.fileCount + '</span> file' + (data.summary.fileCount !== 1 ? 's' : '') +
              ' — <span class="count">' + data.summary.openCount + '</span> open';
            summaryEl.classList.add('visible');
          }
          postActions.style.display = 'flex';
          reviewState = 'done';
        } else {
          pastReviewHeader.style.display = 'none';
          newReviewControls.style.display = 'block';
          resetDetailState();
        }
        break;
      }

      case 'setBranches': {
        const { locals, remotes, currentBranch } = msg.payload;
        populateSelect(baseSelect, locals, remotes, currentBranch, '');
        populateTargetSelect(targetSelect, locals, currentBranch);
        updateBranchSummary();
        break;
      }
      case 'setSelectedBranches': {
        baseSelect.value = msg.payload.baseBranch;
        targetSelect.value = msg.payload.targetBranch;
        updateBranchSummary();
        break;
      }
      case 'setModels': {
        const { models, selectedId } = msg.payload;
        modelSelect.innerHTML = '';
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.label;
          modelSelect.appendChild(opt);
        }
        if (selectedId) modelSelect.value = selectedId;
        break;
      }

      case 'setInstructionsStatus': {
        const { exists, path } = msg.payload;
        instrRow.style.display = 'flex';
        if (exists) {
          instrDot.className = 'dot active';
          instrText.textContent = '.self-review-instructions.md';
          instrAction.textContent = 'Open';
          instrAction.onclick = () => vscode.postMessage({ type: 'openInstructions' });
        } else {
          instrDot.className = 'dot inactive';
          instrText.textContent = 'No custom instructions';
          instrAction.textContent = 'Create';
          instrAction.onclick = () => vscode.postMessage({ type: 'createInstructions' });
        }
        break;
      }

      case 'setReviewState': {
        reviewState = msg.payload.state;
        if (reviewState === 'reviewing') {
          runBtn.disabled = true;
          runIcon.textContent = '⏳';
          runLabel.textContent = 'Reviewing…';
          baseSelect.disabled = true;
          targetSelect.disabled = true;
          modelSelect.disabled = true;
          stopBtn.style.display = 'flex';
          tasksContainer.innerHTML = '';
          tasks.clear();
          agentLoop.classList.add('visible');
          summaryEl.classList.remove('visible');
          postActions.style.display = 'none';
          progressFill.style.width = '0%';
        } else if (reviewState === 'done') {
          runBtn.disabled = false;
          runIcon.textContent = '🔄';
          runLabel.textContent = 'Re-run Review';
          baseSelect.disabled = false;
          targetSelect.disabled = false;
          modelSelect.disabled = false;
          stopBtn.style.display = 'none';
          postActions.style.display = 'flex';
          progressFill.style.width = '100%';
        } else if (reviewState === 'error') {
          runBtn.disabled = false;
          runIcon.textContent = '▶';
          runLabel.textContent = 'Run Review';
          baseSelect.disabled = false;
          targetSelect.disabled = false;
          modelSelect.disabled = false;
          stopBtn.style.display = 'none';
        } else {
          runBtn.disabled = false;
          runIcon.textContent = '▶';
          runLabel.textContent = 'Run Review';
          baseSelect.disabled = false;
          targetSelect.disabled = false;
          modelSelect.disabled = false;
          stopBtn.style.display = 'none';
          agentLoop.classList.remove('visible');
          summaryEl.classList.remove('visible');
          postActions.style.display = 'none';
          progressFill.style.width = '0%';
        }
        break;
      }

      case 'addTask': handleAddTask(msg.payload); updateProgressBar(); break;
      case 'updateTask': handleUpdateTask(msg.payload); updateProgressBar(); break;
      case 'addSubStep': handleAddSubStep(msg.payload); break;
      case 'updateSubStep': handleUpdateSubStep(msg.payload); break;
      case 'streamToken': handleStreamToken(msg.payload); break;

      case 'addAgentStep': {
        const s = msg.payload;
        const id = 'legacy-' + s.label.replace(/[^a-zA-Z0-9]/g, '_');
        handleAddTask({ id, label: s.label, status: s.status === 'pending' ? 'running' : s.status, detail: s.detail });
        updateProgressBar();
        break;
      }

      case 'setReviewSummary': {
        const { openCount, fileCount, totalFindings } = msg.payload;
        summaryEl.innerHTML =
          '<span class="sum-headline">Review Complete</span>' +
          '<span class="count">' + totalFindings + '</span> finding' + (totalFindings !== 1 ? 's' : '') +
          ' across <span class="count">' + fileCount + '</span> file' + (fileCount !== 1 ? 's' : '') +
          ' — <span class="count">' + openCount + '</span> open';
        summaryEl.classList.add('visible');
        break;
      }

      case 'resetReview': resetDetailState(); break;
    }
  });

  function resetDetailState() {
    reviewState = 'idle';
    agentLoop.classList.remove('visible');
    summaryEl.classList.remove('visible');
    tasksContainer.innerHTML = '';
    tasks.clear();
    postActions.style.display = 'none';
    reviewActions.style.display = 'none';
    runBtn.disabled = false;
    runIcon.textContent = '▶';
    runLabel.textContent = 'Run Review';
    baseSelect.disabled = false;
    targetSelect.disabled = false;
    modelSelect.disabled = false;
    progressFill.style.width = '0%';
  }

  // ═════════════════════════════════════════════
  //  Helpers
  // ═════════════════════════════════════════════
  function populateSelect(select, locals, remotes, currentBranch, selectedValue) {
    select.innerHTML = '';
    const localGroup = document.createElement('optgroup');
    localGroup.label = 'Local Branches';
    for (const b of locals) {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b + (b === currentBranch ? ' (current)' : '');
      localGroup.appendChild(opt);
    }
    select.appendChild(localGroup);
    const uniqueRemotes = remotes.filter(r => !locals.includes(r) && r !== 'HEAD');
    if (uniqueRemotes.length > 0) {
      const remoteGroup = document.createElement('optgroup');
      remoteGroup.label = 'Remote Branches';
      for (const b of uniqueRemotes) {
        const opt = document.createElement('option');
        opt.value = 'origin/' + b;
        opt.textContent = 'origin/' + b;
        remoteGroup.appendChild(opt);
      }
      select.appendChild(remoteGroup);
    }
    if (selectedValue) select.value = selectedValue;
  }

  function populateTargetSelect(select, locals, currentBranch) {
    select.innerHTML = '';
    const wt = document.createElement('option');
    wt.value = '';
    wt.textContent = currentBranch + ' + working tree';
    select.appendChild(wt);
    const co = document.createElement('option');
    co.value = currentBranch;
    co.textContent = currentBranch + ' (committed only)';
    select.appendChild(co);
    const grp = document.createElement('optgroup');
    grp.label = 'Other Branches';
    for (const b of locals) {
      if (b === currentBranch) continue;
      const opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      grp.appendChild(opt);
    }
    if (grp.children.length > 0) select.appendChild(grp);
  }

  // Boot
  vscode.postMessage({ type: 'loadHistory' });
})();
</script>
</body>
</html>`;
  }
}
