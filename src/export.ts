import * as vscode from 'vscode';
import { ReviewFinding, SEVERITY_EMOJI } from './types';

/**
 * Export review findings as a Markdown document.
 */
export async function exportFindings(findings: ReviewFinding[], baseBranch: string, targetBranch: string): Promise<void> {
  if (findings.length === 0) {
    vscode.window.showInformationMessage('Self Review: No findings to export.');
    return;
  }

  const md = buildMarkdown(findings, baseBranch, targetBranch);

  // Open as untitled document
  const doc = await vscode.workspace.openTextDocument({
    content: md,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc);
}

function buildMarkdown(findings: ReviewFinding[], baseBranch: string, targetBranch: string): string {
  const lines: string[] = [];

  const target = targetBranch || 'HEAD + working tree';
  lines.push(`# Self Review — ${baseBranch}..${target}`);
  lines.push('');
  lines.push(`> Generated ${new Date().toISOString()}`);
  lines.push('');

  // Summary
  const open = findings.filter(f => f.status === 'open').length;
  const skipped = findings.filter(f => f.status === 'skipped').length;
  const fixed = findings.filter(f => f.status === 'fixed').length;

  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Open | ${open} |`);
  lines.push(`| Skipped | ${skipped} |`);
  lines.push(`| Fixed | ${fixed} |`);
  lines.push(`| **Total** | **${findings.length}** |`);
  lines.push('');

  // Group by file
  const byFile = new Map<string, ReviewFinding[]>();
  for (const f of findings) {
    const arr = byFile.get(f.file) || [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  for (const [file, fileFindings] of byFile) {
    lines.push(`## ${file}`);
    lines.push('');

    for (const f of fileFindings) {
      const statusIcon = f.status === 'open' ? '⬜' : f.status === 'fixed' ? '✅' : '⏭️';
      const emoji = SEVERITY_EMOJI[f.severity] ?? '⚪';

      lines.push(`### ${statusIcon} ${emoji} ${f.title}`);
      lines.push('');
      lines.push(`**Severity:** ${f.severity.toUpperCase()} | **Category:** ${f.category} | **Lines:** ${f.startLine}-${f.endLine} | **Status:** ${f.status}`);
      lines.push('');
      // Wrap in a blockquote so AI-generated text with leading #/--- etc. can't corrupt document structure
      for (const line of f.description.split('\n')) {
        lines.push(`> ${line}`);
      }
      lines.push('');

      if (f.suggestedFix) {
        lines.push(`<details><summary>Suggested Fix</summary>`);
        lines.push('');
        lines.push('```');
        lines.push(f.suggestedFix);
        lines.push('```');
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}
