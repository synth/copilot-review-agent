import * as vscode from 'vscode';
import { ReviewFinding } from './types';

/**
 * Manages inline review comments in the editor using the VS Code Comment Controller API.
 */
export class CommentManager {
  private controller: vscode.CommentController;
  private threads: Map<string, vscode.CommentThread> = new Map();

  constructor() {
    this.controller = vscode.comments.createCommentController('self-review', 'Self Review');
    this.controller.options = {
      prompt: 'Self Review finding',
      placeHolder: 'AI-generated review comment',
    };
    // No commentingRangeProvider — we don't want users to manually add comments
  }

  /**
   * Create a comment thread for a review finding.
   */
  addFinding(finding: ReviewFinding, workspaceFolder: vscode.WorkspaceFolder): vscode.CommentThread {
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, finding.file);
    const startLine = Math.max(0, finding.startLine - 1); // 0-based
    const endLine = Math.max(startLine, finding.endLine - 1);

    const END_OF_LINE = 99999;
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, END_OF_LINE)
    );

    const body = this.buildCommentBody(finding);
    const comment: vscode.Comment = {
      body,
      mode: vscode.CommentMode.Preview,
      author: {
        name: `Self Review [${finding.severity.toUpperCase()}]`,
      },
      label: finding.category,
    };

    const thread = this.controller.createCommentThread(uri, range, [comment]);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = false;
    thread.label = finding.title;
    thread.contextValue = finding.id; // Used to look up the finding from comment actions

    this.threads.set(finding.id, thread);
    return thread;
  }

  /**
   * Build a rich Markdown body for a comment.
   */
  private buildCommentBody(finding: ReviewFinding): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: [] };
    md.supportHtml = false;

    // Severity badge
    const severityEmoji: Record<string, string> = {
      blocker: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🔵',
      nit: '⚪',
    };
    const emoji = severityEmoji[finding.severity] || '⚪';

    md.appendMarkdown(`${emoji} **${finding.severity.toUpperCase()}** — ${finding.category}\n\n`);
    md.appendMarkdown(`### ${finding.title}\n\n`);
    md.appendMarkdown(`${finding.description}\n\n`);

    if (finding.suggestedFix) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`💡 **Suggested Fix**\n\n`);
      md.appendMarkdown(`\`\`\`\n${finding.suggestedFix}\n\`\`\`\n\n`);
    }

    return md;
  }

  /**
   * Mark a finding as resolved (skipped) — collapses the thread.
   */
  resolveFinding(findingId: string): void {
    const thread = this.threads.get(findingId);
    if (thread) {
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      thread.state = vscode.CommentThreadState.Resolved;
    }
  }

  /**
   * Remove all comment threads and clear the map.
   */
  clearAll(): void {
    for (const thread of this.threads.values()) {
      thread.dispose();
    }
    this.threads.clear();
  }

  /**
   * Get the thread for a finding ID.
   */
  getThread(findingId: string): vscode.CommentThread | undefined {
    return this.threads.get(findingId);
  }

  /**
   * Find the finding ID from a comment thread (using contextValue).
   */
  findingIdFromThread(thread: vscode.CommentThread): string | undefined {
    return thread.contextValue || undefined;
  }

  /**
   * Dispose the controller and all threads.
   */
  dispose(): void {
    this.clearAll();
    this.controller.dispose();
  }
}
