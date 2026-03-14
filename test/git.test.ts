import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import * as mocha from 'mocha';
import type * as vscode from 'vscode';
import { BranchSelection } from '../src/types';

let GitDiffEngine: typeof import('../src/git').GitDiffEngine;
const originalLoad = Module._load;

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createWorkspaceFolder(repoPath: string): vscode.WorkspaceFolder {
  return {
    uri: { fsPath: repoPath } as vscode.Uri,
    name: path.basename(repoPath),
    index: 0,
  } as vscode.WorkspaceFolder;
}

describe('GitDiffEngine.getDiff', () => {
  let repoPath: string;

  before(async () => {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'vscode') {
        return {};
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    ({ GitDiffEngine } = await import('../src/git'));
  });

  after(() => {
    Module._load = originalLoad;
  });

  beforeEach(async () => {
    repoPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'copilot-review-agent-git-'));
    runGit(repoPath, ['init', '--initial-branch=main']);
    runGit(repoPath, ['config', 'user.name', 'Copilot Review Agent']);
    runGit(repoPath, ['config', 'user.email', 'copilot-review-agent@example.com']);

    await fs.promises.writeFile(path.join(repoPath, 'included.txt'), 'base included\n', 'utf-8');
    await fs.promises.writeFile(path.join(repoPath, 'excluded.txt'), 'base excluded\n', 'utf-8');

    runGit(repoPath, ['add', 'included.txt', 'excluded.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    runGit(repoPath, ['checkout', '-b', 'feature']);
  });

  afterEach(async () => {
    await fs.promises.rm(repoPath, { recursive: true, force: true });
  });

  it('returns a filtered working-tree diff without relying on stdout buffering', async () => {
    const largeBlock = `${'x'.repeat(2048)}\n`.repeat(512);
    await fs.promises.writeFile(path.join(repoPath, 'included.txt'), `updated included\n${largeBlock}`, 'utf-8');
    await fs.promises.writeFile(path.join(repoPath, 'excluded.txt'), 'updated excluded\n', 'utf-8');

    const engine = new GitDiffEngine(createWorkspaceFolder(repoPath));
    const selection: BranchSelection = {
      baseBranch: 'main',
      targetBranch: '',
      includeUncommitted: true,
    };

    const diff = await engine.getDiff(selection, ['included.txt']);

    assert.match(diff, /diff --git a\/included\.txt b\/included\.txt/);
    assert.doesNotMatch(diff, /excluded\.txt/);
    assert.match(diff, /\+updated included/);
  });
});