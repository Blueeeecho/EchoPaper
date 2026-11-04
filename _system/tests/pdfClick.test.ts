import test from 'node:test';import assert from 'node:assert/strict';import{shouldLocatePdf,mostVisiblePdfPage,type PdfClickIntent}from'../src/pdfClick.ts';
const click:PdfClickIntent={button:0,detail:1,enabled:true,modified:false,interactive:false,dragged:false,selected:false};
test('single PDF clicks never navigate, including Ctrl/Cmd clicks and disabled locating mode',()=>{for(const enabled of [true,false])for(const modified of [true,false])assert.equal(shouldLocatePdf({...click,enabled,modified}),false);});
test('PDF link/note controls, drags, existing text selections and context clicks never trigger single-click navigation',()=>{for(const patch of [{interactive:true},{dragged:true},{selected:true},{detail:0},{detail:3},{button:2}])assert.equal(shouldLocatePdf({...click,...patch}),false,JSON.stringify(patch));});
test('double-click locates through native word selection while preserving link, drag and mode exclusions',()=>{
 const double={...click,detail:2,selected:true};assert.equal(shouldLocatePdf(double),true);
 for(const patch of [{interactive:true},{dragged:true},{enabled:false},{button:2}])assert.equal(shouldLocatePdf({...double,...patch}),false,JSON.stringify(patch));
 assert.equal(shouldLocatePdf({...double,enabled:false,modified:true}),false);
});
test('last page remains current when scroll clamps and some of the preceding page is visible',()=>{assert.equal(mostVisiblePdfPage([{page:7,top:-228,bottom:383},{page:8,top:383,bottom:994}],132,1000),8);assert.equal(mostVisiblePdfPage([{page:1,top:0,bottom:1000},{page:2,top:1000,bottom:2000}],100,700),1);assert.equal(mostVisiblePdfPage([],0,500),undefined);});
