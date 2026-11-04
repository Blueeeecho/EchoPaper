export interface PdfMarkerRect { x: number; y: number; width: number; height: number }
const unit = (value: number) => Math.max(0, Math.min(1, value));
export function clipPdfMarker(rect: PdfMarkerRect): PdfMarkerRect | undefined {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return;
  const x = unit(rect.x), y = unit(rect.y), right = unit(rect.x + rect.width), bottom = unit(rect.y + rect.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}
/** PDF destinations are points, not text rectangles. Find the nearby rendered line without bridging column gutters. */
export function pdfDestinationMarker(point: { x: number; y: number }, textRects: readonly PdfMarkerRect[]): PdfMarkerRect {
  const x = unit(point.x), y = unit(point.y);
  const rects = textRects.map(clipPdfMarker).filter((rect): rect is PdfMarkerRect => !!rect);
  const distanceX = (r: PdfMarkerRect) => Math.max(r.x - x, x - r.x - r.width, 0);
  const distanceY = (r: PdfMarkerRect) => Math.max(r.y - y, y - r.y - r.height, 0);
  const candidates = rects.filter(r => distanceY(r) <= Math.max(.018, r.height) && (distanceX(r) <= .08 || x <= .02));
  // Anchors normally precede a line's top. Using distance to the whole box can
  // incorrectly select the preceding heading whose bottom touches the anchor.
  candidates.sort((a, b) => Math.abs(a.y - y) * 4 + distanceX(a) - Math.abs(b.y - y) * 4 - distanceX(b));
  const seed = candidates[0];
  // Images and blank destinations have no trustworthy text bounds: use a small location marker.
  if (!seed) return { x: Math.min(x, .984), y: Math.min(y, .986), width: .016, height: .014 };
  const row = rects.filter(r => Math.abs(r.y + r.height / 2 - seed.y - seed.height / 2) <= Math.min(r.height, seed.height) * .55).sort((a, b) => a.x - b.x);
  let left = seed.x, right = seed.x + seed.width, top = seed.y, bottom = seed.y + seed.height;
  // Text layers may split a reference label, authors and formatting into separate spans.
  for (let changed = true; changed;) {
    changed = false;
    for (const r of row) {
      if (r.x > right + .018 || r.x + r.width < left - .018) continue;
      const nextLeft = Math.min(left, r.x), nextRight = Math.max(right, r.x + r.width);
      if (nextLeft < left || nextRight > right) changed = true;
      left = nextLeft; right = nextRight; top = Math.min(top, r.y); bottom = Math.max(bottom, r.y + r.height);
    }
  }
  return clipPdfMarker({ x: left - .003, y: top - .002, width: right - left + .006, height: bottom - top + .004 })!;
}
