import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {pdfTitle,layoutTitle} from '../server/workspace/pdf-title';

async function paper(metadata:string){
 const pdf=await PDFDocument.create();pdf.setTitle(metadata);
 const page=pdf.addPage([600,800]);
 const bold=await pdf.embedFont(StandardFonts.HelveticaBold),regular=await pdf.embedFont(StandardFonts.Helvetica);
 page.drawText('Learning Reliable Multi-Agent',{x:70,y:700,size:18,font:bold});
 page.drawText('Reasoning with Shared Evidence',{x:70,y:676,size:18,font:bold});
 page.drawText('Alice Researcher and Bob Researcher',{x:80,y:630,size:11,font:regular});
 page.drawText('Abstract',{x:70,y:580,size:12,font:bold});
 page.drawText('This paper studies a useful research question.',{x:70,y:550,size:10,font:regular});
 return pdf.save();
}
const title='Learning Reliable Multi-Agent Reasoning with Shared Evidence';
test('title extraction uses verified metadata and handles wrapped first-page headings',async()=>{
 assert.equal(await pdfTitle(await paper(title)),title);
 assert.equal(await pdfTitle(await paper('main.tex')),title);
 assert.equal(await pdfTitle(await paper('An unrelated earlier draft title')),title);
 assert.equal(await pdfTitle(Buffer.from('%PDF-1.4 invalid')),undefined);
});


test('image-only papers can obtain their title from the first OCR title block',()=>{
 const layout={version:1 as const,resourceId:'paper',sourceHash:'hash',parsedAt:'now',pageCount:1,costPages:1,pages:[{page_num:1,layouts:[
  {layout_id:'header',type:'title',text:'Preprint'},
  {layout_id:'paper-title',type:'title',text:'# Learning Reliable Multi-Agent Reasoning'},
  {layout_id:'abstract',type:'title',text:'Abstract'},
 ]}]};
 assert.equal(layoutTitle(layout),'Learning Reliable Multi-Agent Reasoning');
});
