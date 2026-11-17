import test from 'node:test';
import assert from 'node:assert/strict';
import { paperPresentations } from '../src/academic/paperPresentationEntry';
import type { PresentationSummary } from '../shared/presentation-types';
const decks = [{id:'a',paperId:'WWW'}, {id:'b',paperId:'other'}, {id:'c',paperId:'WWW'}, {id:'d'}] as PresentationSummary[];
test('paper entry offers all and only its own decks when switching paper', () => {
 assert.deepEqual(paperPresentations(decks, 'WWW').map(d => d.id), ['a','c']);
 assert.deepEqual(paperPresentations(decks, 'other').map(d => d.id), ['b']);
});
test('invalid paper has no unrelated continuation; generic entry retains every deck', () => {
 assert.deepEqual(paperPresentations(decks, 'missing'), []);
 assert.equal(paperPresentations(decks), decks);
 assert.equal(decks.length, 4);
});
