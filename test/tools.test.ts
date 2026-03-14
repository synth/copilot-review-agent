import assert from 'node:assert/strict';
import * as mocha from 'mocha';
import { toGitGlobPathspec } from '../src/gitGlob';

describe('toGitGlobPathspec', () => {
  it('wraps recursive globs with git glob magic', () => {
    assert.equal(toGitGlobPathspec('src/**/*.ts'), ':(glob)src/**/*.ts');
  });

  it('normalizes leading ./ prefixes', () => {
    assert.equal(toGitGlobPathspec('./src/**/*.ts'), ':(glob)src/**/*.ts');
  });

  it('normalizes Windows separators before passing to git', () => {
    assert.equal(toGitGlobPathspec('src\\**\\*.ts'), ':(glob)src/**/*.ts');
  });
});