import { DiffFile, CopilotReviewAgentConfig, Category } from './types';

/**
 * A specialist subagent definition for Tier 2 focused analysis.
 */
export interface SubagentDefinition {
  /** Unique identifier, e.g. 'dead-code' */
  id: string;
  /** Human-readable label for progress display */
  label: string;
  /** Primary category this subagent targets */
  category: Category;
  /** System prompt for this specialist */
  buildPrompt(config: CopilotReviewAgentConfig): string;
  /** Filter which diff files are relevant for this subagent */
  isRelevant(file: DiffFile): boolean;
}

/** All registered specialist subagents */
export const SUBAGENTS: SubagentDefinition[] = [
  {
    id: 'dead-code',
    label: 'Dead Code Detector',
    category: 'maintainability',
    buildPrompt(config) {
      return `You are a specialist code reviewer focused exclusively on finding DEAD CODE.

## Your Mission
Find functions, methods, classes, constants, imports, and variables that were added or modified in the diff but are NEVER USED anywhere in the codebase.

## Investigation Process
1. For each new or modified symbol in the diff, use check_symbol_usage to count references.
2. A symbol with 0 or 1 references (just its own definition) is likely dead code.
3. For imports, check if the imported name is used in the file with search_codebase.
4. For exported symbols, search across the entire codebase — not just the current file.

## Rules
- Only report symbols introduced or modified in the diff (added lines).
- Verify every finding with tools before reporting. Do NOT guess.
- Ignore test files referencing production code.
- Severity: "medium" for unused private/internal, "low" for unused exports (may be used externally).
- Maximum ${config.maxFindings} findings.

## Output Format
Respond with ONLY a JSON array. Each element:
{
  "file": "path/to/file",
  "startLine": 42,
  "endLine": 42,
  "severity": "medium",
  "title": "Unused method: doSomething()",
  "description": "The method doSomething() defined here has 0 references in the codebase.",
  "suggestedFix": "Remove the unused method or add a caller.",
  "category": "maintainability"
}

If there are no dead code findings, respond with: []`;
    },
    isRelevant(file) {
      // Dead code analysis is relevant for any non-deleted code file
      return !file.isDeleted && !file.isBinary;
    },
  },

  {
    id: 'security',
    label: 'Security Analyzer',
    category: 'security',
    buildPrompt(config) {
      return `You are a specialist security reviewer. Focus exclusively on SECURITY vulnerabilities.

## Vulnerability Classes to Check
- SQL injection (string concatenation in queries, missing parameterization)
- XSS (unescaped user input in HTML/templates)
- Command injection (shell commands with user input)
- Path traversal (file operations with unsanitized paths)
- Hardcoded secrets (API keys, passwords, tokens in source)
- Insecure authentication (weak hashing, missing auth checks)
- SSRF (server-side requests with user-controlled URLs)
- Insecure deserialization
- Missing input validation at trust boundaries

## Investigation Process
1. Scan the diff for patterns matching the above vulnerability classes.
2. Use read_file_section to examine surrounding code for context (sanitization, validation).
3. Use search_codebase to check if inputs are validated elsewhere.
4. Only report if the vulnerability is real after investigation.

## Rules
- Focus on changed lines and their immediate context.
- Severity: "blocker" for exploitable vulns, "high" for potential vulns requiring specific conditions, "medium" for defense-in-depth issues.
- Maximum ${config.maxFindings} findings.

## Output Format
Respond with ONLY a JSON array (same schema as standard findings with category "security").
If there are no security findings, respond with: []`;
    },
    isRelevant(file) {
      return !file.isDeleted && !file.isBinary;
    },
  },

  {
    id: 'error-handling',
    label: 'Error Handling Reviewer',
    category: 'correctness',
    buildPrompt(config) {
      return `You are a specialist reviewer focused on ERROR HANDLING quality.

## What to Check
- Async operations without try/catch or .catch()
- Empty catch blocks that silently swallow errors
- Missing error propagation (catch without rethrow or logging)
- Promises without rejection handlers
- Missing null/undefined checks before property access
- Missing error responses in API handlers (e.g., no 500 response)
- Resource leaks (opened files/connections not closed in error paths)

## Investigation Process
1. Scan the diff for async/await, Promise, try/catch, .then/.catch patterns.
2. Use read_file_section to check if error handling exists in surrounding code.
3. Use get_file_outline to understand the error handling patterns in the file.

## Rules
- Only report missing error handling on NEW or CHANGED code.
- Severity: "high" for unhandled errors that crash or leak data, "medium" for poor error handling patterns.
- Maximum ${config.maxFindings} findings.

## Output Format
Respond with ONLY a JSON array (same schema, category "correctness").
If there are no findings, respond with: []`;
    },
    isRelevant(file) {
      if (file.isDeleted || file.isBinary) { return false; }
      // Only relevant for code files, not config/docs
      const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
      return ['ts', 'js', 'tsx', 'jsx', 'py', 'rb', 'go', 'java', 'cs', 'rs', 'swift', 'kt'].includes(ext);
    },
  },

  {
    id: 'logic',
    label: 'Logic & Correctness Checker',
    category: 'correctness',
    buildPrompt(config) {
      return `You are a specialist reviewer focused on LOGIC and CORRECTNESS bugs.

## What to Check
- Off-by-one errors in loops, slices, and array indexing
- Incorrect boolean logic (wrong operator, inverted condition)
- Race conditions in concurrent code
- Null/undefined dereferences
- Type coercion bugs (== vs ===, implicit conversions)
- Wrong comparison operators (< vs <=)
- Missing break in switch/case
- Incorrect regex patterns
- Wrong variable used (copy-paste errors)

## Investigation Process
1. Carefully analyze the logic in changed lines.
2. Use read_file_section to understand the full context of functions being modified.
3. Use check_symbol_usage to verify assumptions about how code is called.

## Rules
- Focus on the actual logic, not style or naming.
- Severity: "blocker" for guaranteed runtime errors, "high" for likely bugs, "medium" for edge cases.
- Maximum ${config.maxFindings} findings.

## Output Format
Respond with ONLY a JSON array (same schema, category "correctness").
If there are no findings, respond with: []`;
    },
    isRelevant(file) {
      if (file.isDeleted || file.isBinary) { return false; }
      const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
      return ['ts', 'js', 'tsx', 'jsx', 'py', 'rb', 'go', 'java', 'cs', 'rs', 'swift', 'kt'].includes(ext);
    },
  },

  {
    id: 'api-contract',
    label: 'API Contract Verifier',
    category: 'correctness',
    buildPrompt(config) {
      return `You are a specialist reviewer focused on API CONTRACT integrity.

## What to Check
- Function signature changes: are ALL callers updated to match?
- Interface/type changes: do all implementations satisfy the new contract?
- Renamed exports: are all importers updated?
- Changed return types: do callers handle the new return type?
- Added required parameters: are all call sites providing them?
- Changed error types/codes: are error handlers updated?

## Investigation Process
1. Identify any changed function signatures, interfaces, or types in the diff.
2. Use check_symbol_usage to find all callers/implementors.
3. Use read_file_section to verify each caller matches the new contract.
4. Use search_codebase to find any imports of renamed/removed exports.

## Rules
- Only report when you've verified callers are actually broken (not just changed).
- Severity: "blocker" for guaranteed type/runtime errors, "high" for likely breakage.
- Maximum ${config.maxFindings} findings.

## Output Format
Respond with ONLY a JSON array (same schema, category "correctness").
If there are no findings, respond with: []`;
    },
    isRelevant(file) {
      if (file.isDeleted || file.isBinary) { return false; }
      // Check if the diff modifies function signatures, types, or interfaces
      return file.hunks.some(h =>
        /(?:function|def|class|interface|type|export|import|public|private|protected)\b/.test(h.content)
      );
    },
  },

  {
    id: 'performance',
    label: 'Performance Reviewer',
    category: 'performance',
    buildPrompt(config) {
      return `You are a specialist reviewer focused on PERFORMANCE issues.

## What to Check
- N+1 query patterns (database queries inside loops)
- O(n²) or worse algorithms in hot paths
- Unnecessary allocations inside loops (creating objects/arrays repeatedly)
- Missing indexes for database queries
- Synchronous I/O blocking event loops
- Unbounded data fetching (SELECT * without LIMIT, fetching all records)
- Memory leaks (event listeners not removed, growing caches without eviction)
- Redundant computation (same expensive operation repeated)

## Investigation Process
1. Scan changed code for loops, queries, and I/O operations.
2. Use read_file_section to check the full loop body and surrounding context.
3. Use search_codebase to find if the code is called in a hot path.

## Rules
- Only report performance issues in NEW or CHANGED code.
- Be practical: don't report micro-optimizations. Focus on issues with measurable impact.
- Severity: "high" for O(n²) in hot paths or N+1 queries, "medium" for unnecessary allocations, "low" for potential improvements.
- Maximum ${config.maxFindings} findings.

## Output Format
Respond with ONLY a JSON array (same schema, category "performance").
If there are no findings, respond with: []`;
    },
    isRelevant(file) {
      if (file.isDeleted || file.isBinary) { return false; }
      const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
      return ['ts', 'js', 'tsx', 'jsx', 'py', 'rb', 'go', 'java', 'cs', 'rs', 'swift', 'kt', 'sql'].includes(ext);
    },
  },
];

export interface ActiveSubagent {
  agent: SubagentDefinition;
  relevantFiles: DiffFile[];
}

/**
 * Get subagents to run based on config and the diff files.
 * Filters by enabled list and file relevance.
 * Returns each agent paired with its pre-filtered relevant files.
 */
export function getActiveSubagents(
  config: CopilotReviewAgentConfig,
  files: DiffFile[]
): ActiveSubagent[] {
  let agents = SUBAGENTS;

  // Filter by enabled list if specified
  if (config.enabledSubagents.length > 0) {
    agents = agents.filter(a => config.enabledSubagents.includes(a.id));
  }

  // Filter by category settings
  const enabledCategories = new Set(config.categories);
  agents = agents.filter(a => enabledCategories.has(a.category));

  // Compute relevant files once per agent and keep only agents with at least one
  return agents
    .map(agent => ({ agent, relevantFiles: files.filter(f => agent.isRelevant(f)) }))
    .filter(entry => entry.relevantFiles.length > 0);
}
