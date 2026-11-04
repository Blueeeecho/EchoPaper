import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFHexString, degrees } from 'pdf-lib';
import { exportAnnotatedPdf } from '../server/annotation-export.ts';
import type { PdfAnnotation } from '../shared/types.ts';
const note: PdfAnnotation = {id:'ann-test',targetId:'main',buildId:'build-test',kind:'comment',status:'changed',page:1,quote:'',comment:'中文备注与审稿意见',rects:[{x:.2,y:.3,width:.2,height:.02}],createdAt:'2026-10-22T10:00:00.000Z',updatedAt:'2026-10-22T10:00:00.000Z',revision:1};
test('standard PDF annotations preserve Chinese text and do not mutate the original bytes',async()=>{
  const original=await PDFDocument.create();original.addPage([600,800]);const source=await original.save();const snapshot=Buffer.from(source);
  const bytes=await exportAnnotatedPdf(source,[note,{...note,id:'ann-mark',kind:'highlight',quote:'selected words'}]);
  assert.deepEqual(Buffer.from(source),snapshot);
  const result=await PDFDocument.load(bytes);const annots=result.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray);assert.equal(annots.size(),3);
  const first=result.context.lookup(annots.get(0),PDFDict);assert.equal(first.lookup(PDFName.of('Subtype'),PDFName).toString(),'/Text');assert.match(first.lookup(PDFName.of('Contents'),PDFHexString).decodeText(),/中文备注与审稿意见/);
  const rect=first.lookup(PDFName.of('Rect'),PDFArray).asArray().map(value=>Number(value.toString()));assert.deepEqual(rect,[120,538,142,560]);
  assert.equal((await PDFDocument.load(source)).getPage(0).node.has(PDFName.of('Annots')),false);
});
test('rotated crop coordinates map back to valid user-space quads and missing pages fail explicitly',async()=>{
  const source=await PDFDocument.create();source.addPage([600,800]).setRotation(degrees(90));const bytes=await source.save();
  const result=await PDFDocument.load(await exportAnnotatedPdf(bytes,[{...note,kind:'bold',quote:'words'}]));
  const annots=result.getPage(0).node.lookup(PDFName.of('Annots'),PDFArray);const mark=result.context.lookup(annots.get(0),PDFDict);
  assert.equal(mark.lookup(PDFName.of('Subtype'),PDFName).toString(),'/Underline');
  assert.deepEqual(mark.lookup(PDFName.of('QuadPoints'),PDFArray).asArray().map(value=>Number(value.toString())).slice(0,4),[180,160,180,320]);
  await assert.rejects(()=>exportAnnotatedPdf(bytes,[{...note,page:2}]),/页码超出/);
});
