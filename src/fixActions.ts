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
   * Opens the file for a finding and selects the relevant lines in the editor.
   * Returns the active TextEditor on success, or null if the file was not found.
   */
  private async openAndSelectFindingLines(
    finding: ReviewFinding,
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<vscode.TextEditor | null> {
    const filePath = path.join(workspaceFolder.uri.fsPath, finding.file);
    const uri = vscode.Uri.file(filePath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      vscode.window.showErrorMessage(`File not found: ${finding.file}`);
      return null;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    // Select the relevant lines (clamp to valid document range)
    const startLine = Math.max(0, Math.min(doc.lineCount - 1, finding.startLine - 1));
    const endLine = Math.max(startLine, Math.min(doc.lineCount - 1, finding.endLine - 1));
    editor.selection = new vscode.Selection(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, doc.lineAt(endLine).text.length)
    );
    return editor;
  }

  /**
   * Fix Inline: Open inline chat with the finding context so Copilot generates
   * the fix directly in the editor, providing keep/undo controls.
   * Returns true if the inline chat was successfully initiated (not that the fix was applied).
   */
  async fixInline(finding: ReviewFinding, workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
    const editor = await this.openAndSelectFindingLines(finding, workspaceFolder);
    if (!editor) {
      return false;
    }

    // Build the prompt for inline chat
    const message = [
      `Fix: ${finding.title}`,
      finding.description,
      ...(finding.suggestedFix ? [`Suggested approach: ${finding.suggestedFix}`] : []),
    ].join('\n');

    try {
      await vscode.commands.executeCommand('inlineChat.start', { message, autoSend: true });
      return true;
    } catch {
      vscode.window.showWarningMessage(
        'Copilot Review Agent: Could not open inline chat. Is GitHub Copilot installed?'
      );
      return false;
    }
  }

  /**
   * Fix in Chat: Open Copilot Chat with the finding context pre-filled.
   * Returns true if the chat was successfully opened (not that the fix was applied).
   */
  async fixInChat(finding: ReviewFinding, workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
    const query = [
      `Fix this code review finding in #file:"${finding.file}" at line ${finding.startLine}:`,
      ``,
      `**${finding.severity.toUpperCase()}**: ${finding.title}`,
      ``,
      finding.description,
      ...(finding.suggestedFix ? [`\nSuggested approach: ${finding.suggestedFix}`] : []),
    ].join('\n');

    try {
      // Open in agent mode so the chat can actually edit files (not just explain)
      await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent' });
      return true;
    } catch {
      // Fallback: try inline chat
      const editor = await this.openAndSelectFindingLines(finding, workspaceFolder);
      if (!editor) {
        return false;
      }

      try {
        await vscode.commands.executeCommand('inlineChat.start');
        return true;
      } catch {
        vscode.window.showWarningMessage(
          'Copilot Review Agent: Could not open Copilot Chat. Is GitHub Copilot installed?'
        );
        return false;
      }
    }
  }

  /**
   * Fix in Copilot Edits: Open an edit session with the finding context.
   * Returns true if the edit session was successfully opened (not that the fix was applied).
   */
  async fixInEdits(finding: ReviewFinding, workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
    const query = [
      `Fix this issue in #file:"${finding.file}"`,
      ``,
      `**${finding.severity.toUpperCase()}**: ${finding.title}`,
      ``,
      finding.description,
      ...(finding.suggestedFix ? [`\nSuggested approach: ${finding.suggestedFix}`] : []),
    ].join('\n');

    try {
      // Open in edit mode so Copilot Edits can apply changes directly
      await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'edit' });
      return true;
    } catch {
      // Fallback: try opening the file and triggering inline chat
      vscode.window.showWarningMessage(
        'Copilot Review Agent: Could not open Copilot Edits. Falling back to Chat.'
      );
      return await this.fixInChat(finding, workspaceFolder);
    }
  }

  /**
   * Fix All in File: Open a single Copilot Edits session with all open findings
   * for the given file combined into one prompt.
   * Returns true if the edit session was successfully opened (not that the fix was applied).
   */
  async fixAllInFile(findings: ReviewFinding[], filePath: string, workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
    if (findings.length === 0) {
      vscode.window.showInformationMessage('No open findings remain for this file.');
      return false;
    }

    const findingsList = findings
      .map((f, i) =>
        [
          `${i + 1}. **${f.severity.toUpperCase()}** (line ${f.startLine}): ${f.title}`,
          `   ${f.description}`,
          ...(f.suggestedFix ? [`   Suggested approach: ${f.suggestedFix}`] : []),
        ].join('\n')
      )
      .join('\n\n');

    const query = [
      `Fix all of the following code review findings in #file:"${filePath}":`,
      ``,
      findingsList,
    ].join('\n');

    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent' });
      return true;
    } catch {
      vscode.window.showWarningMessage(
        'Copilot Review Agent: Could not open Copilot Chat. Is GitHub Copilot installed?'
      );
      return false;
    }
  }
}
