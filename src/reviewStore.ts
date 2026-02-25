import * as vscode from 'vscode';
import { ReviewSession, ReviewFinding, ReviewAgentStep, ReviewSessionSummary } from './types';

const STORAGE_KEY = 'selfReview.reviewHistory';
const MAX_HISTORY = 50;

/**
 * Persistence layer for review history.
 * Uses VS Code workspaceState so history is per-workspace.
 */
export class ReviewStore {
  constructor(private readonly state: vscode.Memento) {}

  /** Get all past review sessions, newest first */
  getAll(): ReviewSession[] {
    const data = this.state.get<ReviewSession[]>(STORAGE_KEY, []);
    // Ensure newest first
    return data.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Get a single review by ID */
  get(id: string): ReviewSession | undefined {
    return this.state.get<ReviewSession[]>(STORAGE_KEY, []).find(r => r.id === id);
  }

  /** Save a new or updated review session */
  async save(session: ReviewSession): Promise<void> {
    const all = this.state.get<ReviewSession[]>(STORAGE_KEY, []);
    const idx = all.findIndex(r => r.id === session.id);
    if (idx >= 0) {
      all[idx] = session;
    } else {
      all.unshift(session);
    }

    // Trim to max history size
    const trimmed = all
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_HISTORY);

    await this.state.update(STORAGE_KEY, trimmed);
  }

  /** Delete a review session by ID */
  async delete(id: string): Promise<void> {
    const all = this.state.get<ReviewSession[]>(STORAGE_KEY, []);
    const filtered = all.filter(r => r.id !== id);
    await this.state.update(STORAGE_KEY, filtered);
  }

  /** Clear all history */
  async clearAll(): Promise<void> {
    await this.state.update(STORAGE_KEY, []);
  }

  /** Update findings for a session (when user skips/fixes items) */
  async updateFindings(sessionId: string, findings: ReviewFinding[]): Promise<void> {
    const all = this.state.get<ReviewSession[]>(STORAGE_KEY, []);
    const session = all.find(r => r.id === sessionId);
    if (!session) { return; }

    session.findings = findings;
    const openCount = findings.filter(f => f.status === 'open').length;
    const fileCount = new Set(findings.map(f => f.file)).size;
    session.summary = {
      totalFindings: findings.length,
      openCount,
      fileCount,
    };

    await this.state.update(STORAGE_KEY, all);
  }
}
