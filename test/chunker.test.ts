import assert from 'node:assert/strict';
import * as mocha from 'mocha';
import { buildFileContext } from '../src/chunker';
import { DiffFile, SelfReviewConfig } from '../src/types';

/**
 * Minimal SelfReviewConfig for tests — only `contextLines` and
 * `maxFilesPerChunk` are used by buildFileContext / chunkDiffFiles.
 */
const config: SelfReviewConfig = {
  baseBranch: 'main',
  targetBranch: '',
  includeUncommitted: false,
  severityThreshold: 'nit',
  excludePaths: [],
  maxFilesPerChunk: 10,
  contextLines: 0,
  categories: [],
  customInstructions: '',
  maxFindings: 20,
};

function makeHunk(newStart: number, newLines: number, addedLines: number[]): import('../src/types').DiffHunk {
  return {
    file: 'src/foo.ts',
    oldStart: newStart,
    oldLines: newLines,
    newStart,
    newLines,
    header: 'function foo()',
    content: '',
    addedLines,
    removedLines: [],
  };
}

describe('buildFileContext – addedLines annotation', () => {
  it('marks lines listed in addedLines (1-based) with + prefix', () => {
    // The file has three lines; lines 1 and 3 are new additions.
    const file: DiffFile = {
      path: 'src/foo.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      fullContent: 'const a = 1;\nconst b = 2;\nconst c = 3;',
      hunks: [makeHunk(1, 3, [1, 3])],
    };

    const result = buildFileContext(file, config);
    const lines = result.split('\n');

    // Extract the annotated code lines (those inside the ``` block).
    const codeLine = (lineNum: number) =>
      lines.find(l => l.includes(`${String(lineNum).padStart(5)} |`));

    const line1 = codeLine(1);
    const line2 = codeLine(2);
    const line3 = codeLine(3);

    assert.ok(line1, 'line 1 should appear in output');
    assert.ok(line2, 'line 2 should appear in output');
    assert.ok(line3, 'line 3 should appear in output');

    // Added lines must start with + (1-based line numbers match addedLines)
    assert.match(line1!, /^\+/, 'line 1 is in addedLines → should have + prefix');
    assert.match(line3!, /^\+/, 'line 3 is in addedLines → should have + prefix');

    // Unchanged line must start with a space
    assert.match(line2!, /^ /, 'line 2 is not in addedLines → should have space prefix');
  });

  it('marks no lines with + when addedLines is empty', () => {
    const file: DiffFile = {
      path: 'src/bar.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      fullContent: 'line one\nline two',
      hunks: [makeHunk(1, 2, [])],
    };

    const result = buildFileContext(file, config);
    const codeLines = result
      .split('\n')
      .filter(l => /^\s*\d+\s*\|/.test(l) || /^[+ ]/.test(l) && l.includes(' | '));

    // All annotated lines must have a space prefix (no additions).
    for (const l of codeLines) {
      assert.match(l, /^ /, `expected space prefix but got: ${l}`);
    }
  });

  it('correctly annotates a hunk offset from the start of the file', () => {
    // File has 5 lines; the hunk covers lines 3-4, only line 4 is new.
    const fullContent = 'a\nb\nc\nd\ne';
    const file: DiffFile = {
      path: 'src/baz.ts',
      isNew: false,
      isDeleted: false,
      isBinary: false,
      fullContent,
      hunks: [makeHunk(3, 2, [4])],
    };

    const result = buildFileContext(file, config);
    const lines = result.split('\n');

    const codeLine = (n: number) =>
      lines.find(l => l.includes(`${String(n).padStart(5)} |`));

    const line3 = codeLine(3);
    const line4 = codeLine(4);

    assert.ok(line3, 'line 3 should appear in output');
    assert.ok(line4, 'line 4 should appear in output');

    assert.match(line3!, /^ /, 'line 3 is not added → space prefix');
    assert.match(line4!, /^\+/, 'line 4 is in addedLines → + prefix');
  });
});
