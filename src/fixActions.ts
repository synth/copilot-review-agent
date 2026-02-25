import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewFinding } from './types';
import { ReviewEngine } from './reviewer';

/**
 * Fix action handlers: Fix Inline, Fix in Chat, Fix in Copilot Edits
 */
export class FixActions {
  constructor(
    private reviewEngine: ReviewEngine
  ) {}

  /**
   * Fix Inline: Open inline chat with the finding context so Copilot generates
   * the fix directly in the editor, providing keep/undo controls.
   */
  async fixInline(finding: ReviewFinding, workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
    const filePath = path.join(workspaceFolder.uri.fsPath, finding.file);
    const uri = vscode.Uri.file(filePath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      vscode.window.showErrorMessage(`File not found: ${finding.file}`);
      return false;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    // Select the relevant lines (clamp to valid document range)
    const lines = doc.lineCount;
    const startLine = Math.max(0, Math.min(lines - 1, finding.startLine - 1));
    const endLine = Math.max(startLine, Math.min(lines - 1, finding.endLine - 1));
    editor.selection = new vscode.Selection(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, doc.lineAt(endLine).text.length)
    );

    // Build the prompt for inline chat
    const message = [
      `Fix: ${finding.title}`,
      finding.description,
      finding.suggestedFix ? `Suggested approach: ${finding.suggestedFix}` : '',
    ].filter(Boolean).join('\n');

    try {
      await vscode.commands.executeCommand('inlineChat.start', { message, autoSend: true });
      return true;
    } catch {
      vscode.window.showWarningMessage(
        'Self Review: Could not open inline chat. Is GitHub Copilot installed?'
      );
      return false;
    }
  }

  /**
   * Fix in Chat: Open Copilot Chat with the finding context pre-filled.
   */
  async fixInChat(finding: ReviewFinding, workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const query = [
      `Fix this code review finding in #file:${finding.file} at line ${finding.startLine}:`,
      ``,
      `**${finding.severity.toUpperCase()}**: ${finding.title}`,
      ``,
      finding.description,
      finding.suggestedFix ? `\nSuggested approach: ${finding.suggestedFix}` : '',
    ].filter(Boolean).join('\n');

    try {
      // Open in agent mode so the chat can actually edit files (not just explain)
      await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent' });
    } catch {
      // Fallback: try inline chat
      const filePath = path.join(workspaceFolder.uri.fsPath, finding.file);
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);

      const startLine = Math.max(0, Math.min(doc.lineCount - 1, finding.startLine - 1));
      const endLine = Math.max(startLine, Math.min(doc.lineCount - 1, finding.endLine - 1));
      editor.selection = new vscode.Selection(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, doc.lineAt(endLine).text.length)
      );

      try {
        await vscode.commands.executeCommand('inlineChat.start');
      } catch {
        vscode.window.showWarningMessage(
          'Self Review: Could not open Copilot Chat. Is GitHub Copilot installed?'
        );
      }
    }
  }

  /**
   * Fix in Copilot Edits: Open an edit session with the finding context.
   */
  async fixInEdits(finding: ReviewFinding, workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    const query = [
      `Fix this issue in #file:${finding.file}`,
      ``,
      `**${finding.severity.toUpperCase()}**: ${finding.title}`,
      ``,
      finding.description,
      finding.suggestedFix ? `\nSuggested approach: ${finding.suggestedFix}` : '',
    ].filter(Boolean).join('\n');

    try {
      // Open in edit mode so Copilot Edits can apply changes directly
      await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'edit' });
    } catch {
      // Fallback: try opening the file and triggering inline chat
      vscode.window.showWarningMessage(
        'Self Review: Could not open Copilot Edits. Falling back to Chat.'
      );
      await this.fixInChat(finding, workspaceFolder);
    }
  }
}
