import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePdfSelection, mergeSelectionRects, normalizeRects } from '../src/pdfSelection.ts';
import { emphasisSegments } from '../src/pdfEmphasis.ts';

test('PDF selection rectangles are clipped to their page and normalized independently of viewport size', () => {
  const normalized = normalizeRects([
    { left: 80, top: 250, width: 80, height: 20 },
    { left: 590, top: 780, width: 40, height: 40 },
    { left: 0, top: 0, width: 20, height: 20 },
    { left: 300, top: 300, width: .1, height: 15 },
    { left: NaN, top: 300, width: 20, height: 15 },
  ], { left: 100, top: 200, width: 500, height: 600 });
  assert.deepEqual(normalized, [
    { x: 0, y: 50 / 600, width: 60 / 500, height: 20 / 600 },
    { x: .98, y: 580 / 600, width: .02, height: 1 - 580 / 600 },
  ]);
  assert.deepEqual(normalizeRects([], { left: 0, top: 0, width: 0, height: 100 }), []);
});

test('PDF line fragments and duplicate ranges merge without joining columns or successive lines', () => {
  const merged = mergeSelectionRects([
    { x: .1, y: .1, width: .1, height: .02 },
    { x: .1, y: .1, width: .1, height: .02 },
    { x: .201, y: .1005, width: .099, height: .02 },
    { x: .1, y: .13, width: .2, height: .02 },
    { x: .6, y: .1, width: .2, height: .02 },
  ]);
  assert.equal(merged.length, 3);
  assert.ok(Math.abs(merged[0].width - .2) < 1e-10);
  assert.equal(merged[1].x, .6);
  assert.equal(merged[2].y, .13);
  assert.deepEqual(mergeSelectionRects([{ x: -.1, y: .1, width: .2, height: .02 }]), []);
});

// Minimal DOM-shaped fixtures exercise selection boundaries without installing a browser runtime.
function selectionFixture({ quote = 'Selected text', page = '2', foreignEnd = false, outside = false, count = 1, collapsed = false, rectangles = 1 } = {}) {
  const sheet = { querySelector: () => ({ getBoundingClientRect: () => ({ left: 100, top: 200, width: 500, height: 600 }) }), closest: () => ({ dataset: { page } }) };
  const layer = { closest: () => sheet, ownerDocument: { createRange: () => {
    let end = 0;
    return { selectNodeContents() {}, setEnd(_node: unknown, offset: number) { end = offset; }, toString: () => 'x'.repeat(end) };
  } } };
  const startContainer = { nodeType: 3, parentElement: { closest: () => layer } };
  const endContainer = foreignEnd ? { nodeType: 3, parentElement: { closest: () => ({}) } } : startContainer;
  const root = { contains: () => !outside } as unknown as HTMLElement;
  const selection = { isCollapsed: collapsed, rangeCount: count, getRangeAt: () => ({
    startContainer, endContainer, startOffset: 3, endOffset: 3 + quote.length, toString: () => quote,
    getClientRects: () => Array.from({ length: rectangles }, (_, i) => ({ left: 110, top: 210 + i * .1, width: 100, height: 10 })),
  }) } as unknown as Selection;
  return { root, selection };
}

test('PDF capture rejects cross-page, foreign, collapsed, empty and excessive selections', () => {
  for (const options of [{ foreignEnd: true }, { outside: true }, { collapsed: true }, { count: 2 }, { quote: '  ' }, { quote: 'x'.repeat(10001) }, { page: 'NaN' }, { rectangles: 5001 }]) {
    const fixture = selectionFixture(options);
    assert.equal(capturePdfSelection(fixture.root, fixture.selection), null);
  }
  const fixture = selectionFixture();
  assert.deepEqual(capturePdfSelection(fixture.root, fixture.selection), {
    page: 2, quote: 'Selected text', rects: [{ x: .02, y: 10 / 600, width: .2, height: 10 / 600 }], startOffset: 3, endOffset: 16,
  });
});

test('overlapping PDF emphasis preserves separate bold and italic ranges across text nodes', () => {
  const annotations = [{ kind: 'bold', startOffset: 2, endOffset: 9 }, { kind: 'italic', startOffset: 6, endOffset: 12 }];
  assert.deepEqual(emphasisSegments(4, 10, annotations), [
    { start: 4, end: 6, bold: true, italic: false },
    { start: 6, end: 9, bold: true, italic: true },
    { start: 9, end: 10, bold: false, italic: true },
  ]);
  assert.deepEqual(emphasisSegments(12, 15, annotations), [{ start: 12, end: 15, bold: false, italic: false }]);
  assert.deepEqual(emphasisSegments(0, 4, [{ kind: 'bold', startOffset: -1, endOffset: 3 }, { kind: 'bold', startOffset: 1, endOffset: NaN }]), [{ start: 0, end: 4, bold: false, italic: false }]);
});
