import test from 'node:test';
import assert from 'node:assert/strict';
import {bilingualFigureRow,buildBilingualDocument,type LayoutPage} from '../shared/bilingual';

test('cached parser pages use physical zero-based pages with either numbering convention',()=>{
 const pages=(base:number):LayoutPage[]=>[0,1].map(index=>({
  page_num:index+base,
  layouts:[{layout_id:`page-${index}`,type:'text',text:'A source paragraph with a stable translation cache key.'}],
 }));
 const zero=buildBilingualDocument({pages:pages(0)});
 const one=buildBilingualDocument({pages:pages(1)});
 assert.deepEqual(one.blocks,zero.blocks);
 assert.deepEqual(one.blocks.map(block=>block.page),[0,1]);
 const unnumbered=pages(0).map(({page_num,...page})=>page);
 assert.deepEqual(buildBilingualDocument({pages:unnumbered}).blocks.map(block=>block.page),[0,1]);
});

test('side-by-side figures keep their own captions and source coordinates',()=>{
 const pages:LayoutPage[]=[{page_num:1,meta:{page_width:1200,page_height:1600},layouts:[
  {layout_id:'left',type:'image',position:[200,140,330,280]},
  {layout_id:'left-caption',type:'image_caption',text:'Figure one and its caption.',position:[200,435,330,25]},
  {layout_id:'right',type:'chart',position:[570,165,430,255]},
  {layout_id:'right-caption',type:'image_caption',text:'Figure two and its caption.',position:[570,435,430,25]},
  {layout_id:'body',type:'text',text:'The discussion follows both figures.'},
 ]}];
 const baseline=JSON.stringify(pages);
 const doc=buildBilingualDocument({pages});
 const row=bilingualFigureRow(doc.blocks,0);
 assert.deepEqual(row?.columns.map(column=>column.map(block=>block.id)),[['left','left-caption'],['right','right-caption']]);
 assert.ok(row?.columns.flat().every(block=>block.page===0));
 assert.deepEqual(row?.captions,[]);
 assert.equal(JSON.stringify(pages),baseline);
});

test('a caption spanning several figures stays below the full figure row',()=>{
 const doc=buildBilingualDocument({pages:[{page_num:0,layouts:[
  {layout_id:'left',type:'image',position:[100,100,300,200]},
  {layout_id:'right',type:'image',position:[500,100,300,200]},
  {layout_id:'shared',type:'image_caption',text:'Figure one has two panels.',position:[100,320,700,50]},
 ]}]});
 const row=bilingualFigureRow(doc.blocks,0);
 assert.deepEqual(row?.columns.map(column=>column.map(block=>block.id)),[['left'],['right']]);
 assert.deepEqual(row?.captions.map(block=>block.id),['shared']);
});

test('figures on different rows, pages or without coordinates keep their reading order',()=>{
 const make=(secondPage=0,secondY=150)=>buildBilingualDocument({pages:[{page_num:0,layouts:[
  {layout_id:'first',type:'image',position:[100,100,300,200]},
  {layout_id:'second',type:'image',position:[500,secondY,300,200]},
 ]}]}).blocks.map((block,index)=>index?{...block,page:secondPage}:block);
 assert.equal(bilingualFigureRow(make(0,400),0),undefined);
 assert.equal(bilingualFigureRow(make(1),0),undefined);
 const missing=make().map(block=>({...block,rect:undefined}));
 assert.equal(bilingualFigureRow(missing,0),undefined);
 const overlapping=make().map((block,index)=>index?{...block,rect:[200,150,300,200] as [number,number,number,number]}:block);
 assert.equal(bilingualFigureRow(overlapping,0),undefined);
});
