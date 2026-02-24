import * as vscode from 'vscode';
import { ReviewFinding, severityIcon, severityRank, Severity } from './types';

/**
 * TreeView sidebar for the Self Review task list.
 * Two-level hierarchy: File (collapsible) > Finding (leaf)
 * With a summary item at the root.
 */
export type SortMode = 'alphabetical' | 'findingsCount';

export class TaskListProvider implements vscode.TreeDataProvider<TaskListItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TaskListItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private findings: ReviewFinding[] = [];
  private groupBy: 'file' | 'severity' = 'file';
  private sortMode: SortMode = 'alphabetical';

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setFindings(findings: ReviewFinding[]): void {
    this.findings = findings;
    this.refresh();
  }

  getFindings(): ReviewFinding[] {
    return this.findings;
  }

  addFindings(newFindings: ReviewFinding[]): void {
    this.findings.push(...newFindings);
    this.refresh();
  }

  updateFinding(id: string, update: Partial<ReviewFinding>): void {
    const finding = this.findings.find(f => f.id === id);
    if (finding) {
      Object.assign(finding, update);
      this.refresh();
    }
  }

  getFinding(id: string): ReviewFinding | undefined {
    return this.findings.find(f => f.id === id);
  }

  clearAll(): void {
    this.findings = [];
    this.refresh();
  }

  toggleGroupBy(): void {
    this.groupBy = this.groupBy === 'file' ? 'severity' : 'file';
    this.refresh();
  }

  getSortMode(): SortMode {
    return this.sortMode;
  }

  setSortMode(mode: SortMode): void {
    this.sortMode = mode;
    this.refresh();
  }

  cycleSortMode(): void {
    this.sortMode = this.sortMode === 'alphabetical' ? 'findingsCount' : 'alphabetical';
    this.refresh();
  }

  getTreeItem(element: TaskListItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TaskListItem): vscode.ProviderResult<TaskListItem[]> {
    if (!element) {
      return this.getRootItems();
    }

    if (element.contextValue === 'fileGroup' || element.contextValue === 'severityGroup') {
      return element.children || [];
    }

    return [];
  }

  getParent(element: TaskListItem): vscode.ProviderResult<TaskListItem> {
    return element.parent;
  }

  private getRootItems(): TaskListItem[] {
    if (this.findings.length === 0) {
      return [];
    }

    const open = this.findings.filter(f => f.status === 'open').length;
    const skipped = this.findings.filter(f => f.status === 'skipped').length;
    const fixed = this.findings.filter(f => f.status === 'fixed').length;

    // Summary item
    const summary = new TaskListItem(
      `${this.findings.length} findings — ${open} open, ${skipped} skipped, ${fixed} fixed`,
      vscode.TreeItemCollapsibleState.None,
    );
    summary.contextValue = 'summary';
    summary.iconPath = new vscode.ThemeIcon('checklist');

    const groups: TaskListItem[] = [summary];

    if (this.groupBy === 'file') {
      groups.push(...this.groupByFile());
    } else {
      groups.push(...this.groupBySeverity());
    }

    return groups;
  }

  private groupByFile(): TaskListItem[] {
    const fileMap = new Map<string, ReviewFinding[]>();
    for (const f of this.findings) {
      const arr = fileMap.get(f.file) || [];
      arr.push(f);
      fileMap.set(f.file, arr);
    }

    const entries = Array.from(fileMap.entries());

    if (this.sortMode === 'findingsCount') {
      entries.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    } else {
      entries.sort((a, b) => a[0].localeCompare(b[0]));
    }

    const groups: TaskListItem[] = [];
    for (const [file, findings] of entries) {
      const openCount = findings.filter(f => f.status === 'open').length;
      const group = new TaskListItem(
        file,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      group.contextValue = 'fileGroup';
      group.description = `${openCount}/${findings.length} open`;
      group.iconPath = new vscode.ThemeIcon('file');
      group.children = findings.map(f => this.findingToTreeItem(f, group));
      groups.push(group);
    }

    return groups;
  }

  private groupBySeverity(): TaskListItem[] {
    const severityOrder: Severity[] = ['blocker', 'high', 'medium', 'low', 'nit'];
    const groups: TaskListItem[] = [];

    for (const sev of severityOrder) {
      const findings = this.findings.filter(f => f.severity === sev);
      if (findings.length === 0) { continue; }

      const openCount = findings.filter(f => f.status === 'open').length;
      const group = new TaskListItem(
        `${sev.toUpperCase()} (${findings.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      group.contextValue = 'severityGroup';
      group.description = `${openCount} open`;
      group.iconPath = severityIcon(sev);
      group.children = findings.map(f => this.findingToTreeItem(f, group));
      groups.push(group);
    }

    return groups;
  }

  private findingToTreeItem(finding: ReviewFinding, parent: TaskListItem): TaskListItem {
    const item = new TaskListItem(
      finding.title,
      vscode.TreeItemCollapsibleState.None,
    );

    item.contextValue = 'finding';
    item.description = `${finding.file}:${finding.startLine}`;
    item.iconPath = severityIcon(finding.severity);
    item.tooltip = new vscode.MarkdownString(
      `**${finding.severity.toUpperCase()}** — ${finding.category}\n\n${finding.description}`
    );
    item.parent = parent;
    item.findingId = finding.id;

    // Strikethrough for resolved findings
    if (finding.status !== 'open') {
      item.description = `~~${item.description}~~ (${finding.status})`;
    }

    // Click navigates to the finding
    item.command = {
      command: 'selfReview.goToFinding',
      title: 'Go to Finding',
      arguments: [finding.id],
    };

    return item;
  }
}

export class TaskListItem extends vscode.TreeItem {
  children?: TaskListItem[];
  parent?: TaskListItem;
  findingId?: string;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsibleState);
  }
}
