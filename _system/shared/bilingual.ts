/**
 * 全文对照阅读：把版面解析结果整理成阅读块，并决定每块翻不翻。
 *
 * 只翻正文（标题、段落、图注、表注、脚注）。图片、图表、公式、表格、算法只展示不翻译，
 * 因此图内文字不会被改写。参考文献与附录默认保留原文，附录可由读者开启。
 * 页眉、页脚、页码、arXiv 侧栏编号不进入阅读视图。
 */

/** 版面元素类型，取值与文档解析接口 layouts[].type 一致。 */
export type LayoutType='title'|'text'|'table'|'image'|'image_caption'|'image_footnote'|'equation'|'header'|'footer'|'page_number'|'aside_text'|'seal'|'chart'|'algorithm'|'page_footnote'|'ref_text'|'table_caption';
export interface LayoutElement{layout_id?:string;type?:string;sub_type?:string;text?:string;position?:number[];polygon?:number[][];merge_text?:string;merge_column?:string}
export interface LayoutTable{layout_id?:string;markdown?:string;table_html?:string}
export interface LayoutImage{layout_id?:string;data_url?:string}
export interface LayoutPage{page_num?:number;layouts?:LayoutElement[];tables?:LayoutTable[];images?:LayoutImage[];meta?:{page_width?:number;page_height?:number}}
export interface DocumentLayout{version:1;resourceId:string;sourceHash:string;parsedAt:string;pageCount:number;costPages:number;pages:LayoutPage[];engine?:string}

export type BlockRole='doc_title'|'heading'|'paragraph'|'caption'|'footnote'|'equation'|'figure'|'table'|'code'|'reference'|'meta';
export type BlockSection='front'|'body'|'references'|'appendix';
/** 不翻译时的原因，直接展示给读者，便于判断规则是否判错。 */
export type SkipReason=''|'图片'|'公式'|'表格'|'算法'|'参考文献'|'附录'|'作者信息'|'脚注'|'无需翻译';

export interface BilingualBlock{
 id:string;page:number;type:string;subType:string;role:BlockRole;section:BlockSection;
 text:string;translate:boolean;skipReason:SkipReason;
 /** 跨页或跨栏被切开的段落，拼回一段后记录全部来源 id，便于回溯原文位置。 */
 mergedIds:string[];
 tableHtml?:string;imageUrl?:string;
 /** 版面坐标 [x,y,w,h] 与该页尺寸，用于按原样从 PDF 裁出这块区域。 */
 rect?:[number,number,number,number];cropRect?:[number,number,number,number];pageWidth?:number;pageHeight?:number;
}
export interface BilingualDocument{title:string;pageCount:number;blocks:BilingualBlock[]}
export interface BilingualOptions{translateAppendix?:boolean;translateFootnotes?:boolean;translateTables?:boolean}

/** 页眉页脚与 arXiv 侧栏编号属于版式附属物，不进入阅读视图。 */
const DROPPED=new Set(['header','footer','page_number','seal','aside_text']);
const FIGURE_TYPES=new Set(['image','chart']);
/** 只有正文类元素参与跨页拼接，避免把图注接到段落上。 */
const MERGEABLE=new Set(['text','page_footnote']);
const REFERENCE_TITLES=new Set(['references','reference','bibliography','literature cited','works cited','cited literature','references and notes','参考文献','引用文献']);
const APPENDIX_PREFIXES=['appendix','appendices','supplementary material','supplemental material','supplementary materials','supplementary information','supplementary','online appendix','technical appendix','附录','补充材料'];
const NUMBERING=/^\s*(?:[0-9]+(?:\.[0-9]+)*|[IVXLC]+|[A-Z](?:\.[0-9]+)*)[.):]?\s+/;
/** 参考文献之后出现的字母编号标题（A Proof of …）是附录，不是正文章节。 */
const LETTERED_HEADING=/^\s*[A-H](?:\.[0-9]+)*\.?\s+[A-Z]/;
/** 参考文献条目里偶尔会被识别成标题的短片段，不能据此判定分区已经结束。 */
const REFERENCE_ENTRY=/^\s*[\[(]?\d{1,3}[\]).]/;
const ABSTRACT=/^\s*(abstract|摘要)\b[\s:.—–-]*/i;
const WORDS=/[A-Za-zÀ-ɏ]{2,}/g;
const CJK_END=/[一-鿿]$/,CJK_START=/^[一-鿿]/;

function normalizeHeading(text:string):string{return text.trim().replace(/^[*#\s]+|[*#\s]+$/g,'').replace(NUMBERING,'').trim().replace(/[:：.]+$/,'').trim().toLowerCase();}
export function isReferencesHeading(text:string):boolean{const t=text.trim();if(!t||t.length>40)return false;return REFERENCE_TITLES.has(normalizeHeading(t))||REFERENCE_TITLES.has(t.toLowerCase().replace(/:$/,''));}
export function isAppendixHeading(text:string):boolean{const t=text.trim();if(!t||t.length>120)return false;const low=t.toLowerCase(),normalized=normalizeHeading(t);return APPENDIX_PREFIXES.some(p=>low.startsWith(p)||normalized.startsWith(p));}
/** 标题可以只有一个词（Abstract）；正文至少两个词，避免把页码、编号当正文送去翻译。 */
function worthTranslating(text:string,heading:boolean):boolean{return (text.match(WORDS)?.length??0)>=(heading?1:2);}
function headingLike(element:LayoutElement):boolean{if(element.type==='title')return true;const t=(element.text||'').trim();return element.type==='text'&&t.length>0&&t.length<=60&&!/[.。]$/.test(t);}
/** 断词连字符直接相接；中文之间不补空格；其余按词补一个空格。 */
function joinText(a:string,b:string):string{const left=a.replace(/\s+$/,''),right=b.replace(/^\s+/,'');if(!left)return right;if(/-$/.test(left)&&/^[a-z]/.test(right))return left+right;if(CJK_END.test(left)&&CJK_START.test(right))return left+right;return left+' '+right;}

function decide(block:BilingualBlock,options:BilingualOptions):{translate:boolean;skipReason:SkipReason}{
 if(block.role==='figure')return{translate:false,skipReason:'图片'};
 if(block.role==='equation')return{translate:false,skipReason:'公式'};
 if(block.role==='code')return{translate:false,skipReason:'算法'};
 if(block.role==='table'&&!options.translateTables)return{translate:false,skipReason:'表格'};
 if(block.section==='references'||block.role==='reference')return{translate:false,skipReason:'参考文献'};
 if(block.section==='appendix'&&!options.translateAppendix)return{translate:false,skipReason:'附录'};
 if(block.role==='meta')return{translate:false,skipReason:'作者信息'};
 if(block.role==='footnote'&&options.translateFootnotes===false)return{translate:false,skipReason:'脚注'};
 if(block.role==='table')return{translate:false,skipReason:'表格'};
 if(!worthTranslating(block.text,block.role==='heading'||block.role==='doc_title'))return{translate:false,skipReason:'无需翻译'};
 return{translate:true,skipReason:''};
}

/** 首页出现 Abstract 时，它之前的内容是作者与单位，只展示不翻译。 */
function hasAbstract(pages:LayoutPage[]):boolean{return pages.slice(0,2).some(page=>(page.layouts||[]).some(l=>ABSTRACT.test(l.text||'')&&(l.type==='title'||l.type==='text')));}

export function buildBilingualDocument(layout:Pick<DocumentLayout,'pages'>,options:BilingualOptions={}):BilingualDocument{
 const pages=[...(layout.pages||[])].sort((a,b)=>(a.page_num??0)-(b.page_num??0));
 // Existing caches include both zero-based parser pages and one-based PaddleOCR pages.
 const oneBased=pages.some(page=>page.page_num===1)&&!pages.some(page=>page.page_num===0);
 const tables=new Map<string,LayoutTable>(),images=new Map<string,string>();
 for(const page of pages){
  for(const table of page.tables||[])if(table.layout_id)tables.set(table.layout_id,table);
  for(const image of page.images||[])if(image.layout_id&&image.data_url)images.set(image.layout_id,image.data_url);
 }
 let section:BlockSection=hasAbstract(pages)?'front':'body';
 let title='',open:BilingualBlock|undefined;
 const blocks:BilingualBlock[]=[];
 for(const [pageIndex,page] of pages.entries()){
  const pageNumber=page.page_num===undefined?pageIndex:Number(page.page_num)-(oneBased?1:0);
  for(const element of page.layouts||[]){
   const type=(element.type||'text').trim(),text=(element.text||'').trim();
   const id=element.layout_id||`p${pageNumber}-${blocks.length}`,merge=(element.merge_text||'').trim();
   if(DROPPED.has(type))continue;
   if(open&&MERGEABLE.has(type)&&(merge==='inner'||merge==='end')){
    open.text=joinText(open.text,text);open.mergedIds.push(id);
    if(merge==='end')open=undefined;
    continue;
   }
   const heading=headingLike(element);
   if(heading&&isReferencesHeading(text))section='references';
   else if(heading&&isAppendixHeading(text))section='appendix';
   else if(type==='ref_text'&&(section==='front'||section==='body'))section='references';
   // 参考文献之后再出现正经标题（附录、补充材料、投稿检查单等），都属于附录类后置内容。
   else if(section==='references'&&type==='title'&&text.length>2&&!REFERENCE_ENTRY.test(text)&&(LETTERED_HEADING.test(text)||/[A-Za-z\u4e00-\u9fff]/.test(text)))section='appendix';
   if(section==='front'&&ABSTRACT.test(text))section='body';

   const position=Array.isArray(element.position)&&element.position.length===4&&element.position.every(v=>Number.isFinite(v))?element.position as [number,number,number,number]:undefined;
   const block:BilingualBlock={id,page:pageNumber,type,subType:element.sub_type||'',role:'paragraph',section,text,translate:false,skipReason:'',mergedIds:[id],
    ...(position?{rect:position}:{}),...(page.meta?.page_width&&page.meta?.page_height?{pageWidth:page.meta.page_width,pageHeight:page.meta.page_height}:{})};
   if(type==='title')block.role='heading';
   else if(FIGURE_TYPES.has(type)){block.role='figure';block.imageUrl=images.get(id);}
   else if(type==='equation')block.role='equation';
   else if(type==='table'){const table=tables.get(id);block.role='table';block.imageUrl=images.get(id);block.tableHtml=table?.table_html||'';if(!block.text)block.text=table?.markdown||'';}
   else if(type==='algorithm')block.role='code';
   else if(type==='ref_text')block.role='reference';
   else if(type.includes('caption'))block.role='caption';
   else if(type.includes('footnote'))block.role='footnote';

   if(section==='front'){
    if(!title&&type==='title'&&text){title=text;block.role='doc_title';}
    else if(!['figure','equation','table'].includes(block.role))block.role='meta';
   }else if(!title&&type==='title'&&pageNumber===0&&text&&!ABSTRACT.test(text)){title=text;block.role='doc_title';}

   if((block.role==='figure'||block.role==='table')&&position&&block.pageWidth&&block.pageHeight){
    block.cropRect=bilingualCropRect(position,page.layouts||[],block.pageWidth,block.pageHeight,element);
   }
   blocks.push(block);
   open=merge==='begin'&&MERGEABLE.has(type)?block:undefined;
  }
 }
 // 拼接完成后再判断：被拼长的段落要按完整文本决定，而不是按第一段的残句。
 for(const block of blocks)Object.assign(block,decide(block,options));
 return{title,pageCount:pages.length,blocks};
}

/** A small border allowance stops halfway to neighbouring text, captions or tables. */
export function bilingualCropRect(rect:[number,number,number,number],elements:readonly LayoutElement[],width:number,height:number,current?:LayoutElement):[number,number,number,number]{
 const [x,y,w,h]=rect;
 let left=Math.max(0,x-width/300),top=Math.max(0,y-height/400);
 let right=Math.min(width,x+w+width/300),bottom=Math.min(height,y+h+height/400);
 for(const element of elements){
  if(element===current)continue;
  const other=element.position;
  if(!other||other.length!==4||!other.every(Number.isFinite)||other[2]<=0||other[3]<=0)continue;
  const [ox,oy,ow,oh]=other;
  if(Math.min(x+w,ox+ow)>Math.max(x,ox)){
   if(oy+oh<=y)top=Math.max(top,(oy+oh+y)/2);
   if(oy>=y+h)bottom=Math.min(bottom,(oy+y+h)/2);
  }
  if(Math.min(y+h,oy+oh)>Math.max(y,oy)){
   if(ox+ow<=x)left=Math.max(left,(ox+ow+x)/2);
   if(ox>=x+w)right=Math.min(right,(ox+x+w)/2);
  }
 }
 return [left,top,right-left,bottom-top];
}

export interface BilingualFigureRow {columns:BilingualBlock[][];captions:BilingualBlock[]}
/** Keep neighbouring figures and their captions in the same row as the source page. */
export function bilingualFigureRow(blocks:readonly BilingualBlock[],start:number):BilingualFigureRow|undefined{
 const first=blocks[start];
 if(first?.role!=='figure'||!first.rect)return;
 const run:BilingualBlock[]=[];
 for(const block of blocks.slice(start)){
  if(block.page!==first.page||block.section!==first.section||!block.rect)break;
  if(block.role!=='figure'&&!['image_caption','image_footnote'].includes(block.type))break;
  run.push(block);
 }
 const figures=run.filter(block=>block.role==='figure').sort((a,b)=>a.rect![0]-b.rect![0]);
 if(figures.length<2)return;
 const top=Math.max(...figures.map(block=>block.rect![1]));
 const bottom=Math.min(...figures.map(block=>block.rect![1]+block.rect![3]));
 if(top>=bottom||figures.some((block,i)=>i>0&&figures[i-1].rect![0]+figures[i-1].rect![2]>block.rect![0]))return;
 const columns=figures.map(block=>[block]);
 const captions:BilingualBlock[]=[];
 for(const caption of run.filter(block=>block.role!=='figure')){
  const [x,,width]=caption.rect!;
  const covered=figures.filter(block=>{
   const [left,,figureWidth]=block.rect!;
   return Math.min(x+width,left+figureWidth)-Math.max(x,left)>Math.min(width,figureWidth)/2;
  });
  if(covered.length>1){captions.push(caption);continue;}
  const center=caption.rect![0]+caption.rect![2]/2;
  const distances=figures.map(block=>Math.abs(center-(block.rect![0]+block.rect![2]/2)));
  columns[distances.indexOf(Math.min(...distances))].push(caption);
 }
 return {columns,captions};
}

export interface BilingualStats{total:number;translate:number;references:number;appendix:number;figures:number;equations:number;tables:number}
export function bilingualStats(document:BilingualDocument):BilingualStats{
 const stats:BilingualStats={total:document.blocks.length,translate:0,references:0,appendix:0,figures:0,equations:0,tables:0};
 for(const block of document.blocks){
  if(block.translate)stats.translate++;
  if(block.section==='references')stats.references++;else if(block.section==='appendix')stats.appendix++;
  if(block.role==='figure')stats.figures++;else if(block.role==='equation')stats.equations++;else if(block.role==='table')stats.tables++;
 }
 return stats;
}
