import * as vscode from 'vscode';
import { ReviewSession, ReviewFinding, ReviewAgentStep, ReviewSessionSummary } from './types';

const STORAGE_KEY = 'selfReview.reviewHistory';
const MAX_HISTORY = 50;

/**
 * Persistence layer for review history.
 * Uses VS Code workspaceState so history is per-workspace.
 */
export class ReviewStore {
  private _writeLock = Promise.resolve();

  constructor(private readonly state: vscode.Memento) {}

  /**
   * Serialize writes to prevent race conditions.
   *
   * The internal lock promise always resolves so the chain is never broken,
   * but the promise **returned to the caller** will reject if `fn` rejects.
   * Callers must either `await` the result inside a try/catch or attach a
   * `.catch()` handler — fire-and-forget usage will produce an unhandled
   * promise rejection.
   */
  private async _serialized<T>(fn: () => Promise<T>): Promise<T> {
    const p = this._writeLock.then(fn);
    this._writeLock = p.then(() => {}, (err) => { console.error('ReviewStore write error:', err); });
    return p;
  }

  /**
   * Get all past review sessions, newest first.
   *
   * **Consistency note:** reads directly from `this.state` without acquiring
   * the serialization lock. If a write is currently in flight the returned
   * snapshot may not yet reflect that write (eventual consistency). This is
   * intentional — the synchronous API is kept for convenience since most
   * callers do not require read-after-write guarantees. If strict
   * read-after-write consistency is needed, `await` all preceding `save()` /
   * `delete()` calls before calling this method.
   *
   * Data is stored already sorted by `save()`, so no re-sort is needed here.
   */
  getAll(): ReviewSession[] {
    return [...this.state.get<ReviewSession[]>(STORAGE_KEY, [])];
  }

  /**
   * Get a single review by ID.
   *
   * **Consistency note:** same eventual-consistency caveat as `getAll()` —
   * reads directly from `this.state` without the serialization lock.
   */
  get(id: string): ReviewSession | undefined {
    return this.state.get<ReviewSession[]>(STORAGE_KEY, []).find(r => r.id === id);
  }

  /** Save a new or updated review session */
  async save(session: ReviewSession): Promise<void> {
    return this._serialized(async () => {
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
    });
  }

  /** Delete a review session by ID */
  async delete(id: string): Promise<void> {
    return this._serialized(async () => {
      const all = this.state.get<ReviewSession[]>(STORAGE_KEY, []);
      const filtered = all.filter(r => r.id !== id);
      await this.state.update(STORAGE_KEY, filtered);
    });
  }

  /** Clear all history */
  async clearAll(): Promise<void> {
    return this._serialized(async () => {
      await this.state.update(STORAGE_KEY, []);
    });
  }

  /** Update findings for a session (when user skips/fixes items) */
  async updateFindings(sessionId: string, findings: ReviewFinding[]): Promise<void> {
    return this._serialized(async () => {
      const all = this.state.get<ReviewSession[]>(STORAGE_KEY, []);
      if (!all.some(r => r.id === sessionId)) { return; }
      const openCount = findings.filter(f => f.status === 'open').length;
      const fileCount = new Set(findings.map(f => f.file)).size;
      const allCopy = all.map(r => r.id === sessionId ? {
        ...r,
        findings,
        summary: {
          ...r.summary,
          totalFindings: findings.length,
          openCount,
          fileCount,
        },
      } : r);

      await this.state.update(STORAGE_KEY, allCopy);
    });
  }
}
