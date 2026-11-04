export interface PdfSelectionRect { x: number; y: number; width: number; height: number }
export interface PdfTextSelection { page: number; quote: string; rects: PdfSelectionRect[]; startOffset: number; endOffset: number }
export interface ClientRectLike { left: number; top: number; width: number; height: number }

const finiteRect = (rect: ClientRectLike) => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite);

/** Clip viewport-pixel rectangles to one page, then convert to page-relative coordinates. */
export function normalizeRects(rects: readonly ClientRectLike[], bounds: ClientRectLike): PdfSelectionRect[] {
  if (!finiteRect(bounds) || bounds.width <= 0 || bounds.height <= 0) return [];
  const result: PdfSelectionRect[] = [];
  for (const rect of rects) {
    if (!finiteRect(rect) || rect.width <= 0 || rect.height <= 0) continue;
    const left = Math.max(bounds.left, rect.left);
    const top = Math.max(bounds.top, rect.top);
    const right = Math.min(bounds.left + bounds.width, rect.left + rect.width);
    const bottom = Math.min(bounds.top + bounds.height, rect.top + rect.height);
    // Browser ranges can include zero-width line breaks or subpixel slivers.
    if (right - left < .5 || bottom - top < .5) continue;
    const x = (left - bounds.left) / bounds.width;
    const y = (top - bounds.top) / bounds.height;
    result.push({ x, y, width: Math.min((right - left) / bounds.width, 1 - x), height: Math.min((bottom - top) / bounds.height, 1 - y) });
  }
  return result;
}

/** Deduplicate range/span rectangles and join touching fragments on the same line. */
export function mergeSelectionRects(rects: readonly PdfSelectionRect[]): PdfSelectionRect[] {
  const valid = rects.filter(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= 1 + 1e-9 && rect.y + rect.height <= 1 + 1e-9)
    .map(rect => ({ ...rect })).sort((a, b) => a.y - b.y || a.x - b.x);
  const result: PdfSelectionRect[] = [];
  for (const rect of valid) {
    const sameLine = result.findIndex(previous => {
      const overlap = Math.min(previous.y + previous.height, rect.y + rect.height) - Math.max(previous.y, rect.y);
      const centers = Math.abs(previous.y + previous.height / 2 - rect.y - rect.height / 2);
      return overlap >= Math.min(previous.height, rect.height) * .8
        && centers <= Math.max(previous.height, rect.height) * .25
        && rect.x <= previous.x + previous.width + .002
        && previous.x <= rect.x + rect.width + .002;
    });
    if (sameLine < 0) { result.push(rect); continue; }
    const previous = result[sameLine];
    const left = Math.min(previous.x, rect.x);
    const top = Math.min(previous.y, rect.y);
    result[sameLine] = {
      x: left, y: top,
      width: Math.min(1, Math.max(previous.x + previous.width, rect.x + rect.width)) - left,
      height: Math.min(1, Math.max(previous.y + previous.height, rect.y + rect.height)) - top,
    };
  }
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

function textLayerFor(node: Node | null): Element | null {
  return (node?.nodeType === 1 ? node as Element : node?.parentElement)?.closest('.textLayer') ?? null;
}

/** Capture only PDF.js text on one page; editor/sidebar and cross-page selections are rejected. */
export function capturePdfSelection(root: HTMLElement, selection: Selection | null): PdfTextSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const layer = textLayerFor(range.startContainer);
  if (!layer || layer !== textLayerFor(range.endContainer) || !root.contains(layer)) return null;
  const sheet = layer.closest('.pdf-sheet');
  const pageElement = sheet?.closest<HTMLElement>('[data-page]');
  if (!sheet || !pageElement || !root.contains(sheet)) return null;
  const page = Number(pageElement.dataset.page);
  if (!Number.isSafeInteger(page) || page < 1) return null;
  const quote = range.toString().trim();
  if (!quote || quote.length > 10000) return null;
  const prefix = layer.ownerDocument.createRange();
  prefix.selectNodeContents(layer);
  prefix.setEnd(range.startContainer, range.startOffset);
  const startOffset = prefix.toString().length;
  prefix.setEnd(range.endContainer, range.endOffset);
  const endOffset = prefix.toString().length;
  if (endOffset <= startOffset) return null;
  const clientRects = Array.from(range.getClientRects());
  if (clientRects.length > 5000) return null;
  // Canvas bounds exclude the sheet border and match PDF.js's text-layer viewport.
  const bounds = (sheet.querySelector('canvas') ?? layer).getBoundingClientRect();
  const rects = mergeSelectionRects(normalizeRects(clientRects, bounds));
  if (!rects.length || rects.length > 200) return null;
  return { page, quote, rects, startOffset, endOffset };
}
