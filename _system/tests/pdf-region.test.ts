import test from 'node:test';
import assert from 'node:assert/strict';
import {aiStudioPages} from '../server/workspace/document-layout';
import {bilingualCropRect,buildBilingualDocument,type LayoutElement} from '../shared/bilingual';
import {pdfRegionBounds} from '../src/academic/pdfRegion';

const parsed=(pruned:Record<string,unknown>,images:Record<string,string>={})=>aiStudioPages(JSON.stringify({result:{layoutParsingResults:[{prunedResult:pruned,markdown:{images}}]}}));

test('AI Studio crop coordinates use original dimensions and never infer the page from its content',()=>{
 const blocks=[{block_label:'image',block_bbox:[100,200,600,800],block_order:null}];
 assert.deepEqual(parsed({width:1200,height:1600,doc_preprocessor_res:{output_img_shape:[800,600]},parsing_res_list:blocks})[0].meta,{page_width:1200,page_height:1600});
 assert.deepEqual(parsed({input_img_shape:[1600,1200],parsing_res_list:blocks})[0].meta,{page_width:1200,page_height:1600});
 assert.deepEqual(parsed({parsing_res_list:blocks})[0].meta,{});
});

test('AI Studio matches original image crops to the exact block and keeps nested images separate',()=>{
 const pages=parsed({width:1200,height:1600,parsing_res_list:[
  {block_label:'image',block_bbox:[100,200,600,800],block_order:null},
  {block_label:'table',block_bbox:[100,900,600,1200],block_order:null},
 ]},{
  'imgs/img_in_image_box_120_220_250_350.jpg':'https://example.invalid/nested.jpg',
  'imgs/img_in_image_box_100_200_600_800.jpg':'https://example.invalid/full.jpg',
  'imgs/img_in_table_box_100_900_600_1200.png':'AAAA',
 });
 assert.deepEqual(pages[0].images,[
  {layout_id:'p1-0',data_url:'https://example.invalid/full.jpg'},
  {layout_id:'p1-1',data_url:'data:image/png;base64,AAAA'},
 ]);
 const blocks=buildBilingualDocument({pages}).blocks;
 assert.equal(blocks[0].imageUrl,'https://example.invalid/full.jpg');
 assert.equal(blocks[1].imageUrl,'data:image/png;base64,AAAA');
});

test('invalid API rectangles do not become crop regions and null reading order preserves the returned sequence',()=>{
 const pages=parsed({width:1200,height:1600,parsing_res_list:[
  {block_label:'text',block_content:'First returned block',block_order:2},
  {block_label:'image',block_bbox:[100,200,90,800],block_order:null},
  {block_label:'image',block_bbox:[100,null,600,800],block_order:1},
 ]});
 assert.equal(pages[0].layouts?.[0].text,'First returned block');
 assert.equal(pages[0].layouts?.[1].position,undefined);
 assert.equal(pages[0].layouts?.[2].position,undefined);
});

test('border allowance stays outside nearby captions and adjacent tables',()=>{
 const image:LayoutElement={type:'chart',position:[700,290,270,184]};
 const caption:LayoutElement={type:'image_caption',position:[665,480,340,25]};
 const rect=bilingualCropRect(image.position as [number,number,number,number],[image,caption],1224,1584,image);
 assert.ok(rect[1]+rect[3]<=477);
 assert.ok(rect[0]<700&&rect[0]+rect[2]>970);
 const adjacent:LayoutElement={type:'table',position:[218,472,785,281]};
 const first:LayoutElement={type:'table',position:[218,188,785,282]};
 const table=bilingualCropRect(first.position as [number,number,number,number],[first,adjacent],1224,1584,first);
 assert.equal(table[1]+table[3],471);
});

test('PDF crops scale each axis separately and clip endpoints at all page edges',()=>{
 assert.deepEqual(pdfRegionBounds({rect:[100,200,200,400],pageWidth:1000,pageHeight:2000},{width:500,height:800}),{x:50,y:80,width:100,height:160});
 assert.deepEqual(pdfRegionBounds({rect:[-10,-20,50,60],pageWidth:100,pageHeight:100},{width:200,height:300}),{x:0,y:0,width:80,height:120});
 assert.deepEqual(pdfRegionBounds({rect:[90,90,20,20],pageWidth:100,pageHeight:100},{width:200,height:300}),{x:180,y:270,width:20,height:30});
 assert.equal(pdfRegionBounds({rect:[200,200,10,10],pageWidth:100,pageHeight:100},{width:200,height:300}),undefined);
 assert.equal(pdfRegionBounds({rect:[1,2,3,4],pageWidth:100},{width:200,height:300}),undefined);
});

test('existing layout caches receive bounded crops while original OCR boxes and text remain available',()=>{
 const layout={pages:[{page_num:1,meta:{page_width:1224,page_height:1584},layouts:[
  {layout_id:'chart',type:'chart',position:[700,290,270,184]},
  {layout_id:'caption',type:'image_caption',text:'Figure 3: Accuracy improves with more agents.',position:[665,480,340,25]},
 ]}]};
 const before=JSON.stringify(layout);
 const doc=buildBilingualDocument(layout);
 assert.deepEqual(doc.blocks[0].rect,[700,290,270,184]);
 assert.ok(doc.blocks[0].cropRect);
 assert.ok(doc.blocks[0].cropRect![1]+doc.blocks[0].cropRect![3]<480);
 assert.equal(JSON.stringify(layout),before);
});
