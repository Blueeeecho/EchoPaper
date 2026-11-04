import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedText, quoteMatches } from '../src/annotationMigration.ts';

test('quote matching tolerates PDF wrapping, ligatures and punctuation while preserving source offsets', () => {
  const text = 'Before. A re-\npair uses ﬁne feedback. After.';
  const result = quoteMatches(text, 'A repair uses fine feedback.');
  assert.equal(result.length, 1); assert.equal(result[0].match, 'normalized');
  assert.equal(text.slice(result[0].start, result[0].end), 'A re-\npair uses ﬁne feedback.');
  assert.equal(normalizedText('中 文\nABC').text, '中文abc');
});
test('ambiguous repeated quotations remain separate candidates and changed passages are labelled partial', () => {
  assert.equal(quoteMatches('same words. same words.', 'same words.').length, 2);
  const prefix = 'This is a sufficiently long quotation before '; const quote = prefix + 'the expected ending was completely rewritten.';
  const result = quoteMatches(prefix + 'a revised and different ending for the paper.', quote);
  assert.equal(result[0].match, 'partial');
  assert.deepEqual(quoteMatches('abc', ''), []);
});
test('UTF-16 offsets remain correct around emoji and mathematical Unicode',()=>{
  const value='前言 😀 𝑥 is useful. 后文';const match=quoteMatches(value,'😀 x is useful.')[0];assert.equal(value.slice(match.start,match.end),'😀 𝑥 is useful.');
});
