import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfAnnotationRect } from '../shared/types';
export interface MigrationCandidate { page: number; quote: string; rects: PdfAnnotationRect[]; startOffset: number; endOffset: number; match: 'normalized' | 'partial'; context: string }
export function normalizedText(value: string): { text: string; starts: number[]; ends: number[] } {
  let text = '', offset = 0; const starts: number[] = [], ends: number[] = [];
  for (const character of value) {
    const normalized = character.normalize('NFKC').replace(/[\s\u00ad\-‐‑–—]/g, '').toLocaleLowerCase();
    for (let i = 0; i < normalized.length; i++) { text += normalized[i]; starts.push(offset); ends.push(offset + character.length); }
    offset += character.length;
  }
  return { text, starts, ends };
}
export function quoteMatches(value: string, quote: string): { start: number; end: number; match: 'normalized' | 'partial' }[] {
  const source = normalizedText(value), wanted = normalizedText(quote).text;
  if (!wanted) return [];
  const result: { start: number; end: number; match: 'normalized' | 'partial' }[] = [];
  let from = 0;
  while (result.length < 40) {
    const index = source.text.indexOf(wanted, from); if (index < 0) break;
    result.push({ start: source.starts[index], end: source.ends[index + wanted.length - 1], match: 'normalized' });
    from = index + Math.max(1, wanted.length);
  }
  if (!result.length && wanted.length >= 32) {
    const seed = wanted.slice(0, Math.min(32, Math.floor(wanted.length / 3)));
    from = 0;
    while (result.length < 10) {
      const index = source.text.indexOf(seed, from); if (index < 0) break;
      const last = Math.min(source.text.length - 1, index + wanted.length - 1);
      result.push({ start: source.starts[index], end: source.ends[last], match: 'partial' }); from = index + seed.length;
    }
  }
  return result;
}
export async function findMigrationCandidates(pdf: PDFDocumentProxy, quote: string): Promise<{ candidates: MigrationCandidate[]; limited: boolean }> {
  if (!quote.trim()) return { candidates: [], limited: false };
  const candidates: MigrationCandidate[] = [];
  const maxPages = Math.min(300, pdf.numPages);
  for (let pageNumber = 1; pageNumber <= maxPages && candidates.length < 40; pageNumber++) {
    const page = await pdf.getPage(pageNumber), content = await page.getTextContent(), viewport = page.getViewport({ scale: 1 });
    const items = content.items.filter((item): item is Extract<typeof item, {str: string}> => 'str' in item);
    const full = items.map(item => item.str).join('');
    if (full.length > 1000000) continue;
    for (const match of quoteMatches(full, quote)) {
      const rects: PdfAnnotationRect[] = []; let offset = 0;
      for (const item of items) {
        const start = offset, end = start + item.str.length; offset = end;
        const intersectionStart = Math.max(start, match.start), intersectionEnd = Math.min(end, match.end);
        if (intersectionStart >= intersectionEnd || !item.str.length) continue;
        const ascent = content.styles[item.fontName]?.ascent ?? .8;
        const tx = item.transform, m = viewport.transform;
        const transform = [m[0]*tx[0]+m[2]*tx[1], m[1]*tx[0]+m[3]*tx[1], m[0]*tx[2]+m[2]*tx[3], m[1]*tx[2]+m[3]*tx[3], m[0]*tx[4]+m[2]*tx[5]+m[4], m[1]*tx[4]+m[3]*tx[5]+m[5]];
        const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]));
        const fraction = (intersectionStart - start) / item.str.length, length = (intersectionEnd - intersectionStart) / item.str.length;
        const left = transform[4] + item.width * viewport.scale * fraction;
        const top = transform[5] - fontHeight * ascent;
        const x = Math.max(0, Math.min(.999, left / viewport.width)), y = Math.max(0, Math.min(.999, top / viewport.height));
        rects.push({ x, y, width: Math.max(.0001, Math.min(1 - x, item.width * viewport.scale * length / viewport.width)), height: Math.max(.0001, Math.min(1 - y, fontHeight / viewport.height)) });
      }
      if (!rects.length || rects.length > 200) continue;
      candidates.push({ page: pageNumber, quote: full.slice(match.start, match.end), startOffset: match.start, endOffset: match.end, rects, match: match.match, context: full.slice(Math.max(0, match.start - 35), Math.min(full.length, match.end + 50)) });
      if (candidates.length >= 40) break;
    }
  }
  return { candidates, limited: pdf.numPages > maxPages || candidates.length >= 40 };
}
