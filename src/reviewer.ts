import * as vscode from 'vscode';
import { DiffChunk, ReviewFinding, SelfReviewConfig, Severity, Category, nextFindingId, severityRank } from './types';
import { buildChunkContext } from './chunker';

/**
 * AI-powered code review engine using the VS Code Language Model API.
 */
export class ReviewEngine {
  private model: vscode.LanguageModelChat | undefined;
  private _selectedModelId: string | undefined;

  /**
   * Set a specific model by ID (the `id` property of `vscode.LanguageModelChat`).
   * Pass undefined to reset to auto-selection.
   */
  setModel(modelId: string | undefined): void {
    if (this._selectedModelId !== modelId) {
      this._selectedModelId = modelId;
      this.model = undefined; // clear cached model so ensureModel re-selects
    }
  }

  /** Return the currently selected model ID (family) or undefined for auto */
  get selectedModelId(): string | undefined {
    return this._selectedModelId;
  }

  /**
   * List all available Copilot language models.
   */
  async listModels(): Promise<vscode.LanguageModelChat[]> {
    return vscode.lm.selectChatModels({ vendor: 'copilot' });
  }

  /**
   * Select and cache a Copilot language model.
   */
  async ensureModel(): Promise<vscode.LanguageModelChat> {
    if (this.model) { return this.model; }

    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) {
      throw new Error('No Copilot language model available. Make sure GitHub Copilot is installed and signed in.');
    }

    if (this._selectedModelId) {
      const match = models.find(m => m.id === this._selectedModelId);
      if (match) {
        this.model = match;
        return this.model;
      }
    }

    // Auto-select: prefer a larger model
    this.model = models.find(m => m.family.includes('claude') || m.family.includes('gpt-4'))
      || models[0];

    return this.model;
  }

  /**
   * Send a request to the model, retrying once with a fresh model if the
   * cached reference has become stale (session expired, model uninstalled, etc.).
   */
  private async sendRequestWithRetry(
    messages: vscode.LanguageModelChatMessage[],
    options: vscode.LanguageModelChatRequestOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatResponse> {
    const model = await this.ensureModel();
    try {
      return await model.sendRequest(messages, options, token);
    } catch (err: any) {
      // Only retry on errors that suggest a stale model reference (e.g. session
      // expired, model uninstalled). Do NOT retry cancellations or quota/rate-limit
      // errors — those would silently re-execute a full LLM call at extra cost.
      const isStale = err?.code === 'model-not-found' || err?.message?.includes('not available');
      if (!isStale || token.isCancellationRequested) { throw err; }
      this.model = undefined;
      const freshModel = await this.ensureModel();
      return await freshModel.sendRequest(messages, options, token);
    }
  }

  /**
   * Build the system prompt for the review.
   */
  private buildSystemPrompt(config: SelfReviewConfig): string {
    const categories = config.categories.join(', ');
    const severity = config.severityThreshold;

    let prompt = `You are a senior code reviewer performing a self-review of a branch diff. Your job is to find real, actionable issues — not nitpick style or formatting.

## Review Focus Areas
Review for these categories: ${categories}

## Severity Levels
- blocker: Will cause production breakage, data loss, or security vulnerability
- high: Significant bug, performance issue, or security concern
- medium: Code smell, missing edge case, or maintainability issue
- low: Minor improvement opportunity
- nit: Style or preference suggestion

Only report findings at severity "${severity}" or above.

## Rules
- Focus on the CHANGED lines (marked with +). Do not review unchanged context.
- Be specific: reference exact file paths and line numbers from the diff.
- Each finding must have a concrete suggested fix.
- Do NOT report: formatting issues, trailing whitespace, missing comments on obvious code.
- Do NOT hallucinate line numbers. Only reference lines that appear in the diff context.
- If the code looks correct and well-written, return an empty array.
- Maximum ${config.maxFindings} findings total across all chunks.

## Output Format
Respond with ONLY a JSON array (no markdown fences, no explanation before/after). Each element:
{
  "file": "path/to/file.rb",
  "startLine": 42,
  "endLine": 44,
  "severity": "medium",
  "title": "Short title of the issue",
  "description": "Detailed explanation of why this is a problem and its impact.",
  "suggestedFix": "Code or description of how to fix it.",
  "category": "correctness"
}

If there are no findings, respond with: []`;

    if (config.customInstructions) {
      prompt += `\n\n## Additional Project Instructions\n${config.customInstructions}`;
    }

    return prompt;
  }

  /**
   * Review a single chunk of diff files.
   * @param onToken Optional callback invoked with each streamed token fragment
   */
  async reviewChunk(
    chunk: DiffChunk,
    config: SelfReviewConfig,
    token: vscode.CancellationToken,
    onToken?: (fragment: string) => void
  ): Promise<ReviewFinding[]> {
    const systemPrompt = this.buildSystemPrompt(config);
    const chunkContext = buildChunkContext(chunk);

    const messages = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.Assistant('Understood. I will review the code changes following these instructions and respond with only a JSON array of findings.'),
      vscode.LanguageModelChatMessage.User(`Review the following code changes:\n\n${chunkContext}`),
    ];

    const response = await this.sendRequestWithRetry(messages, {
      justification: 'Self Review: Analyzing branch diff for code issues',
    }, token);

    // Collect the full streamed response, forwarding tokens to caller
    let fullText = '';
    for await (const fragment of response.text) {
      if (token.isCancellationRequested) { break; }
      fullText += fragment;
      if (onToken) { onToken(fragment); }
    }

    if (token.isCancellationRequested) { return []; }

    return this.parseFindings(fullText, config);
  }

  /**
   * Parse the AI response into ReviewFinding objects.
   */
  private parseFindings(responseText: string, config: SelfReviewConfig): ReviewFinding[] {
    // Strip markdown fences if the model wrapped the JSON
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    // First, try to parse the cleaned text directly as JSON.
    // Fall back to a bracket-search heuristic only if that fails, to avoid
    // incorrectly slicing strings that contain nested arrays or trailing text.
    let rawFindings: Array<{
      file?: string;
      startLine?: number;
      endLine?: number;
      severity?: string;
      title?: string;
      description?: string;
      suggestedFix?: string;
      category?: string;
    }>;

    try {
      const direct = JSON.parse(cleaned);
      if (Array.isArray(direct)) {
        rawFindings = direct;
      } else {
        return [];
      }
    } catch {
      // Direct parse failed — try to extract the outermost JSON array via bracket search
      const arrayStart = cleaned.indexOf('[');
      const arrayEnd = cleaned.lastIndexOf(']');
      if (arrayStart === -1 || arrayEnd === -1) {
        return [];
      }
      try {
        const extracted = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
        if (!Array.isArray(extracted)) { return []; }
        rawFindings = extracted;
      } catch (err) {
        vscode.window.showWarningMessage(`Self Review: Failed to parse AI response: ${err}`);
        return [];
      }
    }

    const threshold = severityRank(config.severityThreshold);

    return rawFindings
      .filter(f => f.file && f.startLine != null && f.title)
      .filter(f => severityRank((f.severity || 'low') as Severity) >= threshold)
      .slice(0, config.maxFindings)
      .map(f => ({
        id: nextFindingId(),
        file: f.file!,
        startLine: f.startLine!,
        endLine: f.endLine || f.startLine!,
        severity: (f.severity || 'medium') as Severity,
        title: f.title!,
        description: f.description || '',
        suggestedFix: f.suggestedFix,
        category: (f.category || 'other') as Category,
        status: 'open' as const,
      }));
  }

  /**
   * Generate a fix for a specific finding using the AI.
   */
  async generateFix(
    finding: ReviewFinding,
    fileContent: string,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    // Truncate file content to a window around the relevant lines to avoid
    // exceeding the model's context window on very large files.
    const contextRadius = 100;
    const lines = fileContent.split('\n');
    const windowStart = Math.max(0, finding.startLine - 1 - contextRadius);
    // finding.endLine is 1-based; slice's end is exclusive. The two offset
    // directions cancel out, so `endLine + contextRadius` is intentionally correct.
    const windowEnd = Math.min(lines.length, finding.endLine + contextRadius);
    const truncatedLines = lines.slice(windowStart, windowEnd);
    const lineOffset = windowStart + 1; // 1-based line number of first included line
    const truncatedContent = truncatedLines.join('\n');
    const wasTruncated = windowStart > 0 || windowEnd < lines.length;

    const systemInstruction = `You are a code fixer. Given a code review finding and the file content around the affected lines, generate the corrected code.

## Instructions
- Output ONLY the replacement code for lines ${finding.startLine}-${finding.endLine}.
- Do not include line numbers, markdown fences, or explanations.
- The output should be a drop-in replacement that fixes the issue.
- Preserve indentation and style of the surrounding code.
- If the fix requires deleting the line(s) entirely with no replacement, output exactly: <<DELETE>>`;

    const messages = [
      vscode.LanguageModelChatMessage.User(systemInstruction),
      vscode.LanguageModelChatMessage.Assistant('Understood. I will output only the replacement code with no extra formatting.'),
      vscode.LanguageModelChatMessage.User(
        `## Finding
- File: ${finding.file}
- Lines: ${finding.startLine}-${finding.endLine}
- Issue: ${finding.title}
- Description: ${finding.description}
${finding.suggestedFix ? `- Suggested approach: ${finding.suggestedFix}` : ''}

## File Content${wasTruncated ? ` (lines ${lineOffset}-${windowStart + truncatedLines.length} of ${lines.length})` : ''}
\`\`\`
${truncatedContent}
\`\`\``
      ),
    ];

    const response = await this.sendRequestWithRetry(messages, {
      justification: 'Self Review: Generating fix for review finding',
    }, token);

    let fixText = '';
    for await (const fragment of response.text) {
      if (token.isCancellationRequested) { return undefined; }
      fixText += fragment;
    }

    // Strip markdown fences if present
    fixText = fixText.trim();
    if (fixText.startsWith('```')) {
      const firstNewline = fixText.indexOf('\n');
      fixText = fixText.slice(firstNewline + 1);
    }
    if (fixText.endsWith('```')) {
      fixText = fixText.slice(0, -3).trimEnd();
    }

    // Handle deletion sentinel — the AI outputs <<DELETE>> when lines should be removed entirely
    if (fixText.trim() === '<<DELETE>>') {
      return '';
    }

    return fixText;
  }
}
