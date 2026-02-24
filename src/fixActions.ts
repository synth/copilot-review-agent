import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ReviewFinding } from './types';
import { ReviewEngine } from './reviewer';

/**
 * Fix action handlers: Fix Inline, Fix in Chat, Fix in Copilot Edits
 */
export class FixActions {
  constructor(
    private reviewEngine: ReviewEngine,
    private workspaceFolder: vscode.WorkspaceFolder
  ) {}

  /**
   * Fix Inline: Use AI to generate a fix, show a diff preview, then apply.
   */
  async fixInline(finding: ReviewFinding): Promise<boolean> {
    const filePath = path.join(this.workspaceFolder.uri.fsPath, finding.file);
    if (!fs.existsSync(filePath)) {
      vscode.window.showErrorMessage(`File not found: ${finding.file}`);
      return false;
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Self Review: Generating fix for "${finding.title}"...`,
        cancellable: true,
      },
      async (progress, token) => {
        const fixText = await this.reviewEngine.generateFix(finding, fileContent, token);
        if (!fixText || token.isCancellationRequested) {
          return false;
        }

        // Build the workspace edit
        const fileUri = vscode.Uri.file(filePath);
        const startLine = Math.max(0, finding.startLine - 1);
        const endLine = Math.min(lines.length - 1, finding.endLine - 1);

        const range = new vscode.Range(
          new vscode.Position(startLine, 0),
          new vscode.Position(endLine, lines[endLine]?.length || 0)
        );

        const edit = new vscode.WorkspaceEdit();
        edit.replace(fileUri, range, fixText);

        // Apply the edit
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
          // Open the file and show the changed region
          const doc = await vscode.workspace.openTextDocument(fileUri);
          const editor = await vscode.window.showTextDocument(doc);
          editor.revealRange(
            new vscode.Range(
              new vscode.Position(startLine, 0),
              new vscode.Position(startLine + fixText.split('\n').length, 0)
            ),
            vscode.TextEditorRevealType.InCenter
          );

          vscode.window.showInformationMessage(
            `Self Review: Fix applied for "${finding.title}". Use Ctrl+Z to undo.`
          );
          return true;
        } else {
          vscode.window.showErrorMessage('Self Review: Failed to apply fix.');
          return false;
        }
      }
    );
  }

  /**
   * Fix in Chat: Open Copilot Chat with the finding context pre-filled.
   */
  async fixInChat(finding: ReviewFinding): Promise<void> {
    const query = [
      `@workspace Fix this code review finding in ${finding.file}:${finding.startLine}:`,
      ``,
      `**${finding.severity.toUpperCase()}**: ${finding.title}`,
      ``,
      finding.description,
      finding.suggestedFix ? `\nSuggested approach: ${finding.suggestedFix}` : '',
    ].filter(Boolean).join('\n');

    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query });
    } catch {
      // Fallback: try inline chat
      const filePath = path.join(this.workspaceFolder.uri.fsPath, finding.file);
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);

      const startLine = Math.max(0, finding.startLine - 1);
      const endLine = Math.max(startLine, finding.endLine - 1);
      editor.selection = new vscode.Selection(
        new vscode.Position(startLine, 0),
        new vscode.Position(endLine, Number.MAX_SAFE_INTEGER)
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
  async fixInEdits(finding: ReviewFinding): Promise<void> {
    const query = [
      `/edit Fix this issue in #file:${finding.file}`,
      ``,
      `**${finding.severity.toUpperCase()}**: ${finding.title}`,
      ``,
      finding.description,
      finding.suggestedFix ? `\nSuggested approach: ${finding.suggestedFix}` : '',
    ].filter(Boolean).join('\n');

    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query });
    } catch {
      // Fallback: try opening the file and triggering inline chat
      vscode.window.showWarningMessage(
        'Self Review: Could not open Copilot Edits. Falling back to Chat.'
      );
      await this.fixInChat(finding);
    }
  }
}
