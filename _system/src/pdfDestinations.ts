import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';

export type PdfDestinationFit = 'XYZ' | 'Fit' | 'FitB' | 'FitH' | 'FitBH' | 'FitV' | 'FitBV' | 'FitR';
export interface PdfDestinationLocation {
  /** One-based page. Coordinates use the displayed, rotated/cropped viewport. */
  page: number; x: number; y: number; fit: PdfDestinationFit; zoom?: number;
  rect?: { x: number; y: number; width: number; height: number };
}
export interface PdfLinkRectangle { left: number; top: number; width: number; height: number }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const unit = (value: number) => Math.max(0, Math.min(1, value));

/** Never use unsafeUrl directly: PDF actions may contain javascript:, file:, or launch commands. */
export function safePdfLinkUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return;
    if (url.protocol !== 'mailto:' && !url.hostname) return;
    if (url.protocol === 'mailto:' && !url.pathname) return;
    return url.href;
  } catch { return; }
}

export function pdfLinkRectangle(rect: unknown, viewport: Pick<PageViewport, 'width' | 'height' | 'convertToViewportRectangle'>): PdfLinkRectangle | undefined {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(finite) || !(viewport.width > 0 && viewport.height > 0)) return;
  const result = viewport.convertToViewportRectangle(rect);
  if (!result.every(finite)) return;
  const left = Math.max(0, Math.min(result[0], result[2])), top = Math.max(0, Math.min(result[1], result[3]));
  const right = Math.min(viewport.width, Math.max(result[0], result[2])), bottom = Math.min(viewport.height, Math.max(result[1], result[3]));
  if (right <= left || bottom <= top) return;
  return { left, top, width: right - left, height: bottom - top };
}

export function isPdfDestination(value: unknown): value is string | unknown[] {
  return typeof value === 'string' ? value.length > 0 && value.length <= 8192 : Array.isArray(value) && value.length >= 2;
}

/** Resolve PDF named/explicit destinations without requiring a page canvas to have rendered. */
export async function resolvePdfDestination(pdf: Pick<PDFDocumentProxy, 'numPages' | 'getDestination' | 'getPageIndex' | 'getPage'>, destination: unknown): Promise<PdfDestinationLocation> {
  let explicit: unknown = destination;
  if (typeof destination === 'string') explicit = await pdf.getDestination(destination);
  if (!Array.isArray(explicit) || explicit.length < 2) throw Error('PDF 中找不到该引用的跳转目标。');
  const reference = explicit[0]; let index: number;
  if (Number.isInteger(reference) && reference >= 0) index = reference;
  else if (reference && typeof reference === 'object' && Number.isInteger(reference.num) && reference.num > 0 && Number.isInteger(reference.gen) && reference.gen >= 0) index = await pdf.getPageIndex(reference);
  else throw Error('PDF 引用目标的页码无效。');
  if (!Number.isInteger(index) || index < 0 || index >= pdf.numPages) throw Error('PDF 引用目标超出文档页数。');
  const fit = explicit[1]?.name as PdfDestinationFit;
  if (!['XYZ','Fit','FitB','FitH','FitBH','FitV','FitBV','FitR'].includes(fit)) throw Error('PDF 引用使用了不支持的目标定位格式。');
  const target: PDFPageProxy = await pdf.getPage(index + 1), viewport = target.getViewport({ scale: 1 });
  const [left, bottom, right, top] = target.view;
  let x = left, y = top, zoom: number | undefined, rect: PdfDestinationLocation['rect'];
  const coordinate = (value: unknown, fallback: number) => { if (value === null || value === undefined) return fallback; if (!finite(value)) throw Error('PDF 引用目标坐标无效。'); return value; };
  if (fit === 'XYZ') {
    x = coordinate(explicit[2], left); y = coordinate(explicit[3], top);
    if (explicit[4] !== null && explicit[4] !== undefined && explicit[4] !== 0) { if (!finite(explicit[4]) || explicit[4] < 0) throw Error('PDF 引用目标缩放无效。'); zoom = explicit[4]; }
  } else if (fit === 'FitH' || fit === 'FitBH') y = coordinate(explicit[2], top);
  else if (fit === 'FitV' || fit === 'FitBV') x = coordinate(explicit[2], left);
  else if (fit === 'FitR') {
    const bounds = explicit.slice(2, 6);
    if (bounds.length !== 4 || !bounds.every(finite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw Error('PDF 引用目标区域无效。');
    const region = pdfLinkRectangle(bounds, viewport);
    if (!region) throw Error('PDF 引用目标区域超出页面。');
    rect = { x: region.left / viewport.width, y: region.top / viewport.height, width: region.width / viewport.width, height: region.height / viewport.height };
    return { page: index + 1, x: rect.x, y: rect.y, fit, rect };
  }
  // Full-page destinations always start at the displayed page's top-left, including rotated pages.
  if (fit === 'Fit' || fit === 'FitB') return { page: index + 1, x: 0, y: 0, fit };
  const point = viewport.convertToViewportPoint(x, y);
  // A horizontal/vertical fit describes a line, rather than one corner: use its displayed start.
  if (fit === 'FitH' || fit === 'FitBH') { const end = viewport.convertToViewportPoint(right, y); point[0] = Math.min(point[0], end[0]); point[1] = Math.min(point[1], end[1]); }
  if (fit === 'FitV' || fit === 'FitBV') { const end = viewport.convertToViewportPoint(x, bottom); point[0] = Math.min(point[0], end[0]); point[1] = Math.min(point[1], end[1]); }
  return { page: index + 1, x: unit(point[0] / viewport.width), y: unit(point[1] / viewport.height), fit, ...(zoom ? { zoom } : {}) };
}
