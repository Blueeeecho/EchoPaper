import test from 'node:test';
import assert from 'node:assert/strict';
import {choosePdfWord, findPdfWord, pdfRunBoundary, pdfWordAtPoint, type PdfWordTarget} from '../src/pdfWordTarget.ts';
const hint={word:'evidence',before:'unsupported identity ',after:' changes policy'};
test('repeated PDF words are chosen by nearby context and SyncTeX region, without broad rectangles',()=>{
 const candidates:PdfWordTarget[]=[
  {rect:{x:.1,y:.2,width:.07,height:.01},hint:{word:'evidence',before:'valid personal ',after:' guides advice'}},
  {rect:{x:.2,y:.4,width:.07,height:.01},hint},
 ];
 assert.equal(choosePdfWord(candidates,hint),candidates[1]);
 assert.equal(choosePdfWord(candidates,hint,[{x:.18,y:.39,width:.3,height:.03}]),candidates[1]);
 assert.equal(choosePdfWord(candidates,{word:'absent',before:'',after:''}),undefined);
 assert.equal(choosePdfWord(candidates,hint,[{x:.6,y:.8,width:.2,height:.01}]),undefined);
 const duplicate={...candidates[1],rect:{x:.3,y:.4,width:.07,height:.01},hint:{...hint}};
 assert.equal(choosePdfWord([candidates[1],duplicate],hint),undefined);
});
test('PDF item boundaries preserve font-split words and remove printed end-of-line hyphens only',()=>{
 const run={text:'prefer-',left:10,right:50,top:10,bottom:20};
 assert.deepEqual(pdfRunBoundary(run,{text:'ences',left:10,right:40,top:21,bottom:31}),{separator:'',dehyphenate:true});
 assert.deepEqual(pdfRunBoundary({...run,text:'evi'},{text:'dence',left:50,right:80,top:10,bottom:20}),{separator:'',dehyphenate:false});
 assert.equal(pdfRunBoundary({...run,text:'valid'},{text:'evidence',left:55,right:100,top:10,bottom:20}).separator,' ');
});

/** The fake only supplies Range geometry; assertions verify exact text-node
 * offsets, while real browser geometry is independently covered by UI QA. */
function layerFixture(text:string){
 const calls:{from:number;to:number}[]=[];
 const bounds={left:0,right:600,top:0,bottom:100,width:600,height:100};
 const span={getBoundingClientRect:()=>({left:10,right:10+text.length*5,top:10,bottom:20,width:text.length*5,height:10})};
 const node={nodeValue:text,length:text.length,parentElement:{closest:()=>span}};
 const document={
  createTreeWalker:()=>{let used=false;return{nextNode:()=>used?null:(used=true,node)};},
  caretRangeFromPoint:(x:number)=>({startContainer:node,startOffset:Math.max(0,Math.floor((x-10)/5))}),
  createRange:()=>{let from=0,to=0;return{setStart:(_node:unknown,offset:number)=>{from=offset;},setEnd:(_node:unknown,offset:number)=>{to=offset;},getClientRects:()=>{calls.push({from,to});return[{left:10+from*5,right:10+to*5,top:10,bottom:20,width:(to-from)*5,height:10}];}};},
 };
 return{layer:{ownerDocument:document,getBoundingClientRect:()=>bounds,contains:()=>true} as unknown as HTMLElement,calls};
}
test('point and forward lookup obtain word-only DOM Range bounds and reject distant whitespace',()=>{
 const text='valid evidence guides advice; unsupported identity evidence changes policy';
 const {layer,calls}=layerFixture(text),second=text.lastIndexOf('evidence');
 const target=pdfWordAtPoint(layer,10+(second+2)*5,15)!;
 assert.equal(target.hint.word,'evidence');assert.ok(target.hint.before.endsWith('identity '));
 assert.deepEqual(calls[0],{from:second,to:second+8});assert.ok(Math.abs(target.rect.width-40/600)<1e-12);
 const forward=findPdfWord(layer,hint)!;assert.equal(forward.rect.x,(10+second*5)/600);assert.equal(forward.rects?.length,1);
 assert.equal(pdfWordAtPoint(layer,590,90),undefined);
});
test('a word broken across PDF lines returns separate Range fragments and point lookup keeps the clicked fragment',()=>{
 const rect=(top:number,width:number)=>({left:10,right:10+width,top,bottom:top+10,width,height:10});
 const spans=[{getBoundingClientRect:()=>rect(10,35)},{getBoundingClientRect:()=>rect(25,25)}];
 const nodes=['prefer-','ences'].map((text,i)=>({nodeValue:text,length:text.length,parentElement:{closest:()=>spans[i]}}));
 const document={
  createTreeWalker:()=>{let n=0;return{nextNode:()=>nodes[n++]??null};},
  caretRangeFromPoint:()=>({startContainer:nodes[1],startOffset:2}),
  createRange:()=>({setStart:()=>{},setEnd:()=>{},getClientRects:()=>[rect(10,35),rect(25,25)]}),
 };
 const layer={ownerDocument:document,contains:()=>true,getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})} as unknown as HTMLElement;
 const found=findPdfWord(layer,{word:'preferences',before:'',after:''})!;
 assert.equal(found.rects?.length,2);assert.equal(found.rect.height,.1);
 assert.ok(found.rects!.every(rect=>rect.height<.11),'no box may cover the line gap');
 const clicked=pdfWordAtPoint(layer,20,30)!;assert.equal(clicked.hint.word,'preferences');assert.equal(clicked.rect.y,.25);assert.equal(clicked.rects?.length,2);
});
