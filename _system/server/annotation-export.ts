import { PDFDocument, PDFName, PDFHexString, PDFArray } from 'pdf-lib';
import type { PdfAnnotation } from '../shared/types.ts';
import { HttpError } from './security.ts';
const statuses = { open: '待处理', changed: '已修改', verified: '已核验' };
const kinds = { highlight: '标黄', comment: '文字备注', bold: '加粗阅读标记', italic: '斜体阅读标记' };
const colors = { highlight: [1, .83, .08], comment: [1, .56, .08], bold: [.13, .42, .86], italic: [.48, .26, .78] };
function contents(a: PdfAnnotation) {
  return [`${kinds[a.kind]} · ${statuses[a.status ?? 'open']}`, a.quote && `原文：${a.quote}`, a.comment && `备注：${a.comment}`, a.source && `修改位置：${a.source.path}:${a.source.line}`, a.migratedFrom && `迁移自：${a.migratedFrom}`].filter(Boolean).join('\n');
}
export function annotationMarkdown(projectId: string, buildId: string, annotations: PdfAnnotation[]) {
  return `# ${projectId} 批注清单\n\n编译版本：${buildId}\n\n${annotations.map((a, i) => `## ${i + 1}. 第 ${a.page} 页 · ${kinds[a.kind]} · ${statuses[a.status ?? 'open']}\n\n${a.quote ? `> ${a.quote.replace(/\n/g, '\n> ')}\n\n` : ''}${a.comment || '（无备注）'}\n\n${a.source ? `修改位置：\`${a.source.path}:${a.source.line}\`\n\n` : ''}批注 ID：${a.id}${a.migratedFrom ? `；迁移自：${a.migratedFrom}` : ''}\n`).join('\n')}`;
}
/** Add standard PDF markup dictionaries to a copy; never write to the build artifact. */
export async function exportAnnotatedPdf(source: Uint8Array, annotations: PdfAnnotation[]): Promise<Uint8Array> {
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(source, { updateMetadata: false }); }
  catch { throw new HttpError(400, '原 PDF 无法读取，请检查编译产物。'); }
  const pages = pdf.getPages();
  for (const a of annotations) {
    const page = pages[a.page - 1];
    if (!page) throw new HttpError(400, `批注 ${a.id} 的页码超出 PDF，请先核对批注记录。`);
    const crop = page.getCropBox(), rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const displayWidth = rotation === 90 || rotation === 270 ? crop.height : crop.width;
    const displayHeight = rotation === 90 || rotation === 270 ? crop.width : crop.height;
    const point = (x: number, y: number): [number, number] => {
      const dx = x * displayWidth, dy = y * displayHeight;
      if (rotation === 90) return [crop.x + dy, crop.y + dx];
      if (rotation === 180) return [crop.x + crop.width - dx, crop.y + dy];
      if (rotation === 270) return [crop.x + crop.width - dy, crop.y + crop.height - dx];
      return [crop.x + dx, crop.y + crop.height - dy];
    };
    let existing = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!existing) { existing = pdf.context.obj([]); page.node.set(PDFName.of('Annots'), existing); }
    const quads: number[] = [], all: [number, number][] = [];
    for (const rect of a.rects) {
      const corners = [point(rect.x, rect.y), point(rect.x + rect.width, rect.y), point(rect.x, rect.y + rect.height), point(rect.x + rect.width, rect.y + rect.height)];
      corners.forEach(p => { quads.push(...p); all.push(p); });
    }
    const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const common = { Type: 'Annot', Contents: PDFHexString.fromText(contents(a)), T: PDFHexString.fromText('EchoPaper'), P: page.ref, C: colors[a.kind], F: 4, NM: PDFHexString.fromText(a.id), M: PDFHexString.fromText(`D:${a.updatedAt.replace(/[-:TZ.]/g, '').slice(0, 14)}Z`) };
    if (a.kind !== 'comment' || a.quote) {
      const subtype = a.kind === 'bold' ? 'Underline' : a.kind === 'italic' ? 'Squiggly' : 'Highlight';
      const markup = pdf.context.obj({ ...common, Subtype: subtype, Rect: bounds, QuadPoints: quads, CA: a.kind === 'highlight' ? .5 : .85 });
      existing.push(pdf.context.register(markup));
    }
    if (a.kind === 'comment' || a.comment) {
      const [x, y] = point(a.rects[0].x, a.rects[0].y);
      const iconX = Math.max(crop.x, Math.min(crop.x + crop.width - 22, x));
      const iconY = Math.max(crop.y, Math.min(crop.y + crop.height - 22, y - 22));
      const note = pdf.context.obj({ ...common, NM: PDFHexString.fromText(`${a.id}-note`), Subtype: 'Text', Rect: [iconX, iconY, iconX + 22, iconY + 22], Name: 'Comment', Open: false });
      existing.push(pdf.context.register(note));
    }
  }
  return pdf.save({ useObjectStreams: true });
}
