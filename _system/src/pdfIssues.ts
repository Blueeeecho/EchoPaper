import type { Diagnostic } from '../shared/types';

export type PdfIssueBucket = 'error' | 'reference' | 'warning' | 'placeholder';

export function diagnosticPdfPage(diagnostic: Diagnostic, issuesBuildId: string | undefined, displayedBuildId: string | undefined, numPages: number) {
  if (!issuesBuildId || issuesBuildId !== displayedBuildId) return undefined;
  return Number.isInteger(diagnostic.page) && diagnostic.page! >= 1 && diagnostic.page! <= numPages ? diagnostic.page : undefined;
}

/** Never guess a PDF page when a diagnostic is selected; navigate to its source. */
export function diagnosticSourceLocation(diagnostic:Diagnostic):{path:string;line?:number}|undefined{
 const path=diagnostic.file;
 if(!path||/^(?:\/|[A-Za-z]:)/.test(path)||/[\\\u0000-\u001f]/.test(path)||path.split('/').some(part=>!part||part==='..'||part==='.'))return;
 return {path,...(Number.isInteger(diagnostic.line)&&diagnostic.line!>0?{line:diagnostic.line}:{})};
}

export interface UnresolvedPdfKinds { reference: boolean; citation: boolean }
export function unresolvedPdfKinds(diagnostics: Diagnostic[], page: number): UnresolvedPdfKinds {
  let reference = false, citation = false;
  for (const diagnostic of diagnostics) {
    if (diagnostic.category !== 'reference' || !/undefined|unresolved|未定义|未解析/i.test(diagnostic.message)) continue;
    if (diagnostic.page !== undefined && diagnostic.page !== page) continue;
    const isCitation = /citation|引文|文献/i.test(diagnostic.message);
    if (isCitation) citation = true;
    else {
      reference = true;
      // TeX's final aggregate covers both missing labels and missing citations.
      if (/there were undefined references/i.test(diagnostic.message)) citation = true;
    }
  }
  return { reference, citation };
}

export function findUnresolvedPdfTokens(text: string, kinds: UnresolvedPdfKinds): { start: number; end: number }[] {
  if (!kinds.reference && !kinds.citation) return [];
  const ranges: { start: number; end: number }[] = [];
  const pattern = /\?{2}|⁇|\[\?\]/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!, token = match[0];
    if (token === '[?]' ? !kinds.citation : !kinds.reference) continue;
    if (token === '??' && (text[start - 1] === '?' || text[start + 2] === '?')) continue;
    ranges.push({ start, end: start + token.length });
  }
  return ranges;
}

export interface PdfIssueRect { left: number; top: number; width: number; height: number }
/** Read the existing text layer without wrapping/replacing any selection nodes. */
export function measureUnresolvedPdfTokens(layer: HTMLElement, kinds: UnresolvedPdfKinds): PdfIssueRect[] {
  if (!kinds.reference && !kinds.citation) return [];
  const walker = layer.ownerDocument.createTreeWalker(layer, 4 /* SHOW_TEXT */);
  const nodes: { node: Text; start: number; end: number }[] = [];
  let contents = '', node: Node | null;
  while ((node = walker.nextNode())) {
    const value = node.textContent || '';
    nodes.push({ node: node as Text, start: contents.length, end: contents.length + value.length });
    contents += value;
  }
  const origin = layer.getBoundingClientRect(), rects: PdfIssueRect[] = [];
  for (const token of findUnresolvedPdfTokens(contents, kinds)) {
    const first = nodes.find(item => item.end > token.start), last = nodes.find(item => item.end >= token.end);
    if (!first || !last) continue;
    const range = layer.ownerDocument.createRange();
    range.setStart(first.node, token.start - first.start);
    range.setEnd(last.node, token.end - last.start);
    for (const rect of range.getClientRects()) {
      if (rect.width > .1 && rect.height > .1) rects.push({ left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height });
    }
  }
  return rects;
}
