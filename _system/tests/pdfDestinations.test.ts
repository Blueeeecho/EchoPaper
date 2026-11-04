import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib';
import { pdfLinkRectangle, resolvePdfDestination, safePdfLinkUrl } from '../src/pdfDestinations.ts';

async function fixture() {
  const doc = await PDFDocument.create(), first = doc.addPage([600,800]), second = doc.addPage([600,800]);
  second.setCropBox(50,100,400,600);
  const target = doc.context.obj([second.ref,PDFName.of('XYZ'),150,650,null]);
  doc.catalog.set(PDFName.of('Names'),doc.context.obj({Dests:{Names:[PDFString.of('figure.1'),target]}}));
  first.node.set(PDFName.of('Annots'),doc.context.obj([
    {Type:'Annot',Subtype:'Link',Rect:[70,700,110,715],Border:[0,0,0],Dest:PDFString.of('figure.1')},
    {Type:'Annot',Subtype:'Link',Rect:[120,700,150,715],Border:[0,0,0],A:{S:'URI',URI:PDFString.of('https://example.com/paper')}},
    {Type:'Annot',Subtype:'Link',Rect:[160,700,190,715],Border:[0,0,0],A:{S:'URI',URI:PDFString.of('javascript:alert(1)')}}
  ]));
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:await doc.save(),disableFontFace:true,useSystemFonts:false});
  return {task,pdf:await task.promise,doc,second};
}
test('real PDF named destinations resolve through page references with crop-aware normalized positions',async()=>{
  const {task,pdf}=await fixture();try{
    const annotations=await(await pdf.getPage(1)).getAnnotations({intent:'display'});assert.equal(annotations.filter(a=>a.annotationType===2).length,3);
    const target=await resolvePdfDestination(pdf,annotations[0].dest);assert.deepEqual(target,{page:2,x:.25,y:1/12,fit:'XYZ'});
    assert.equal(safePdfLinkUrl(annotations[1].url),'https://example.com/paper');assert.equal(safePdfLinkUrl(annotations[2].unsafeUrl),undefined);
    const page=await pdf.getPage(1);assert.deepEqual(pdfLinkRectangle(annotations[0].rect,page.getViewport({scale:2})),{left:140,top:170,width:80,height:30});
    assert.deepEqual(await resolvePdfDestination(pdf,[1,{name:'FitH'},650]),{page:2,x:0,y:1/12,fit:'FitH'});
    assert.deepEqual(await resolvePdfDestination(pdf,[1,{name:'FitV'},150]),{page:2,x:.25,y:0,fit:'FitV'});
    assert.deepEqual(await resolvePdfDestination(pdf,[1,{name:'FitR'},150,400,350,650]),{page:2,x:.25,y:1/12,fit:'FitR',rect:{x:.25,y:1/12,width:.5,height:250/600}});
  }finally{await task.destroy();}
});
test('rotated destinations and clickable rectangles follow the displayed viewport, not raw PDF coordinates',async()=>{
  const doc=await PDFDocument.create();const page=doc.addPage([600,800]);page.setCropBox(50,100,400,600);page.setRotation(degrees(90));
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const task=getDocument({data:await doc.save()});const pdf=await task.promise;
  try{
    const target=await resolvePdfDestination(pdf,[0,{name:'XYZ'},150,650,2]);assert.deepEqual(target,{page:1,x:550/600,y:.25,fit:'XYZ',zoom:2});
    const viewport=(await pdf.getPage(1)).getViewport({scale:1});assert.deepEqual(pdfLinkRectangle([100,200,200,300],viewport),{left:100,top:50,width:100,height:100});
    assert.deepEqual(await resolvePdfDestination(pdf,[0,{name:'Fit'}]),{page:1,x:0,y:0,fit:'Fit'});
    assert.deepEqual(await resolvePdfDestination(pdf,[0,{name:'XYZ'},null,null,0]),{page:1,x:1,y:0,fit:'XYZ'});
  }finally{await task.destroy();}
});
test('external URLs are protocol-restricted and invalid internal destinations fail explicitly',async()=>{
  for(const value of ['javascript:alert(1)','file:///tmp/paper.pdf','data:text/html,hello','vbscript:hello','//example.com','https://name:secret@example.com','https://example.com/\npath','mailto:','relative.pdf',null])assert.equal(safePdfLinkUrl(value),undefined);
  assert.equal(safePdfLinkUrl('mailto:author@example.org'),'mailto:author@example.org');assert.equal(safePdfLinkUrl('http://example.org/paper'),'http://example.org/paper');
  const {task,pdf}=await fixture();try{
    for(const destination of ['missing-destination',[-1,{name:'Fit'}],[2,{name:'Fit'}],[0,{name:'JavaScript'}],[0,{name:'XYZ'},NaN,1,null],[0,{name:'FitR'},100,100,99,101],[{num:-1,gen:0},{name:'Fit'}]])await assert.rejects(()=>resolvePdfDestination(pdf,destination));
    const viewport=(await pdf.getPage(1)).getViewport({scale:1});assert.equal(pdfLinkRectangle([1,2,NaN,3],viewport),undefined);assert.equal(pdfLinkRectangle([-100,-100,-50,-50],viewport),undefined);assert.deepEqual(pdfLinkRectangle([-5,790,10,810],viewport),{left:0,top:0,width:10,height:10});
  }finally{await task.destroy();}
});
