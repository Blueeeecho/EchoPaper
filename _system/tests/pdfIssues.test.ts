import test from 'node:test';
import assert from 'node:assert/strict';
import type { Diagnostic } from '../shared/types.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PdfIssueSummary from '../src/components/PdfIssueSummary.tsx';
import { findUnresolvedPdfTokens, diagnosticPdfPage, diagnosticSourceLocation, unresolvedPdfKinds, measureUnresolvedPdfTokens } from '../src/pdfIssues.ts';

const warning = (message: string, extra: Partial<Diagnostic> = {}): Diagnostic => ({ severity: 'warning', category: 'reference', message, ...extra });
test('only valid pages from the displayed PDF build can navigate', () => {
  assert.equal(diagnosticPdfPage(warning('undefined', {page:3}), 'a', 'a', 5), 3);
  for (const page of [0, -1, 1.5, NaN, Infinity, 6, undefined]) assert.equal(diagnosticPdfPage(warning('undefined', {page}), 'a', 'a', 5), undefined);
  assert.equal(diagnosticPdfPage(warning('undefined', {page:3}), 'a', 'b', 5), undefined);
  assert.equal(diagnosticPdfPage(warning('undefined', {page:3}), undefined, undefined, 5), undefined);
});
test('unresolved detection is gated by diagnostics for the displayed PDF page', () => {
  assert.deepEqual(unresolvedPdfKinds([], 1), { reference:false, citation:false });
  assert.deepEqual(unresolvedPdfKinds([warning("Reference `fig:missing' on page 2 undefined", {page:2})], 1), { reference:false, citation:false });
  assert.deepEqual(unresolvedPdfKinds([warning("Reference `fig:missing' on page 2 undefined", {page:2})], 2), { reference:true, citation:false });
  assert.deepEqual(unresolvedPdfKinds([warning("Citation `missing' undefined")], 2), { reference:false, citation:true });
  assert.deepEqual(unresolvedPdfKinds([warning('There were undefined references.')], 1), { reference:true, citation:true });
});
test('double-question glyphs are marked while ordinary question punctuation and placeholders are preserved', () => {
  const text = 'What is a good paper? Figure ?? and Table ⁇. Citation [?]. TODO ???';
  const ranges=findUnresolvedPdfTokens(text, {reference:true,citation:true});
  assert.deepEqual(ranges.map(range=>text.slice(range.start,range.end)), ['??','⁇','[?]']);
  assert.deepEqual(findUnresolvedPdfTokens(text, {reference:false,citation:false}), []);
  assert.deepEqual(findUnresolvedPdfTokens(text, {reference:false,citation:true}).map(range=>text.slice(range.start,range.end)), ['[?]']);
});
test('range measurements handle question marks split across PDF spans without replacing text nodes', () => {
  const nodes = [{textContent:'Figure ?'}, {textContent:'?; title?'}, {textContent:' end'}];
  const calls: unknown[][] = [];
  let cursor = 0;
  const layer = {
    ownerDocument: {
      createTreeWalker: () => ({nextNode: () => nodes[cursor++] || null}),
      createRange: () => ({setStart: (...args: unknown[]) => calls.push(['start', ...args]), setEnd: (...args: unknown[]) => calls.push(['end', ...args]), getClientRects: () => [{left:50,top:75,width:12,height:10}]}),
    },
    getBoundingClientRect: () => ({left:10,top:20}),
  } as unknown as HTMLElement;
  assert.deepEqual(measureUnresolvedPdfTokens(layer, {reference:true,citation:false}), [{left:40,top:55,width:12,height:10}]);
  assert.deepEqual(calls, [['start',nodes[0],7],['end',nodes[1],1]]);
  assert.deepEqual(nodes.map(node=>node.textContent), ['Figure ?','?; title?',' end']);
});
test('PDF header preserves reference and placeholder categories with source navigation only', () => {
  const diagnostics = [warning("Reference `a' on page 1 undefined", {page:1}), warning('There were undefined references.'), warning('TODO', {category:'placeholder',severity:'info'})];
  const html = renderToStaticMarkup(createElement(PdfIssueSummary, {build:{id:'pdf-build',projectId:'p',targetId:'t',status:'succeeded',createdAt:'2026-10-22T08:00:00Z',log:'',diagnostics},displayedBuildId:'pdf-build',onNavigateSource:()=>{}}));
  assert.match(html, /pdf-issue-count reference[^]*?引用问题[^]*?<b>1<\/b>/);
  assert.ok(html.includes('pdf-issue-count placeholder'));
  assert.ok(!html.includes('pdf-issue-count error') && !html.includes('role="alert"') && !html.includes('pdf-issue-popover'));
});


test('issue navigation uses only the recorded source, never its PDF page',()=>{
 assert.deepEqual(diagnosticSourceLocation(warning('undefined',{file:'manuscript/tex/body.tex',line:7,page:4})),{path:'manuscript/tex/body.tex',line:7});
 assert.deepEqual(diagnosticSourceLocation(warning('undefined',{file:'manuscript/main.tex',page:6})),{path:'manuscript/main.tex'});
 for(const file of [undefined,'../main.tex','/private/main.tex','C:/main.tex','manuscript/../main.tex'])assert.equal(diagnosticSourceLocation(warning('undefined',{file,page:4,line:7})),undefined);
});
