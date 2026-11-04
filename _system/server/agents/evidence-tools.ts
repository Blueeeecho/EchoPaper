import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { BuildService } from '../../shared/types';
import { HttpError } from '../security';
import { checkAbort } from './model-gateway';

const decodeXml=(text:string)=>text.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
const tag=(xml:string,name:string)=>decodeXml(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i').exec(xml)?.[1]||'');
const sourceStates=new WeakMap<typeof fetch,Map<string,{tail:Promise<void>;lastStarted:number}>>();
export interface ReferenceVerification {status:'unverified'|'candidates'|'metadata_found';source:string;checkedAt?:string;reason?:string;boundary?:string;entry?:unknown;entries?:unknown[];cached?:boolean}
const caches=new WeakMap<typeof fetch,Map<string,{at:number;value:ReferenceVerification}>>();
const pause=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('已取消来源请求。','AbortError'));},timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
async function sourceSlot<T>(source:string,upstream:typeof fetch,signal:AbortSignal,work:()=>Promise<T>):Promise<T>{let states=sourceStates.get(upstream);if(!states){states=new Map();sourceStates.set(upstream,states);}let state=states.get(source);if(!state){state={tail:Promise.resolve(),lastStarted:0};states.set(source,state);}const previous=state.tail;let release!:()=>void;state.tail=new Promise<void>(resolve=>release=resolve);let acquired=false,abort:(()=>void)|undefined;
 try{await Promise.race([previous,new Promise<never>((_,reject)=>{abort=()=>reject(new DOMException('已取消排队请求。','AbortError'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);acquired=true;checkAbort(signal);const delay=source==='arxiv'?Math.max(0,state.lastStarted+3000-Date.now()):0;if(delay)await pause(delay,signal);checkAbort(signal);state.lastStarted=Date.now();return await work();}finally{if(abort)signal.removeEventListener('abort',abort);if(acquired)release();else void previous.then(release,release);}}
async function limitedText(response:Response,limit:number){if(!response.body)return'';const reader=response.body.getReader(),decoder=new TextDecoder();let result='',bytes=0;try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>limit)throw Error('来源响应超过大小限制。');result+=decoder.decode(chunk.value,{stream:true});}return result+decoder.decode();}finally{await reader.cancel().catch(()=>{});}}
export async function verifyReference(args:{doi?:string;arxivId?:string;title?:string},signal:AbortSignal,upstream:typeof fetch=fetch):Promise<ReferenceVerification> {
 const supplied=[args.doi,args.arxivId,args.title].filter(Boolean);if(supplied.length!==1)throw new HttpError(400,'请提供 DOI、arXiv 编号或标题中的一项。');
 let url:URL;
 if(args.doi){const doi=args.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').trim();if(!/^10\.\d{4,9}\/[^\s<>]{1,500}$/i.test(doi))throw new HttpError(400,'DOI 格式无效。');url=new URL('https://api.crossref.org/works/'+encodeURIComponent(doi));}
 else if(args.arxivId){const id=args.arxivId.replace(/^https?:\/\/arxiv\.org\/abs\//,'').trim();if(!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/.test(id))throw new HttpError(400,'arXiv 编号无效。');url=new URL('https://export.arxiv.org/api/query');url.searchParams.set('id_list',id);}
 else{if(!args.title||args.title.length>500)throw new HttpError(400,'标题无效或过长。');url=new URL('https://api.crossref.org/works');url.searchParams.set('query.title',args.title);url.searchParams.set('rows','5');}
 let cache=caches.get(upstream);if(!cache){cache=new Map();caches.set(upstream,cache);}const cached=cache.get(url.href);if(cached&&Date.now()-cached.at<6*60*60*1000)return{...cached.value,cached:true};
 return sourceSlot(args.arxivId?'arxiv':'crossref',upstream,signal,async()=>{
 const second=cache!.get(url.href);if(second&&Date.now()-second.at<6*60*60*1000)return{...second.value,cached:true};
 const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});const timeout=setTimeout(abort,20000);timeout.unref();
 try{checkAbort(signal);const response=await upstream(url,{signal:controller.signal,redirect:'error',headers:{Accept:args.arxivId?'application/atom+xml':'application/json'}});if(response.status===404)return{status:'unverified',source:url.href,checkedAt:new Date().toISOString(),reason:'来源未找到匹配记录；不代表文献不存在。'};if(!response.ok)throw Error(`来源返回 HTTP ${response.status}`);
  const raw=await limitedText(response,2*1024*1024);
  if(args.arxivId){const entry=/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/i.exec(raw)?.[1];if(!entry||/api\/errors/.test(tag(entry,'id')))return{status:'unverified',source:url.href,reason:'未获得可核实的 arXiv 条目。'};const result:ReferenceVerification={status:'metadata_found',source:url.href,checkedAt:new Date().toISOString(),entry:{url:tag(entry,'id'),title:tag(entry,'title'),authors:[...entry.matchAll(/<author>([\s\S]*?)<\/author>/gi)].map(match=>tag(match[1],'name')),published:tag(entry,'published'),updated:tag(entry,'updated')},boundary:'仅核实条目元数据，尚未证明其内容支持论文中的具体论断。'};cache!.set(url.href,{at:Date.now(),value:result});return result;}
  const data=JSON.parse(raw),entries=args.title?data.message?.items:[data.message];if(!Array.isArray(entries)||!entries.length)return{status:'unverified',source:url.href,reason:'没有匹配的来源记录。'};
  const result:ReferenceVerification={status:args.title?'candidates':'metadata_found',source:url.href,checkedAt:new Date().toISOString(),entries:entries.slice(0,5).map((entry:any)=>({doi:entry.DOI,title:entry.title?.[0]||'',authors:(entry.author||[]).map((author:any)=>[author.given,author.family].filter(Boolean).join(' ')),year:entry.published?.['date-parts']?.[0]?.[0],venue:entry['container-title']?.[0],url:entry.URL})),boundary:args.title?'标题搜索返回候选，不自动认定同一文献；须核对标题、作者与年份。':'仅核实条目元数据，尚未证明其内容支持论文中的具体论断。'};if(cache!.size>1000)cache!.delete(cache!.keys().next().value!);cache!.set(url.href,{at:Date.now(),value:result});return result;
 }catch(error){checkAbort(signal);return{status:'unverified',source:url.href,checkedAt:new Date().toISOString(),reason:`核验覆盖失败：${String((error as Error).message).slice(0,300)}`};}
 finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);controller.abort();}
 });
}

export async function inspectBuildPdf(projectId:string,targetId:string,builds:BuildService,buildId?:string,signal?:AbortSignal) {
 const build=buildId?await builds.get(buildId):(await builds.list(projectId)).filter(item=>item.targetId===targetId&&item.status==='succeeded'&&item.pdf).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
 if(!build||build.projectId!==projectId||build.targetId!==targetId||build.status!=='succeeded'||!build.pdf)throw new HttpError(404,'未找到该项目目标的成功 PDF 构建。');
 const filename=await builds.artifact(build.id,build.pdf);if((await fs.stat(filename)).size>50*1024*1024)throw new HttpError(413,'PDF 超过 50 MB 检查上限。');
 const bytes=await fs.readFile(filename),pdf=await PDFDocument.load(bytes,{updateMetadata:false});const pages=pdf.getPages().slice(0,500).map((page,index)=>({page:index+1,widthPt:page.getWidth(),heightPt:page.getHeight(),rotation:page.getRotation().angle,textBoundary:null as null|{left:number;top:number;right:number;bottom:number;items:number},overflowText:[] as {text:string;left:number;top:number;right:number;bottom:number}[],overflowCount:0}));
 const{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),fontRoot=path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),'standard_fonts')+path.sep,loading=getDocument({data:new Uint8Array(bytes),disableFontFace:true,useSystemFonts:false,standardFontDataUrl:fontRoot});const abort=()=>void loading.destroy();signal?.addEventListener('abort',abort,{once:true});
 try{if(signal)checkAbort(signal);const document=await loading.promise;
  for(const pageInfo of pages){if(signal)checkAbort(signal);const page=await document.getPage(pageInfo.page),viewport=page.getViewport({scale:1}),content=await page.getTextContent();let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,count=0;
   for(const item of content.items.slice(0,50000)){if(!('str'in item)||!item.str.trim())continue;const[a,b,c,d,e,f]=item.transform,ux=Math.hypot(a,b),vy=Math.hypot(c,d);if(!ux||!vy)continue;const style=content.styles[item.fontName],ascent=style?.ascent??0.8,descent=style?.descent??-0.2;
    const corners=[[0,descent*vy],[item.width,descent*vy],[0,ascent*vy],[item.width,ascent*vy]].map(([x,y])=>viewport.convertToViewportPoint(e+a/ux*x+c/vy*y,f+b/ux*x+d/vy*y)),xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);const box={left:Math.min(...xs),top:Math.min(...ys),right:Math.max(...xs),bottom:Math.max(...ys)};left=Math.min(left,box.left);top=Math.min(top,box.top);right=Math.max(right,box.right);bottom=Math.max(bottom,box.bottom);count++;
    if(box.left < -1||box.top < -1||box.right>viewport.width+1||box.bottom>viewport.height+1){pageInfo.overflowCount++;if(pageInfo.overflowText.length<20)pageInfo.overflowText.push({text:item.str.slice(0,180),...box});}
   }if(count)pageInfo.textBoundary={left,top,right,bottom,items:count};page.cleanup();
  }
  return{buildId:build.id,sourceHash:build.sourceHash,stale:!!build.stale,pageCount:pdf.getPageCount(),pages,metadata:{title:pdf.getTitle(),author:pdf.getAuthor(),producer:pdf.getProducer()},boundary:'文字边界为基于 PDF 文字矩阵的几何检查，仅提示超出页面的文字；不证明字体、栏宽、图形溢出、视觉排版或会议要求已经通过。'};
 }finally{signal?.removeEventListener('abort',abort);await loading.destroy().catch(()=>{});}
}
