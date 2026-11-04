import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';
import { isPdfDestination, pdfLinkRectangle, resolvePdfDestination, safePdfLinkUrl, type PdfDestinationLocation } from '../pdfDestinations';
import '../pdf-links.css';

type LinkData = { id?: string; subtype?: string; annotationType?: number; rect?: number[]; dest?: unknown; goTo?: unknown; url?: string; unsafeUrl?: string; title?: string };
export interface PdfLinksProps {
  pdf: PDFDocumentProxy; page: PDFPageProxy; viewport: PageViewport;
  onNavigateDestination: (location: PdfDestinationLocation) => void | Promise<void>;
  onError?: (message: string) => void;
}
export default function PdfLinks({ pdf, page, viewport, onNavigateDestination, onError }: PdfLinksProps) {
  const [annotations, setAnnotations] = useState<LinkData[]>([]), [error, setError] = useState('');
  const active = useRef(true), navigation = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; navigation.current++; }; }, []);
  useEffect(() => {
    let current = true; setAnnotations([]); setError(''); navigation.current++;
    void page.getAnnotations({ intent: 'display' }).then(data => { if (current) setAnnotations(data.filter(a => a.subtype === 'Link' || a.annotationType === 2)); }).catch(cause => { if (current) { const message = `PDF 链接读取失败：${cause.message || cause}`; setError(message); onError?.(message); } });
    return () => { current = false; navigation.current++; };
  }, [page]);
  const links = useMemo(() => annotations.flatMap((annotation, i) => {
    const rectangle = pdfLinkRectangle(annotation.rect, viewport); if (!rectangle) return [];
    const destination = annotation.dest ?? annotation.goTo;
    const url = safePdfLinkUrl(annotation.url) || safePdfLinkUrl(annotation.unsafeUrl);
    if (!isPdfDestination(destination) && !url) return [];
    return [{ id: annotation.id || `pdf-link-${i}`, rectangle, destination, url, title: annotation.title }];
  }), [annotations, viewport]);
  async function navigate(destination: unknown) {
    const token = ++navigation.current; setError('');
    try { const location = await resolvePdfDestination(pdf, destination); if (active.current && token === navigation.current) await onNavigateDestination(location); }
    catch (cause) { if (active.current && token === navigation.current) { const message = (cause as Error).message || 'PDF 引用跳转失败。'; setError(message); onError?.(message); } }
  }
  return <div className="pdf-link-layer" style={{ width: viewport.width, height: viewport.height }}>
    {links.map(link => isPdfDestination(link.destination) ? <button type="button" className="pdf-document-link" key={link.id} style={link.rectangle} title={link.title || '跳转到引用位置'} aria-label={link.title || '跳转到 PDF 引用位置'} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => { event.preventDefault(); event.stopPropagation(); void navigate(link.destination); }}/>
      : <a className="pdf-document-link" key={link.id} style={link.rectangle} href={link.url} target="_blank" rel="noopener noreferrer" title={link.url} aria-label={`打开外部链接：${link.url}`} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}/>)}
    {error && <div className="pdf-link-error" role="status"><span>{error}</span><button type="button" onClick={event => { event.stopPropagation(); setError(''); }} aria-label="关闭 PDF 链接提示">×</button></div>}
  </div>;
}
