import type { EditSelection } from './editReview';

export type WritingQuote = { id: number; projectId: string } & (
  { source: 'source'; selection: EditSelection } |
  { source: 'file'; path: string; content?: string } |
  { source: 'pdf'; text: string; buildId?: string; page?: number }
);

export function menuPosition(x: number, y: number, width: number, height: number) {
  return { left: Math.max(8, Math.min(x, width - 268)), top: Math.max(8, Math.min(y, height - 104)) };
}

export function quoteReference(quote: WritingQuote): { path: string; content: string } {
  if (quote.source === 'source') return { path: quote.selection.path, content: quote.selection.text };
  if (quote.source === 'file') return { path: quote.path, content: quote.content ?? '项目文件：' + quote.path };
  const location = [quote.buildId && `构建 ${quote.buildId}`, quote.page && `第 ${quote.page} 页`].filter(Boolean).join(' · ');
  return { path: `PDF 只读参考${location ? ` · ${location}` : ''}`, content: quote.text };
}
