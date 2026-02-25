import * as vscode from 'vscode';
import { ReviewFinding, severityIcon, severityRank, Severity } from './types';

/** Apply Unicode combining long stroke overlay (U+0336) to every character. */
function strikeThrough(text: string): string {
  try {
    return Array.from(new Intl.Segmenter().segment(text))
      .map(({ segment }) => segment + '\u0336')
      .join('');
  } catch {
    // Fallback for environments where Intl.Segmenter is unavailable
    return [...text].map(ch => ch + '\u0336').join('');
  }
}

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
  private groupBy: 'file' | 'severity' = 'severity';
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

  getFileFindings(filePath: string): ReviewFinding[] {
    return this.findings.filter(f => f.file === filePath && f.status === 'open');
  }

  clearAll(): void {
    this.findings = [];
    this.refresh();
  }

  toggleGroupBy(): void {
    this.groupBy = this.groupBy === 'file' ? 'severity' : 'file';
    this.refresh();
  }

  getGroupBy(): 'file' | 'severity' {
    return this.groupBy;
  }

  setGroupBy(mode: 'file' | 'severity'): void {
    this.groupBy = mode;
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

    const resolved = this.findings.filter(f => f.status !== 'open').length;
    const total = this.findings.length;

    // Summary item
    const summary = new TaskListItem(
      `${resolved}/${total} resolved`,
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
      const resolvedCount = findings.filter(f => f.status !== 'open').length;
      const group = new TaskListItem(
        file,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      group.contextValue = 'fileGroup';
      group.description = `${resolvedCount}/${findings.length} resolved`;
      group.iconPath = new vscode.ThemeIcon('file');
      group.filePath = file;
      group.children = findings.map(f => this.findingToTreeItem(f, group));
      groups.push(group);
    }

    return groups;
  }

  private groupBySeverity(): TaskListItem[] {
    // 'nit' is intentionally kept here even though the default severityThreshold
    // is 'low' (which filters nit findings during review). Findings from older
    // stored data or a user-configured lower threshold can include 'nit', and
    // displaying them is safer than silently dropping them.
    const severityOrder: Severity[] = ['blocker', 'high', 'medium', 'low', 'nit'];
    const groups: TaskListItem[] = [];

    for (const sev of severityOrder) {
      const findings = this.findings.filter(f => f.severity === sev);
      if (findings.length === 0) { continue; }

      const resolvedCount = findings.filter(f => f.status !== 'open').length;
      const sevGroup = new TaskListItem(
        `${sev.toUpperCase()} (${findings.length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      sevGroup.contextValue = 'severityGroup';
      sevGroup.description = `${resolvedCount}/${findings.length} resolved`;
      sevGroup.iconPath = severityIcon(sev);

      // Sub-group by file within each severity
      const fileMap = new Map<string, ReviewFinding[]>();
      for (const f of findings) {
        const arr = fileMap.get(f.file) || [];
        arr.push(f);
        fileMap.set(f.file, arr);
      }

      const fileEntries = Array.from(fileMap.entries());
      fileEntries.sort((a, b) => a[0].localeCompare(b[0]));

      sevGroup.children = fileEntries.map(([file, fileFindings]) => {
        const fileResolvedCount = fileFindings.filter(f => f.status !== 'open').length;
        const fileGroup = new TaskListItem(
          file,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        fileGroup.contextValue = 'fileGroup';
        fileGroup.description = `${fileResolvedCount}/${fileFindings.length} resolved`;
        fileGroup.iconPath = new vscode.ThemeIcon('file');
        fileGroup.filePath = file;
        fileGroup.parent = sevGroup;
        fileGroup.children = fileFindings.map(f => this.findingToTreeItem(f, fileGroup));
        return fileGroup;
      });

      groups.push(sevGroup);
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

    // TreeItem.description is plain text (no Markdown), so use a visual text/icon indicator.
    if (finding.status === 'in-progress') {
      item.description = `⏳ ${item.description} (in-progress)`;
      item.iconPath = new vscode.ThemeIcon('sync');
    } else if (finding.status !== 'open') {
      item.label = strikeThrough(finding.title);
      item.description = `✓ ${item.description} (${finding.status})`;
      item.iconPath = new vscode.ThemeIcon('pass');
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
  filePath?: string;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsibleState);
  }
}
