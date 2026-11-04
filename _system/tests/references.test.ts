import test from 'node:test';import assert from 'node:assert/strict';
import {parseBibTeX}from'../server/references.ts';
test('BibTeX index handles nested titles, quotes, parentheses and skips comments/macros',()=>{
 const parsed=parseBibTeX('@string{abbr="ACM"}\n@article{one, title={A {Nested} Title}, author="A and B", year=2025, doi={10/test}}\n@book(two,title="Quoted title",year={2026})','manuscript/refs.bib');
 assert.equal(parsed.entries.length,2);assert.equal(parsed.entries[0].title,'A Nested Title');assert.equal(parsed.entries[0].line,2);assert.equal(parsed.entries[1].key,'two');assert.equal(parsed.entries[0].doi,'10/test');
});
test('malformed bibliography is reported rather than inventing fields',()=>{const r=parseBibTeX('@article{x,title={unfinished}','r.bib');assert.equal(r.entries.length,0);assert.equal(r.warnings.length,1);});
