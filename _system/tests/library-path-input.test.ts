import assert from 'node:assert/strict';
import test from 'node:test';
import {libraryPathInput} from '../src/academic/libraryPathInput.ts';
import {relativePath} from '../server/security.ts';

test('Windows library forms accept paths copied from Explorer', () => {
  for (const root of [String.raw`D:\研究 文献`, String.raw`\\files\papers`]) {
    assert.equal(libraryPathInput(`"${root}"`, true, true), root);
    assert.throws(() => relativePath(libraryPathInput(root, false, true)));
  }
  assert.equal(libraryPathInput(String.raw`阅读\论文.pdf`, false, true), '阅读/论文.pdf');
  assert.throws(() => relativePath(libraryPathInput(String.raw`..\论文.pdf`, false, true)));
  assert.equal(libraryPathInput('/data/"notes"', true, false), '/data/"notes"');
});
