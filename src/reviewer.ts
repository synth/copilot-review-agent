import * as vscode from 'vscode';
import { DiffChunk, DiffFile, ReviewFinding, CopilotReviewAgentConfig, Severity, Category, nextFindingId, severityRank } from './types';
import { buildChunkContext } from './chunker';
import { REVIEW_TOOLS, executeTool, ToolCallInput } from './tools';
import { SubagentDefinition, getActiveSubagents, buildSubagentContext } from './subagents';

/**
 * AI-powered code review engine using the VS Code Language Model API.
 */
/** Callback for reporting tool calls during the agent loop */
export interface ToolCallReporter {
  (toolName: string, input: Record<string, unknown>): void;
}

export class ReviewEngine {
  private model: vscode.LanguageModelChat | undefined;
  private _selectedModelId: string | undefined;
  private _workspacePath: string | undefined;

  /** Set the workspace path so tools can execute git/fs operations */
  setWorkspace(workspacePath: string): void {
    this._workspacePath = workspacePath;
  }

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

  /** Return the resolved model ID for the current review session. */
  get activeModelId(): string | undefined {
    return this.model?.id;
  }

  /** Return the resolved model label for the current review session. */
  get activeModelLabel(): string | undefined {
    if (!this.model) { return undefined; }
    return this.model.name || this.model.family || this.model.id;
  }

  /**
   * List all available Copilot language models.
   * Clears the cached model so that the next call to ensureModel() will
   * re-select from the current model list (handles subscription changes, etc.).
   */
  async listModels(): Promise<vscode.LanguageModelChat[]> {
    this.model = undefined;
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

    // Auto-select: prefer models by explicit priority (claude > gpt-4 > others).
    // Use startsWith so that versioned family names such as 'claude-sonnet',
    // 'claude-3.5-sonnet', 'gpt-4o', and 'gpt-4-turbo' are all matched by their
    // respective prefix patterns.
    const modelPreference = ['claude', 'gpt-4'];
    for (const pattern of modelPreference) {
      const candidate = models.find(m => m.family.startsWith(pattern));
      if (candidate) {
        this.model = candidate;
        return this.model;
      }
    }

    // Fall back to first available model if no preferred model is found
    this.model = models[0];
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
      // Check multiple error properties for compatibility across API versions:
      // - err.code: primary indicator (e.g., 'model-not-found')
      // - err.name: alternative error classification
      // Note: other transient failures (network, auth token expiration) are not
      // currently retried; consider adding more error codes if needed.
      const isStale = (
        err?.code === 'model-not-found' ||
        err?.name === 'ModelNotFoundError'
      );
      if (!isStale || token.isCancellationRequested) { throw err; }
      console.warn('Copilot Review Agent: Model reference stale, retrying with fresh model', err?.code || err?.name);
      this.model = undefined;
      const freshModel = await this.ensureModel();
      return await freshModel.sendRequest(messages, options, token);
    }
  }

  /**
   * Build the system prompt for Tier 1 broad pass reviews.
   */
  buildSystemPrompt(config: CopilotReviewAgentConfig): string {
    const categories = config.categories.join(', ');
    const severity = config.severityThreshold;
    const hasTools = !!this._workspacePath;

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

## Review Approach
1. Scan the diff for potential issues in the changed code.
2. For anything that depends on code outside the diff — unused functions, broken callers, missing imports, cross-file impacts — use the available tools to investigate before reporting.
3. Do NOT report an issue unless you have evidence. If unsure, use a tool to verify.

## Checklist
- Dead code: Are any new functions/methods/classes never called? Use check_symbol_usage to verify.
- Security: SQL injection, XSS, command injection, hardcoded secrets, insecure auth.
- Error handling: Are new async calls, API calls, or I/O operations properly error-handled?
- Logic: Off-by-one errors, null/undefined checks, race conditions, wrong comparisons.
- API contracts: If function signatures changed, are all callers updated?
- Performance: N+1 queries, O(n²) in hot paths, unnecessary allocations in loops.

## Rules
- Focus primarily on the CHANGED lines (marked with +), but investigate cross-file impacts using tools.
- Be specific: reference exact file paths and line numbers from the diff.
- Each finding must have a concrete suggested fix.
- Do NOT report: formatting issues, trailing whitespace, missing comments on obvious code.
- Do NOT hallucinate line numbers. Only reference lines that appear in the diff context.
- If the code looks correct and well-written, return an empty array.
- Maximum ${config.maxFindings} findings total across all chunks.`;

    if (hasTools) {
      prompt += `\n\n## Tools Available
You have tools to investigate the codebase. Use them to verify findings before reporting:
- search_codebase: Find references, callers, or patterns in the code.
- read_file_section: Read specific lines of a file for more context.
- check_symbol_usage: Count how many times a symbol is referenced.
- get_file_outline: See the structure of a file (classes, functions, imports, exports).

When you have finished investigating and are ready to report findings, respond with the JSON array.`;
    }

    prompt += `\n\n## Output Format
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
   * Run the agent loop: send messages with tool definitions to the LLM,
   * handle tool call responses, execute tools, and re-send until the model
   * responds with pure text (the findings JSON).
   *
   * @param messages The conversation messages
   * @param token Cancellation token
   * @param maxIterations Maximum tool-calling iterations (default 10)
   * @param onToken Optional callback for streaming text tokens
   * @param onToolCall Optional callback for reporting tool invocations
   * @returns The final collected text response
   */
  async sendWithToolLoop(
    messages: vscode.LanguageModelChatMessage[],
    token: vscode.CancellationToken,
    maxIterations: number = 10,
    onToken?: (fragment: string) => void,
    onToolCall?: ToolCallReporter
  ): Promise<string> {
    if (!this._workspacePath) {
      // No workspace — fall back to a single call without tools
      return this.sendSinglePass(messages, token, onToken);
    }

    const tools = REVIEW_TOOLS;
    let iteration = 0;

    while (iteration < maxIterations) {
      if (token.isCancellationRequested) { return ''; }

      let response: vscode.LanguageModelChatResponse;
      try {
        response = await this.sendRequestWithRetry(messages, {
          justification: 'Copilot Review Agent: Analyzing branch diff for code issues',
          tools,
        }, token);
      } catch (err: any) {
        // If the model doesn't support tools, fall back to single pass
        if (err?.message?.includes('tool') || err?.code === 'tool-not-supported') {
          return this.sendSinglePass(messages, token, onToken);
        }
        throw err;
      }

      // Collect the response stream — may contain text and/or tool calls
      let textContent = '';
      const toolCalls: Array<{ callId: string; name: string; input: ToolCallInput }> = [];

      try {
        for await (const part of response.stream) {
          if (token.isCancellationRequested) { return textContent; }

          if (part instanceof vscode.LanguageModelTextPart) {
            textContent += part.value;
            if (onToken) { onToken(part.value); }
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push({
              callId: part.callId,
              name: part.name,
              input: part.input as ToolCallInput,
            });
          }
        }
      } catch (err: unknown) {
        if (textContent) { return textContent; }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Stream error during tool loop iteration ${iteration}: ${msg}`);
      }

      // If no tool calls, the model is done — return the text
      if (toolCalls.length === 0) {
        return textContent;
      }

      // The model made tool calls — execute them and continue the loop
      // First, add the assistant's response (text + tool calls) to messages
      const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      if (textContent) {
        assistantParts.push(new vscode.LanguageModelTextPart(textContent));
      }
      for (const tc of toolCalls) {
        assistantParts.push(new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input));
      }
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

      // Execute all tool calls in parallel to avoid blocking the extension host
      for (const tc of toolCalls) {
        if (onToolCall) { onToolCall(tc.name, tc.input); }
      }

      const toolResults = await Promise.all(
        toolCalls.map(async (tc) => {
          let result: string;
          try {
            result = await executeTool(tc.name, tc.input, this._workspacePath!);
          } catch (err: any) {
            result = `Tool error: ${err.message}`;
          }
          return new vscode.LanguageModelToolResultPart(tc.callId, [new vscode.LanguageModelTextPart(result)]);
        })
      );
      const toolResultParts: vscode.LanguageModelToolResultPart[] = toolResults;

      // Add tool results as a User message
      messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));

      iteration++;
    }

    // Max iterations reached — do one final call without tools to force a text response
    return this.sendSinglePass(messages, token, onToken);
  }

  /**
   * Single-pass LLM call without tools. Used as fallback and for final iteration.
   */
  private async sendSinglePass(
    messages: vscode.LanguageModelChatMessage[],
    token: vscode.CancellationToken,
    onToken?: (fragment: string) => void
  ): Promise<string> {
    let fullText = '';
    try {
      const response = await this.sendRequestWithRetry(messages, {
        justification: 'Copilot Review Agent: Analyzing branch diff for code issues',
      }, token);

      for await (const fragment of response.text) {
        if (token.isCancellationRequested) { break; }
        fullText += fragment;
        if (onToken) { onToken(fragment); }
      }
    } catch (err: unknown) {
      if (fullText) { return fullText; }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Single-pass LLM call failed (fallback/final pass): ${msg}`);
    }
    return fullText;
  }

  /**
   * Review a single chunk of diff files.
   * @param onToken Optional callback invoked with each streamed token fragment
   * @param onToolCall Optional callback for reporting tool invocations
   */
  async reviewChunk(
    chunk: DiffChunk,
    config: CopilotReviewAgentConfig,
    token: vscode.CancellationToken,
    onToken?: (fragment: string) => void,
    onToolCall?: ToolCallReporter
  ): Promise<ReviewFinding[]> {
    const systemPrompt = this.buildSystemPrompt(config);
    const chunkContext = buildChunkContext(chunk, config);

    const messages = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.Assistant('Understood. I will review the code changes following these instructions and respond with only a JSON array of findings.'),
      vscode.LanguageModelChatMessage.User(`Review the following code changes:\n\n${chunkContext}`),
    ];

    const fullText = await this.sendWithToolLoop(messages, token, config.maxToolCallsPerAgent ?? 10, onToken, onToolCall);

    if (token.isCancellationRequested) { return []; }

    return this.parseFindings(fullText, config);
  }

  /**
   * Parse the AI response into ReviewFinding objects.
   */
  private parseFindings(responseText: string, config: CopilotReviewAgentConfig): ReviewFinding[] {
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
        vscode.window.showWarningMessage(`Copilot Review Agent: Failed to parse AI response: ${err}`);
        return [];
      }
    }

    const threshold = severityRank(config.severityThreshold);
    const validSeverities = new Set<string>(['blocker', 'high', 'medium', 'low', 'nit']);

    return rawFindings
      .filter(f => f.file && f.startLine != null && f.title)
      .filter(f => validSeverities.has(f.severity || 'low'))
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
      justification: 'Copilot Review Agent: Generating fix for review finding',
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

  /**
   * Run Tier 2 specialist subagents in parallel against the full set of diff files.
   * Each subagent runs its own tool loop and produces findings tagged with its source.
   *
   * @param files All diff files from the review
   * @param config Review configuration
   * @param token Cancellation token
   * @param onSubagentStart Called when a subagent begins (for progress display)
   * @param onSubagentDone Called when a subagent finishes (for progress display)
   * @param onToolCall Called when a subagent invokes a tool
   */
  async runSubagents(
    files: DiffFile[],
    config: CopilotReviewAgentConfig,
    token: vscode.CancellationToken,
    onSubagentStart?: (agent: SubagentDefinition) => void,
    onSubagentDone?: (agent: SubagentDefinition, findings: ReviewFinding[]) => void,
    onToolCall?: ToolCallReporter
  ): Promise<ReviewFinding[]> {
    const agents = getActiveSubagents(config, files);
    if (agents.length === 0) { return []; }

    const parallelLimit = config.parallelSubagents;
    const allFindings: ReviewFinding[] = [];

    // Run subagents in batches of parallelLimit
    for (let i = 0; i < agents.length; i += parallelLimit) {
      if (token.isCancellationRequested) { break; }

      const batch = agents.slice(i, i + parallelLimit);
      const batchResults = await Promise.all(
        batch.map(agent => this.runSingleSubagent(agent, files, config, token, onSubagentStart, onToolCall))
      );

      for (let j = 0; j < batch.length; j++) {
        const findings = batchResults[j];
        if (onSubagentDone) { onSubagentDone(batch[j], findings); }
        allFindings.push(...findings);
      }
    }

    return allFindings;
  }

  /**
   * Execute a single specialist subagent.
   */
  private async runSingleSubagent(
    agent: SubagentDefinition,
    files: DiffFile[],
    config: CopilotReviewAgentConfig,
    token: vscode.CancellationToken,
    onSubagentStart?: (agent: SubagentDefinition) => void,
    onToolCall?: ToolCallReporter
  ): Promise<ReviewFinding[]> {
    if (onSubagentStart) { onSubagentStart(agent); }

    const systemPrompt = agent.buildPrompt(config);
    const context = buildSubagentContext(agent, files, config);

    const messages = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.Assistant('Understood. I will focus exclusively on my specialty area and use tools to verify findings before reporting.'),
      vscode.LanguageModelChatMessage.User(`Analyze the following code changes:\n\n${context}`),
    ];

    try {
      const fullText = await this.sendWithToolLoop(
        messages, token, config.maxToolCallsPerAgent ?? 10, undefined, onToolCall
      );

      if (token.isCancellationRequested) { return []; }

      const findings = this.parseFindings(fullText, config);
      // Tag each finding with the subagent source
      for (const f of findings) {
        f.source = agent.id;
      }
      return findings;
    } catch (err: any) {
      // Don't let one subagent failure kill the entire review
      vscode.window.showWarningMessage(`Copilot Review Agent: ${agent.label} failed: ${err.message}`);
      return [];
    }
  }
}
