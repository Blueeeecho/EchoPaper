export interface PdfEmphasisAnnotation { kind: string; startOffset?: number; endOffset?: number }

export interface EmphasisSegment { start: number; end: number; bold: boolean; italic: boolean }

/** Split one text node into disjoint segments, preserving overlapping emphasis kinds. */
export function emphasisSegments(nodeStart: number, nodeEnd: number, annotations: readonly PdfEmphasisAnnotation[]): EmphasisSegment[] {
  const matches = annotations.filter(annotation => ['bold', 'italic'].includes(annotation.kind)
    && Number.isSafeInteger(annotation.startOffset) && Number.isSafeInteger(annotation.endOffset)
    && annotation.startOffset! >= 0 && annotation.endOffset! > annotation.startOffset!
    && annotation.endOffset! > nodeStart && annotation.startOffset! < nodeEnd);
  const points = new Set([nodeStart, nodeEnd]);
  for (const match of matches) { points.add(Math.max(nodeStart, match.startOffset!)); points.add(Math.min(nodeEnd, match.endOffset!)); }
  const sorted = Array.from(points).sort((a, b) => a - b);
  return sorted.slice(0, -1).map((start, i) => {
    const end = sorted[i + 1];
    const active = matches.filter(match => match.startOffset! < end && match.endOffset! > start);
    return { start, end, bold: active.some(match => match.kind === 'bold'), italic: active.some(match => match.kind === 'italic') };
  });
}

/** PDF reading marks only: wrap selected glyph text without changing the source or canvas. */
export function applyPdfEmphasis(layer: HTMLElement, annotations: readonly PdfEmphasisAnnotation[]): void {
  for (const mark of layer.querySelectorAll('mark.pdf-emphasis')) mark.replaceWith(...Array.from(mark.childNodes));
  layer.normalize();
  const document = layer.ownerDocument;
  const walker = document.createTreeWalker(layer, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const total = nodes.reduce((length, node) => length + node.length, 0);
  const valid = annotations.filter(annotation => annotation.endOffset !== undefined && annotation.endOffset <= total);
  let offset = 0;
  for (const node of nodes) {
    const start = offset;
    offset += node.length;
    const segments = emphasisSegments(start, offset, valid);
    if (!segments.some(segment => segment.bold || segment.italic)) continue;
    const fragment = document.createDocumentFragment();
    for (const segment of segments) {
      const value = node.data.slice(segment.start - start, segment.end - start);
      if (!segment.bold && !segment.italic) { fragment.append(document.createTextNode(value)); continue; }
      const mark = document.createElement('mark');
      mark.className = `pdf-emphasis${segment.bold ? ' pdf-emphasis-bold' : ''}${segment.italic ? ' pdf-emphasis-italic' : ''}`;
      mark.textContent = value;
      fragment.append(mark);
    }
    node.replaceWith(fragment);
  }
}
