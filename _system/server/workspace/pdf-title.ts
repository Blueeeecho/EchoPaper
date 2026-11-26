import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import type {DocumentInitParameters} from 'pdfjs-dist/types/src/display/api';
import type {DocumentLayout} from '../../shared/bilingual';

const normalize=(text:string)=>text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
const header=/^(?:arxiv\b|preprint$|published as|under review|accepted at|proceedings of|copyright|\d{4}[-/]\d)/i;
function validTitle(text:string){return text.length<=1000&&(text.length>=12&&text.split(/\s+/).length>=3||(text.match(/\p{Script=Han}/gu)?.length??0)>=6)&&!header.test(text)&&!/^(?:untitled|main|paper|official|template|microsoft word)\b/i.test(text);}

export const MAX_INDEXED_PDF_BYTES=32*1024*1024;
const TITLE_RANGE_CHUNK=64*1024;

/** Bound title-only I/O for large PDFs; text extraction keeps its existing size limit. */
export async function pdfTitleFromFile(filename:string):Promise<string|undefined>{
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const {size}=await handle.stat();
  if(!Number.isSafeInteger(size)||size<1)return;
  const {PDFDataRangeTransport}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  let remaining=MAX_INDEXED_PDF_BYTES,stopped=false;
  let fail!:(error:unknown)=>void;
  const failed=new Promise<never>((_,reject)=>{fail=reject;});
  class FileRanges extends PDFDataRangeTransport{
   override requestDataRange(begin:number,end:number){
    if(stopped)return;
    const length=end-begin;
    if(begin<0||end>size||length<=0||length>remaining){stopped=true;fail(Error('PDF title read budget exceeded'));return;}
    remaining-=length;
    void (async()=>{
     const bytes=new Uint8Array(length);
     for(let offset=0;offset<length;){
      const {bytesRead}=await handle.read(bytes,offset,length-offset,begin+offset);
      if(!bytesRead)throw Error('PDF changed during title read');
      offset+=bytesRead;
     }
     if(!stopped)this.onDataRange(begin,bytes);
    })().catch(error=>{stopped=true;fail(error);});
   }
   override abort(){stopped=true;}
  }
  return await readTitle({range:new FileRanges(size,new Uint8Array(),true),rangeChunkSize:TITLE_RANGE_CHUNK,disableStream:true,disableAutoFetch:true},failed);
 }finally{await handle.close();}
}

/** Read embedded metadata and the first-page heading without an upstream model. */
export async function pdfTitle(bytes:Uint8Array):Promise<string|undefined>{
 return readTitle({data:new Uint8Array(bytes)});
}

async function readTitle(input:DocumentInitParameters,failed?:Promise<never>):Promise<string|undefined>{
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const loading=getDocument({...input,disableFontFace:true,useSystemFonts:false,verbosity:0});
 const wait=<T>(value:Promise<T>)=>failed?Promise.race([value,failed]):value;
 try{
  const pdf=await wait(loading.promise),page=await wait(pdf.getPage(1));
  try{
   const content=await wait(page.getTextContent());
   const items=content.items.filter(item=>'str'in item&&item.str.trim()&&Math.abs(item.transform[0])>=Math.abs(item.transform[1]));
   const plain=items.map(item=>'str'in item?item.str:'').join(' ');
   const metadata=await wait(pdf.getMetadata());
   const embedded=typeof (metadata.info as {Title?:unknown}).Title==='string'?(metadata.info as {Title:string}).Title.replace(/\s+/g,' ').trim():'';
   if(validTitle(embedded)&&normalize(plain).includes(normalize(embedded)))return embedded;
   const lines:Array<{text:string;y:number;size:number;x:number}>=[];
   for(const item of items){
    if(!('str'in item))continue;
    const y=item.transform[5],size=Math.abs(item.height)||Math.hypot(item.transform[2],item.transform[3]);
    let line=lines.find(line=>Math.abs(line.y-y)<Math.max(2,size*.25));
    if(!line){line={text:'',y,size,x:item.transform[4]};lines.push(line);}
    line.text+=(line.text?' ':'')+item.str;line.size=Math.max(line.size,size);
   }
   lines.sort((a,b)=>b.y-a.y);
   const top=page.getViewport({scale:1}).height;
   const candidates=lines.filter(line=>line.y>top*.52&&!header.test(line.text.trim())&&line.text.trim().length>3);
   const largest=Math.max(...candidates.map(line=>line.size));
   if(!Number.isFinite(largest)||largest<11)return;
   const start=candidates.findIndex(line=>line.size>=largest*.96);
   const selected=[candidates[start]];
   for(const line of candidates.slice(start+1)){
    if(line.size<largest*.88||selected.at(-1)!.y-line.y>largest*2.5)break;
    selected.push(line);
   }
   const title=selected.map(line=>line.text.trim()).join(' ').replace(/\s+/g,' ').trim();
   return validTitle(title)?title:undefined;
  }finally{page.cleanup();}
 }catch{return undefined;}
 finally{await loading.destroy().catch(()=>{});}
}

/** OCR title blocks supplement image-only PDFs after their first successful parse. */
export function layoutTitle(layout:DocumentLayout):string|undefined{
 for(const block of layout.pages[0]?.layouts??[]){
  if(block.type!=='title'||typeof block.text!=='string')continue;
  const title=block.text.replace(/^#+\s*/,'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
  if(validTitle(title))return title;
 }
}
