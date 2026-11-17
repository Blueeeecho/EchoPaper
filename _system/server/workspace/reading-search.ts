import fs from 'node:fs/promises';
import {DOMParser} from '@xmldom/xmldom';
import {buildBilingualDocument,type DocumentLayout} from '../../shared/bilingual';
import {textFingerprint} from '../../shared/bilingual-cache';
import type {ResourceSearchMatch} from '../../shared/workspace-types';
import {assertNoSymlinks} from '../security';
import {atomicWrite,withLock} from '../storage';
import type {IndexedResource} from './catalog';

interface SearchBlock {text:string;page:number;translations?:string[]}
interface SearchDocument {version:2;resourceId:string;sourceHash:string;layoutStamp:string;translationStamp:string;blocks:SearchBlock[]}
interface SearchPassage {text:string;normalized:string;source:'ocr'|'translation';page:number}
interface CachedDocument {stamp:string;document:SearchDocument;passages:SearchPassage[];normalized:string}
const safeId=/^[a-zA-Z0-9_-]{1,100}$/;
function validDocument(value:SearchDocument|null):value is SearchDocument{
 return !!value&&value.version===2&&typeof value.resourceId==='string'&&typeof value.sourceHash==='string'
  &&typeof value.layoutStamp==='string'&&typeof value.translationStamp==='string'&&Array.isArray(value.blocks)
  &&value.blocks.every(block=>typeof block.text==='string'&&Number.isSafeInteger(block.page)&&block.page>0
   &&(block.translations===undefined||Array.isArray(block.translations)&&block.translations.every(text=>typeof text==='string')));
}
const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
export const searchTerms=(query:string)=>[...new Set(normalize(query).split(' ').filter(Boolean))];
const file=async(root:string,id:string,kind:'layout'|'translation'|'search')=>{
 if(!safeId.test(id))throw Error('资料ID无效。');
 const relative=kind==='search'?`workspace/reading-search/${id}.json`:`workspace/reading-layout/${id}${kind==='translation'?'.translations':''}.json`;
 return assertNoSymlinks(root,relative,true);
};
async function stamp(filename:string){try{const stat=await fs.stat(filename);return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;}catch(error:any){if(error.code==='ENOENT')return '';throw error;}}
async function readJson<T>(filename:string):Promise<T|null>{try{return JSON.parse(await fs.readFile(filename,'utf8'));}catch(error:any){if(error.code==='ENOENT')return null;throw error;}}
function tableText(html:string):string{
 if(!html)return '';
 const separated=html.replace(/<\/?(?:td|th|tr)\b[^>]*>/gi,' ');
 try{return new DOMParser({onError:()=>{}}).parseFromString(separated,'text/html').documentElement?.textContent??'';}
 catch{return separated.replace(/<[^>]*>/g,' ');}
}

/** Store text and page anchors separately from the large OCR image payloads. */
export async function refreshReadingSearch(root:string,id:string,input:{layout?:DocumentLayout;translations?:Record<string,string>}={}):Promise<SearchDocument|null>{
 return withLock(`reading-search:${root}:${id}`,async()=>{
  const layoutFile=await file(root,id,'layout'),translationFile=await file(root,id,'translation'),searchFile=await file(root,id,'search');
  const [layoutStamp,translationStamp]=await Promise.all([stamp(layoutFile),stamp(translationFile)]);
  if(!layoutStamp){await fs.rm(searchFile,{force:true});return null;}
  const candidate=await readJson<SearchDocument>(searchFile).catch(()=>null),previous=validDocument(candidate)&&candidate.resourceId===id?candidate:null;
  if(!input.layout&&!input.translations&&previous&&previous.layoutStamp===layoutStamp&&previous.translationStamp===translationStamp)return previous;
  let blocks:SearchBlock[],sourceHash:string;
  if(!input.layout&&previous&&previous.layoutStamp===layoutStamp){blocks=previous.blocks.map(({text,page})=>({text,page}));sourceHash=previous.sourceHash;}
  else{
   const layout=input.layout??await readJson<DocumentLayout>(layoutFile);
   if(!layout||layout.version!==1||layout.resourceId!==id||!Array.isArray(layout.pages))return null;
   sourceHash=layout.sourceHash;
   blocks=buildBilingualDocument(layout,{translateAppendix:true}).blocks
    .map(block=>({text:block.text||tableText(block.tableHtml??''),page:block.page+1}))
    .filter(block=>block.text.trim());
  }
  const translations=input.translations??await readJson<Record<string,string>>(translationFile).catch(()=>null)??{};
  const index=new Map<string,Set<string>>();
  for(const [key,value] of Object.entries(translations)){
   if(typeof value!=='string'||!value.trim())continue;
   const separator=key.indexOf('|',key.indexOf('|')+1),fingerprint=key.slice(separator+1);
   if(separator<0||!fingerprint.startsWith('zh-CN|'))continue;
   const values=index.get(fingerprint)??new Set<string>();values.add(value);index.set(fingerprint,values);
  }
  for(const block of blocks){const translated=index.get(textFingerprint('zh-CN',block.text));if(translated)block.translations=[...translated];}
  const [latestLayout,latestTranslation]=await Promise.all([stamp(layoutFile),stamp(translationFile)]);
  if(latestLayout!==layoutStamp||latestTranslation!==translationStamp)return null;
  const document:SearchDocument={version:2,resourceId:id,sourceHash,layoutStamp,translationStamp,blocks};
  await atomicWrite(searchFile,JSON.stringify(document));
  return document;
 });
}
export async function removeReadingSearch(root:string,id:string){await withLock(`reading-search:${root}:${id}`,async()=>fs.rm(await file(root,id,'search'),{force:true}));}

function excerpt(text:string,terms:string[]):string{
 const plain=text.replace(/\s+/g,' ').trim(),lower=normalize(plain);
 const positions=terms.map(term=>lower.indexOf(term)).filter(position=>position>=0);
 const position=positions.length?Math.min(...positions):0,start=Math.max(0,position-55),end=Math.min(plain.length,start+220);
 return `${start?'…':''}${plain.slice(start,end)}${end<plain.length?'…':''}`;
}
const allTerms=(text:string,terms:string[])=>terms.every(term=>text.includes(term));

export function createReadingSearch(root:string){
 const cache=new Map<string,CachedDocument>();
 let closed=false;
 async function document(resource:IndexedResource):Promise<CachedDocument|undefined>{
  if(resource.missing||resource.kind!=='file'||!/\.pdf$/i.test(resource.name)||!safeId.test(resource.id))return;
  const [layoutFile,translationFile,searchFile]=await Promise.all([file(root,resource.id,'layout'),file(root,resource.id,'translation'),file(root,resource.id,'search')]);
  const [layoutStamp,translationStamp,searchStamp]=await Promise.all([stamp(layoutFile),stamp(translationFile),stamp(searchFile)]);
  const signature=`${layoutStamp}|${translationStamp}|${searchStamp}`;
  const existing=cache.get(resource.id);
  if(existing?.stamp===signature)return existing.document.sourceHash===resource.hash?existing:undefined;
  let value=searchStamp?await readJson<SearchDocument>(searchFile).catch(()=>null):null;
  if(!validDocument(value)||value.resourceId!==resource.id||value.layoutStamp!==layoutStamp||value.translationStamp!==translationStamp)value=await refreshReadingSearch(root,resource.id);
  if(!value||value.sourceHash!==resource.hash){cache.delete(resource.id);return;}
  const passages:SearchPassage[]=value.blocks.flatMap(block=>[
   {text:block.text,normalized:normalize(block.text),source:'ocr' as const,page:block.page},
   ...(block.translations??[]).map(text=>({text,normalized:normalize(text),source:'translation' as const,page:block.page})),
  ]);
  const result:CachedDocument={stamp:`${layoutStamp}|${translationStamp}|${await stamp(searchFile)}`,document:value,passages,normalized:passages.map(passage=>passage.normalized).join(' ')};
  cache.set(resource.id,result);return result;
 }
 async function match(resource:IndexedResource,terms:string[]):Promise<ResourceSearchMatch|undefined>{
  const metadata=[resource.title??'',resource.name,resource.path,...resource.tags].join(' '),text=resource.text??'';
  if(allTerms(normalize(metadata),terms))return {source:'metadata',snippet:excerpt(metadata,terms),terms};
  let indexed:CachedDocument|undefined;
  try{indexed=await document(resource);}catch{/* A damaged OCR cache does not prevent searching other documents. */}
  if(!allTerms(`${normalize(metadata)} ${normalize(text)} ${indexed?.normalized??''}`,terms))return;
  const passage=indexed?.passages.map(passage=>({passage,hits:terms.filter(term=>passage.normalized.includes(term)).length})).sort((a,b)=>b.hits-a.hits)[0];
  if(passage?.hits)return {source:passage.passage.source,snippet:excerpt(passage.passage.text,terms),page:passage.passage.page,terms};
  return {source:'text',snippet:excerpt(text,terms),terms};
 }
 async function find(resources:IndexedResource[],query:string){
  const terms=searchTerms(query),matches=new Map<string,ResourceSearchMatch>();
  for(let offset=0;offset<resources.length;offset+=4){
   if(closed)break;
   const results=await Promise.all(resources.slice(offset,offset+4).map(async resource=>({id:resource.id,match:await match(resource,terms)})));
   for(const result of results)if(result.match)matches.set(result.id,result.match);
  }
  return matches;
 }
 let warming:Promise<void>|undefined;
 function warm(resources:IndexedResource[]){
  warming=(async()=>{for(let offset=0;offset<resources.length&&!closed;offset+=2)await Promise.all(resources.slice(offset,offset+2).map(resource=>document(resource).catch(()=>undefined)));})();
 }
 return {find,warm,async close(){closed=true;await warming;cache.clear();}};
}
