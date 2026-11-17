/**
 * 文档版面解析：把 PDF 交给百度「文档解析（Unlimited-OCR）」，取回带类型和坐标的版面元素。
 *
 * 只取版面，不做翻译：翻译仍走读者自己配置的翻译来源。解析结果按资料的内容哈希缓存，
 * 同一份 PDF 只解析一次，不重复消耗额度；接口返回的结果链接 30 天过期，因此图片一并落盘。
 */
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import {HttpError,assertNoSymlinks} from '../security';
import {atomicWrite,withLock} from '../storage';
import type {DocumentLayout,LayoutElement,LayoutImage,LayoutPage,LayoutTable} from '../../shared/bilingual';
import {refreshReadingSearch,removeReadingSearch} from './reading-search';

export const PARSE_PROVIDER='baidu-doc-parse';
export const PARSE_BASE_URL='https://aip.baidubce.com';
const TOKEN=PARSE_BASE_URL+'/oauth/2.0/token';
/**
 * 可选的解析引擎。两者都在 aip.baidubce.com 上、同一套异步流程与鉴权，
 * 额度各自独立，因此一个用完可以切到另一个。
 */
export interface ParseEngine{id:string;label:string;path:string;note:string;kind:'baidu-cloud'|'aistudio';
 /** 额度按月还是按天刷新，决定提醒与自动切换看哪个计数。 */
 period:'month'|'day'}
export const PARSE_ENGINES:ParseEngine[]=[
 {id:'unlimited-ocr',kind:'baidu-cloud',period:'month',label:'文档解析（Unlimited-OCR）',path:'/rest/2.0/brain/online/v2/unlimited-ocr-parser/task',note:'智能云的文档解析，每月额度，长文档跨页表格与段落更完整。'},
 {id:'aistudio-vl',kind:'aistudio',period:'day',label:'PaddleOCR 官方 API（AI Studio）',path:'/api/v2/ocr/jobs',note:'星河社区的 PaddleOCR-VL，每天两万页额度，与智能云各自独立。'},
];
/** AI Studio（星河社区）的 PaddleOCR 服务：固定地址，凭据只有一个访问令牌。 */
export const AISTUDIO_PROVIDER='aistudio-paddleocr';
export const AISTUDIO_BASE_URL='https://paddleocr.aistudio-app.com';
export const AISTUDIO_MODEL='PaddleOCR-VL-1.6';
export const parseEngine=(id?:string):ParseEngine=>PARSE_ENGINES.find(e=>e.id===id)??PARSE_ENGINES[0];
const submitUrl=(engine:ParseEngine)=>PARSE_BASE_URL+engine.path;
const queryUrl=(engine:ParseEngine)=>PARSE_BASE_URL+engine.path+'/query';
/** 接口要求超过 50MB 改用 file_url；本机资料直接内联提交。 */
const MAX_BYTES=50*1024*1024;
const MAX_PAGES=500;
/** 提交与查询都限 2 QPS，这里按 5 秒起、最多 10 秒退避轮询。 */
const FIRST_POLL_MS=5000,MAX_POLL_MS=10000,PARSE_TIMEOUT_MS=20*60*1000;

const ERROR_HINTS:Record<string,string>={
 '23':'这把密钥没有「文档解析」的调用权限：请确认已在百度智能云开通「文档解析（Unlimited-OCR）」，并且创建 API Key 时「服务」选了「AI开放能力」；也可以改填应用的 API Key 与 Secret Key（用英文冒号分隔）。',
 '4':'集群超限额，请稍后重试。','6':'没有调用权限：请确认已在百度智能云开通「文档解析（Unlimited-OCR）」。',
 '14':'鉴权失败：请确认 API Key 正确，且创建时服务范围勾选了「AI开放能力」。','17':'今日调用量已用完。',
 '18':'调用过于频繁（该接口限 2 QPS），请稍后重试。','19':'免费额度已用完，且未开通按量付费。',
 '100':'鉴权参数无效。','110':'凭据无效。','111':'凭据已过期。',
};

export class ParseError extends HttpError{
 constructor(public code:string,message:string){super(code==='14'||code==='110'||code==='111'?503:code==='18'?429:502,`文档解析失败（${code}）：${message}${ERROR_HINTS[code]?' '+ERROR_HINTS[code]:''}`,undefined,true);}
}

/** 凭据只经 stdin 进出钥匙串，不出现在参数、日志或配置文件里。 */
export function parsingKeychain(value?:string,provider=PARSE_PROVIDER,url=PARSE_BASE_URL):Promise<string>{
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/python3',[fileURLToPath(new URL('../../scripts/provider-keychain.py',import.meta.url)),value===undefined?'read':'write',provider,url],{stdio:['pipe','pipe','pipe']});
  let output='',bytes=0;
  const timer=setTimeout(()=>{child.kill();reject(Error('钥匙串操作超时。'));},15000);
  child.stdout.on('data',part=>{bytes+=part.length;if(bytes>16384){child.kill();return;}output+=part;});
  child.stderr.resume();
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve(value===undefined?output.trim():''):reject(Error('无法读写 macOS 钥匙串，请确认钥匙串已解锁。'));});
  child.stdin.on('error',()=>{});
  child.stdin.end(value===undefined?'':value);
 });
}

export interface ParseDeps{fetch?:typeof fetch;readKey?:(engine:ParseEngine)=>Promise<string>;sleep?:(ms:number)=>Promise<void>;
 onProgress?:(completedPages:number)=>void;
 onBackpressure?:()=>void;
 /** 诊断用：拿到上游原始结果的第一行，便于核对不同引擎的字段。 */
 onSample?:(engineId:string,text:string)=>void;
 /** 解析过程中的进度与降级说明，写进运行日志。 */
 log?:(message:string)=>void}
export const readCredential=(engine:ParseEngine,deps:ParseDeps):Promise<string>=>deps.readKey?deps.readKey(engine)
 : engine.kind==='aistudio'?parsingKeychain(undefined,AISTUDIO_PROVIDER,AISTUDIO_BASE_URL):parsingKeychain();

/**
 * 两种鉴权二选一，不能混用：
 * - IAM API Key（bce-v3/…）：放在 Authorization 头里，创建时服务范围需含「AI开放能力」。
 * - 应用的 API Key 与 Secret Key（写成 AK:SK）：换取 access_token 后作为查询参数。
 */
export interface Authorization{headers:Record<string,string>;query:string}
const tokenCache=new Map<string,{token:string;expires:number}>();
export async function authorize(credential:string,upstream:typeof fetch,signal:AbortSignal):Promise<Authorization>{
 const value=credential.trim();
 if(!value)throw new HttpError(503,'尚未配置文档解析密钥。');
 if(!value.includes(':')||value.startsWith('bce-v3/'))return {headers:{Authorization:`Bearer ${value}`},query:''};
 const at=value.indexOf(':'),ak=value.slice(0,at).trim(),sk=value.slice(at+1).trim();
 if(!ak||!sk)throw new HttpError(400,'AK:SK 格式无效，请填写「应用 API Key:Secret Key」。');
 const cached=tokenCache.get(value);
 if(cached&&cached.expires>Date.now())return {headers:{},query:`?access_token=${encodeURIComponent(cached.token)}`};
 const response=await upstream(`${TOKEN}?grant_type=client_credentials&client_id=${encodeURIComponent(ak)}&client_secret=${encodeURIComponent(sk)}`,{method:'POST',redirect:'error',signal});
 const data=await response.json().catch(()=>({})) as any;
 if(!response.ok||!data?.access_token)throw new HttpError(503,`换取 access_token 失败：${String(data?.error_description??data?.error??`HTTP ${response.status}`)}`);
 const token=String(data.access_token);
 tokenCache.set(value,{token,expires:Date.now()+Math.max(60,Number(data.expires_in??2592000)-3600)*1000});
 return {headers:{},query:`?access_token=${encodeURIComponent(token)}`};
}

function post(upstream:typeof fetch,url:string,auth:Authorization,fields:Record<string,string>,signal:AbortSignal){
 return upstream(url+auth.query,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/x-www-form-urlencoded',...auth.headers},body:new URLSearchParams(fields).toString()});
}

/** 轻量探活：用一个不存在的任务号验证凭据，不解析文档、不消耗页数额度。 */
export async function probeCredential(deps:ParseDeps,signal:AbortSignal,engineId?:string):Promise<{ok:boolean;message:string}>{
 const upstream=deps.fetch??fetch;
 const engine=parseEngine(engineId);
 const credential=(await readCredential(engine,deps).catch(()=>'')).trim();
 if(!credential)return {ok:false,message:'尚未配置密钥。'};
 try{
  if(engine.kind==='aistudio')return await probeAiStudio(credential,upstream,signal);
  const auth=await authorize(credential,upstream,signal);
  await result(await post(upstream,queryUrl(engine),auth,{task_id:'echopaper-probe'},signal));
  return {ok:true,message:'凭据可用。'};
 }catch(error){
  const code=error instanceof ParseError?error.code:'';
  // 任务号不存在说明鉴权已通过，正是我们要的结果。
  if(code&&!['14','23','100','110','111','6','17','19'].includes(code))return {ok:true,message:`凭据可用（探测返回 ${code}）。`};
  return {ok:false,message:error instanceof Error?error.message:'凭据校验失败。'};
 }
}
async function result(response:Response):Promise<any>{
 if(!response.ok)throw new HttpError(response.status===429?429:502,`文档解析服务返回 ${response.status}。`);
 const data=await response.json().catch(()=>({}));
 const code=String(data?.error_code??'0');
 if(code!=='0'&&code!=='undefined')throw new ParseError(code,String(data?.error_msg??'接口未说明原因'));
 return data?.result??{};
}

/** 提交一份 PDF 并等待解析完成，返回接口原始的分页版面数据。 */
export async function parseDocument(file:Buffer,name:string,deps:ParseDeps,signal:AbortSignal,engineId?:string):Promise<{pages:LayoutPage[];costPages:number}>{
 const engine=parseEngine(engineId);
 if(file.byteLength>MAX_BYTES)throw new HttpError(413,'文件超过 50MB，文档解析接口要求改用链接提交，当前尚未支持。');
 const upstream=deps.fetch??fetch,sleep=deps.sleep??((ms:number)=>delay(ms,undefined,{signal,ref:false}));
 const credential=(await readCredential(engine,deps).catch(()=>''))?.trim();
 if(!credential)throw new HttpError(503,`尚未配置${engine.kind==='aistudio'?' AI Studio 访问令牌':'文档解析密钥'}，请在阅读器的「全文对照」中填写。`,undefined,true);
 if(engine.kind==='aistudio')return await parseAiStudio(file,name,credential,engine,upstream,sleep,signal,deps.onSample,deps.log,deps.onProgress,deps.onBackpressure);
 const auth=await authorize(credential,upstream,signal);
 const submitted=await result(await post(upstream,submitUrl(engine),auth,{file_data:file.toString('base64'),file_name:name},signal));
 const taskId=String(submitted?.task_id??'');
 if(!taskId)throw new HttpError(502,'文档解析服务未返回任务编号。');
 const started=Date.now();
 await sleep(FIRST_POLL_MS);
 for(let wait=4000;;wait=Math.min(wait*1.3,MAX_POLL_MS)){
  if(signal.aborted)throw new HttpError(499,'解析已取消。');
  const task=await result(await post(upstream,queryUrl(engine),auth,{task_id:taskId},signal));
  const status=String(task?.status??'');
  if(status==='success'){
   const url=String(task?.parse_result_url??'');
   if(!url)throw new HttpError(502,'文档解析完成但未返回结果地址。');
   const payload=await upstream(url,{redirect:'error',signal});
   if(!payload.ok)throw new HttpError(502,`下载解析结果失败（HTTP ${payload.status}）。`);
   const parsed=await payload.json().catch(()=>null) as {pages?:LayoutPage[]}|null;
   if(!parsed||!Array.isArray(parsed.pages))throw new HttpError(502,'解析结果格式无法识别。');
   return {pages:parsed.pages,costPages:Number(task?.cost_page_num??parsed.pages.length)||parsed.pages.length};
  }
  if(status==='failed')throw new HttpError(502,`文档解析失败：${String(task?.task_error??'接口未说明原因')}`);
  if(Date.now()-started>PARSE_TIMEOUT_MS)throw new HttpError(504,'文档解析超时；稍后可重新发起，已解析页数仍会计入额度。');
  await sleep(wait);
 }
}

/* ───────────────── AI Studio（星河社区）PaddleOCR ───────────────── */

/** 星河社区的任务接口与智能云完全不同：multipart 提交、data 包一层、结果是一行一页的 JSONL。 */
class AiStudioError extends HttpError{
 constructor(public upstream:number,status:number,message:string){super(status,message,undefined,true);}
}
async function aiStudioJson(upstream:typeof fetch,url:string,init:RequestInit,what:string):Promise<any>{
 const response=await upstream(url,{redirect:'error',...init});
 const body=await response.text();
 let data:any=null;try{data=JSON.parse(body);}catch{}
 if(!response.ok){
  const detail=String(data?.errorMsg??data?.msg??data?.message??(body.slice(0,200)||'接口未说明原因'));
  if(response.status===401||response.status===403)throw new AiStudioError(response.status,503,`AI Studio 访问令牌无效或无权调用：${detail}`);
  if(response.status===429)throw new AiStudioError(response.status,429,`AI Studio 调用过于频繁或额度已用完：${detail}`);
  if(response.status===408)throw new AiStudioError(408,504,`AI Studio ${what}超时（HTTP 408）：文件较大时上游会掐断上传。${detail}`);
  throw new AiStudioError(response.status,502,`AI Studio ${what}失败（HTTP ${response.status}）：${detail}`);
 }
 const code=Number(data?.errorCode??0);
 if(code)throw new AiStudioError(0,502,`AI Studio ${what}失败（${code}）：${String(data?.errorMsg??'接口未说明原因')}`);
 return data?.data??data??{};
}
const aiStudioAuth=(token:string)=>({Authorization:`bearer ${token}`});

/** 查一个不存在的任务号验证令牌，不提交文档、不消耗额度。 */
async function probeAiStudio(token:string,upstream:typeof fetch,signal:AbortSignal):Promise<{ok:boolean;message:string}>{
 const url=`${AISTUDIO_BASE_URL}/api/v2/ocr/jobs/echopaper-probe`;
 try{
  await aiStudioJson(upstream,url,{method:'GET',signal,headers:aiStudioAuth(token)},'任务查询');
  return {ok:true,message:'令牌可用。'};
 }catch(error){
  const message=error instanceof Error?error.message:'令牌校验失败。';
  // 任务号查不到说明鉴权已通过，正是我们要的结果；只有鉴权/额度类错误才算失败。
  if(/令牌无效|无权调用|额度/.test(message))return {ok:false,message};
  return {ok:true,message:'令牌可用（探测返回任务不存在）。'};
 }
}

/**
 * 可重试的上游失败：超时、5xx，以及接口自己说「稍后重试」的排队限制
 * （提交队列满时它返回 400，但那是暂时的）。鉴权、额度用尽和参数错误重试没有意义。
 */
const AISTUDIO_BUSY=/队列已满|稍后重试|请重试|too many|rate ?limit|busy|try again/i;
function aiStudioRetryable(error:unknown):boolean{
 if(!(error instanceof AiStudioError))return false;
 if(/额度|令牌无效|无权调用/.test(error.message))return false;
 return [408,429,500,502,503,504].includes(error.upstream)||AISTUDIO_BUSY.test(error.message);
}
/** 排队限制要等得起：5s 起步、翻倍、最多 60s。 */
const aiStudioBackoff=(attempt:number)=>Math.min(60000,5000*2**(attempt-1));
const AISTUDIO_ATTEMPTS=6;

/**
 * 整份提交时上游会对大文件返回 408，所以超过阈值就按页切块分批提交，
 * 再把各块的页按原顺序接起来。切块失败就退回整份提交，不让它直接失败。
 */
const AISTUDIO_CHUNK_BYTES=3*1024*1024;
async function aiStudioChunks(file:Buffer,log?:(message:string)=>void):Promise<Buffer[]>{
 if(file.byteLength<=AISTUDIO_CHUNK_BYTES)return [file];
 try{
  const {PDFDocument}=await import('pdf-lib');
  const source=await PDFDocument.load(file,{ignoreEncryption:true});
  const total=source.getPageCount();
  const per=Math.max(1,Math.min(total,Math.floor(total*AISTUDIO_CHUNK_BYTES/file.byteLength)));
  if(per>=total)return [file];
  const parts:Buffer[]=[];
  for(let at=0;at<total;at+=per){
   const part=await PDFDocument.create();
   for(const page of await part.copyPages(source,Array.from({length:Math.min(per,total-at)},(_,i)=>at+i)))part.addPage(page);
   parts.push(Buffer.from(await part.save()));
  }
  log?.(`文件 ${(file.byteLength/1048576).toFixed(1)}MB，已切成 ${parts.length} 块（每块 ${per} 页）分批提交。`);
  return parts;
 }catch(error){
  log?.(`按页切块失败，改为整份提交：${(error as Error).message}`);
  return [file];
 }
}

async function aiStudioSubmit(upstream:typeof fetch,jobs:string,token:string,part:Buffer,name:string,sleep:(ms:number)=>Promise<void>,signal:AbortSignal,log?:(message:string)=>void,onBackpressure?:()=>void):Promise<string>{
 for(let attempt=1;;attempt++){
  try{
   const form=new FormData();
   form.set('model',AISTUDIO_MODEL);
   // 方向判别与扭曲矫正会改动坐标，这里关掉；图表识别只在图里取数，对照阅读用不上。
   form.set('optionalPayload',JSON.stringify({useDocOrientationClassify:false,useDocUnwarping:false,useChartRecognition:false}));
   form.set('file',new Blob([new Uint8Array(part)],{type:'application/pdf'}),name.toLowerCase().endsWith('.pdf')?name:name+'.pdf');
   const submitted=await aiStudioJson(upstream,jobs,{method:'POST',signal,headers:aiStudioAuth(token),body:form},'任务提交');
   const jobId=String(submitted?.jobId??'');
   if(jobId)return jobId;
   throw new AiStudioError(0,502,'AI Studio 未返回任务编号。');
  }catch(error){
   if(error instanceof AiStudioError&&(error.upstream===503||/队列已满|too many|rate ?limit|busy/i.test(error.message)))onBackpressure?.();
   if(attempt>=AISTUDIO_ATTEMPTS||signal.aborted||!aiStudioRetryable(error))throw error;
   log?.(`AI Studio 提交未成功（第 ${attempt} 次）：${(error as Error).message} 等 ${Math.round(aiStudioBackoff(attempt)/1000)} 秒后重试。`);
   await sleep(aiStudioBackoff(attempt));
  }
 }
}

async function parseAiStudio(file:Buffer,name:string,token:string,engine:ParseEngine,upstream:typeof fetch,sleep:(ms:number)=>Promise<void>,signal:AbortSignal,onSample?:(engineId:string,text:string)=>void,log?:(message:string)=>void,onProgress?:(completedPages:number)=>void,onBackpressure?:()=>void):Promise<{pages:LayoutPage[];costPages:number}>{
 const jobs=AISTUDIO_BASE_URL+engine.path;
 const parts=await aiStudioChunks(file,log);
 const pages:LayoutPage[]=[];
 let costPages=0;
 const deadline=Date.now()+PARSE_TIMEOUT_MS;
 for(const [index,part] of parts.entries()){
  // 分块时上一块刚跑完就紧接着提交容易撞上提交队列上限，隔一下再提交。
  if(index)await sleep(3000);
  const jobId=await aiStudioSubmit(upstream,jobs,token,part,name,sleep,signal,log,onBackpressure);
  let soft=0;
  for(let first=true;;first=false){
   if(signal.aborted)throw new HttpError(499,'解析已取消。');
   await sleep(first?FIRST_POLL_MS:5000);
   let task:any;
   try{task=await aiStudioJson(upstream,`${jobs}/${encodeURIComponent(jobId)}`,{method:'GET',signal,headers:aiStudioAuth(token)},'任务查询');}
   catch(error){
    if(error instanceof AiStudioError&&error.upstream===503)onBackpressure?.();
    // 轮询期间的偶发抖动不该让整份解析失败，连续多次才放弃。
    if(++soft>AISTUDIO_ATTEMPTS||!aiStudioRetryable(error))throw error;
    continue;
   }
   soft=0;
   const extracted=Number(task?.extractProgress?.extractedPages);
   if(Number.isFinite(extracted)&&extracted>0)onProgress?.(pages.length+extracted);
   const state=String(task?.state??'');
   if(state==='failed'){
    const message=String(task?.errorMsg??'接口未说明原因');
    if(/(?:状态码\s*|HTTP\s*)50[03]|busy|overload/i.test(message))onBackpressure?.();
    throw new HttpError(502,`AI Studio 解析失败：${message}`,undefined,true);
   }
   if(state==='done'){
    const url=String(task?.resultUrl?.jsonUrl??'');
    if(!url)throw new HttpError(502,'AI Studio 解析完成但未返回结果地址。',undefined,true);
    const payload=await upstream(url,{redirect:'follow',signal});
    if(!payload.ok)throw new HttpError(502,`下载 AI Studio 解析结果失败（HTTP ${payload.status}）。`,undefined,true);
    const jsonl=await payload.text();
    if(!index)try{onSample?.(engine.id,jsonl.split('\n',1)[0]??'');}catch{/* 诊断失败不影响解析 */}
    const got=aiStudioPages(jsonl);
    // 分块提交时每块都从第一页算起，接起来要按总序重编页号。
    for(const page of got){page.page_num=pages.length+1;pages.push(page);}
    costPages+=Number(task?.extractProgress?.extractedPages)||got.length;
    onProgress?.(pages.length);
    break;
   }
   if(Date.now()>deadline)throw new HttpError(504,'AI Studio 解析超时；稍后可重新发起，已解析页数仍会计入额度。',undefined,true);
  }
  if(parts.length>1)log?.(`第 ${index+1}/${parts.length} 块已完成，累计 ${pages.length} 页。`);
 }
 if(!pages.length)throw new HttpError(502,'AI Studio 解析结果里没有可用的版面数据。',undefined,true);
 return {pages,costPages:costPages||pages.length};
}

/** JSONL 一行一批，每行 result.layoutParsingResults 里再按页排开。 */
export function aiStudioPages(jsonl:string):LayoutPage[]{
 const pages:LayoutPage[]=[];
 for(const line of jsonl.split('\n')){
  const text=line.trim();
  if(!text)continue;
  let parsed:any=null;try{parsed=JSON.parse(text);}catch{continue;}
  const list=parsed?.result?.layoutParsingResults??parsed?.layoutParsingResults;
  if(!Array.isArray(list))continue;
  for(const entry of list)pages.push(aiStudioPage(entry,pages.length+1));
 }
 return pages;
}

/** PaddleX 的版面标签 → 文档解析接口那套类型，让后续逻辑只认一套词表。 */
const AISTUDIO_LABELS:Record<string,string>={
 doc_title:'title',paragraph_title:'title',title:'title',abstract_title:'title',content_title:'title',
 text:'text',abstract:'text',content:'text',paragraph:'text',text_without_layout:'text',vertical_text:'text',
 table:'table',table_title:'table_caption',table_caption:'table_caption',table_footnote:'image_footnote',
 image:'image',figure:'image',chart:'chart',
 figure_title:'image_caption',image_caption:'image_caption',figure_caption:'image_caption',chart_title:'image_caption',
 figure_footnote:'image_footnote',image_footnote:'image_footnote',vision_footnote:'image_footnote',
 formula:'equation',equation:'equation',display_formula:'equation',inline_formula:'equation',
 formula_number:'equation',formula_caption:'equation',
 header:'header',header_image:'header',footer:'footer',footer_image:'footer',
 number:'page_number',page_number:'page_number',footnote:'page_footnote',
 reference:'ref_text',reference_content:'ref_text',references:'title',
 seal:'seal',stamp:'seal',algorithm:'algorithm',aside_text:'aside_text',
};
/** 标签会随模型版本增减，没收录的按词根归类，宁可少翻也不要把公式当正文翻掉。 */
function aiStudioType(label:string):string{
 const mapped=AISTUDIO_LABELS[label];
 if(mapped)return mapped;
 if(/formula|equation|math/.test(label))return 'equation';
 if(/algorithm|code/.test(label))return 'algorithm';
 if(/footnote/.test(label))return /figure|image|table|chart|vision/.test(label)?'image_footnote':'page_footnote';
 if(/caption|title/.test(label))return /figure|image|chart/.test(label)?'image_caption':/table/.test(label)?'table_caption':'title';
 if(/table/.test(label))return 'table';
 if(/chart/.test(label))return 'chart';
 if(/image|figure|photo|picture/.test(label))return 'image';
 if(/header/.test(label))return 'header';
 if(/footer/.test(label))return 'footer';
 if(/page.?num|^number$/.test(label))return 'page_number';
 if(/seal|stamp/.test(label))return 'seal';
 if(/reference|bibliograph/.test(label))return 'ref_text';
 return 'text';
}

function aiStudioPage(entry:any,index:number):LayoutPage{
 const pruned=entry?.prunedResult??entry?.pruned_result??{};
 const raw:any[]=Array.isArray(pruned?.parsing_res_list)?pruned.parsing_res_list:[];
 // block_order 是阅读顺序；图表页给的是 null，这时保持接口原始顺序。
 const blocks=raw.every(block=>typeof block?.block_order==='number'&&Number.isFinite(block.block_order))
  ?[...raw].sort((a,b)=>Number(a.block_order)-Number(b.block_order)):raw;
 const size=aiStudioPageSize(pruned);
 const layouts:LayoutElement[]=[],tables:LayoutTable[]=[],images:LayoutImage[]=[];
 blocks.forEach((block,at)=>{
  const label=String(block?.block_label??block?.label??'text').toLowerCase();
  const type=aiStudioType(label);
  const content=String(block?.block_content??block?.content??'').trim();
  const id=`p${index}-${at}`;
  const box=aiStudioRect(block?.block_bbox??block?.bbox??block?.coordinate);
  layouts.push({layout_id:id,type,text:type==='table'?'':content,...(box?{position:box}:{})});
  if(type==='table'&&content)tables.push({layout_id:id,table_html:content});
  if(box&&['image','chart','table'].includes(type)){
   const image=aiStudioBlockImage(entry?.markdown?.images,box);
   if(image)images.push({layout_id:id,data_url:image});
  }
 });
 return {page_num:Number(pruned?.page_index??index-1)+1,layouts,tables,images,meta:size};
}

/** 坐标统一成文档解析那套 [x,y,w,h]。 */
function aiStudioRect(raw:any):number[]|null{
 const box=Array.isArray(raw)&&raw.length===4?raw:null;
 if(!box||box.some(v=>typeof v!=='number'||!Number.isFinite(v)))return null;
 const [x1,y1,x2,y2]=box;
 if(x2<=x1||y2<=y1)return null;
 return [x1,y1,x2-x1,y2-y1];
}

/** Preserve the API's source dimensions. Content extents exclude page margins. */
function aiStudioPageSize(pruned:any):{page_width?:number;page_height?:number}{
 const width=Number(pruned?.page_width??pruned?.width),height=Number(pruned?.page_height??pruned?.height);
 if(Number.isFinite(width)&&Number.isFinite(height)&&width>1&&height>1)return {page_width:width,page_height:height};
 const shape=pruned?.input_img_shape??pruned?.image_shape;
 if(Array.isArray(shape)&&shape.length>=2){
  const [height,width]=shape.map(Number);
  if(Number.isFinite(width)&&Number.isFinite(height)&&width>1&&height>1)return {page_width:width,page_height:height};
 }
 return {};
}

/** The API names original figure crops by their source bounding box, including nested subfigures. */
function aiStudioBlockImage(raw:unknown,box:number[]):string|undefined{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
 for(const [name,value] of Object.entries(raw)){
  if(typeof value!=='string')continue;
  const match=name.match(/_box_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)\.(?:jpe?g|png|webp)$/i);
  if(!match)continue;
  const coords=match.slice(1).map(Number),expected=[box[0],box[1],box[0]+box[2],box[1]+box[3]];
  if(!coords.every((coordinate,i)=>Math.abs(coordinate-expected[i])<=1))continue;
  if(/^https:\/\//i.test(value)||/^data:image\/(?:jpeg|png|webp);base64,/i.test(value))return value;
  if(value.length>0&&/^[A-Za-z0-9+/=\r\n]+$/.test(value))return `data:image/${/\.png$/i.test(name)?'png':/\.webp$/i.test(name)?'webp':'jpeg'};base64,${value}`;
 }
}

/** 图片用 data URI 内联：接口给的链接 30 天过期，阅读视图必须能长期打开。 */
export async function inlineImages(pages:LayoutPage[],upstream:typeof fetch,signal:AbortSignal,log:(message:string)=>void):Promise<void>{
 for(const page of pages)for(const image of page.images||[]){
  const url=image.data_url;
  if(!url||url.startsWith('data:'))continue;
  try{
   const response=await upstream(url,{redirect:'error',signal});
   if(!response.ok)throw Error(`HTTP ${response.status}`);
   const bytes=Buffer.from(await response.arrayBuffer());
   if(bytes.byteLength>4*1024*1024){image.data_url='';continue;}
   image.data_url=`data:${sniff(bytes)};base64,${bytes.toString('base64')}`;
  }catch(error){image.data_url='';log(`图片未能下载，已留空：${(error as Error).message}`);}
 }
}
function sniff(data:Buffer):string{
 if(data.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'image/png';
 if(data[0]===0xff&&data[1]===0xd8&&data[2]===0xff)return 'image/jpeg';
 if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')return 'image/webp';
 if(data.subarray(0,6).toString().startsWith('GIF8'))return 'image/gif';
 return 'image/png';
}

// ---------- 本机缓存 ----------
const SAFE_ID=/^[a-zA-Z0-9_-]{1,100}$/;
export function layoutStore(root:string){
 const file=async(id:string,suffix:string)=>{if(!SAFE_ID.test(id))throw new HttpError(400,'资料ID无效');return assertNoSymlinks(root,`workspace/reading-layout/${id}${suffix}.json`,true);};
 return {
  async readLayout(id:string):Promise<DocumentLayout|null>{
   try{const raw=await fs.readFile(await file(id,''),'utf8');const value=JSON.parse(raw) as DocumentLayout;return value?.version===1&&Array.isArray(value.pages)?value:null;}
   catch(error:any){if(error.code==='ENOENT')return null;throw error;}
  },
  async writeLayout(layout:DocumentLayout){await atomicWrite(await file(layout.resourceId,''),JSON.stringify(layout));await refreshReadingSearch(root,layout.resourceId,{layout}).catch(()=>{});},
  async reuseLayout(id:string,sourceHash:string,peerIds:string[]):Promise<DocumentLayout|null>{
   return withLock(`bilingual:${root}:${id}`,async()=>{
    const own=await this.readLayout(id);
    let layout=own?.sourceHash===sourceHash?own:null;
    let shared:Record<string,string>={};
    for(const peerId of [...new Set(peerIds)].filter(peerId=>peerId!==id)){
     const peer=await this.readLayout(peerId).catch(()=>null);
     if(peer?.sourceHash!==sourceHash)continue;
     layout??=peer;
     shared={...shared,...await this.readTranslations(peerId)};
    }
    if(!layout)return null;
    const translations=own?.sourceHash===sourceHash?await this.readTranslations(id):{};
    const merged={...shared,...translations};
    if(own?.sourceHash!==sourceHash){
     if(own)await this.archiveLayout(id,own.sourceHash);
     layout={...layout,resourceId:id};await this.writeLayout(layout);
    }
    if(Object.keys(shared).some(key=>!(key in translations))){
     await atomicWrite(await file(id,'.translations'),JSON.stringify(merged));
     await refreshReadingSearch(root,id,{layout,translations:merged}).catch(()=>{});
    }
    return layout;
   });
  },
  async archiveLayout(id:string,sourceHash:string){
   if(!/^[a-zA-Z0-9_-]{1,128}$/.test(sourceHash))throw new HttpError(400,'原文指纹无效。');
   for(const suffix of ['', '.translations', '.analysis']){
    try{
     const content=await fs.readFile(await file(id,suffix),'utf8');
     const target=await assertNoSymlinks(root,`workspace/reading-layout/history/${id}/${sourceHash}${suffix}.json`,true);
     await atomicWrite(target,content);
    }catch(error:any){if(error.code!=='ENOENT')throw error;}
   }
   await fs.rm(await file(id,'.translations'),{force:true});
   await fs.rm(await file(id,'.analysis'),{force:true});
   await removeReadingSearch(root,id);
  },
  async writeAnalysis(id:string,analysis:unknown){await atomicWrite(await file(id,'.analysis'),JSON.stringify(analysis));},
  async removeLayout(id:string){await fs.rm(await file(id,''),{force:true});await fs.rm(await file(id,'.translations'),{force:true});await removeReadingSearch(root,id);},
  /** 译文按「译文来源 + 原文」存储，换来源或原文变化都会重新翻译。 */
  async readTranslations(id:string):Promise<Record<string,string>>{
   try{const value=JSON.parse(await fs.readFile(await file(id,'.translations'),'utf8'));return value&&typeof value==='object'?value as Record<string,string>:{};}
   catch(error:any){if(error.code==='ENOENT')return {};throw error;}
  },
  async mergeTranslations(id:string,entries:Record<string,string>,sourceHash?:string):Promise<number>{
   return withLock(`bilingual:${root}:${id}`,async()=>{
    if(sourceHash){
     const layout=JSON.parse(await fs.readFile(await file(id,''),'utf8')) as DocumentLayout;
     if(layout.sourceHash!==sourceHash)throw new HttpError(409,'版面缓存已更新，译文尚未写入。');
    }
    const target=await file(id,'.translations');
    let current:Record<string,string>={};
    try{const value=JSON.parse(await fs.readFile(target,'utf8'));if(value&&typeof value==='object')current=value as Record<string,string>;}
    catch(error:any){if(error.code!=='ENOENT')throw error;}
    const merged={...current,...entries};
    await atomicWrite(target,JSON.stringify(merged));
    await refreshReadingSearch(root,id,{translations:merged}).catch(()=>{});
    return Object.keys(merged).length;
   });
  },
 };
}
export const MAX_PARSE_PAGES=MAX_PAGES;

/** 各引擎的用量与额度设置。两边接口都不返回账户余额，这里只记 EchoPaper 自己解析掉的页数。 */
export interface UsageSettings{quota:Record<string,number>;threshold:number;autoSwitch:boolean}
export interface UsageFile{months:Record<string,Record<string,number>>;days:Record<string,Record<string,number>>;settings:UsageSettings}
/**
 * 两个渠道的免费额度默认值：智能云 Unlimited-OCR 每月 2000 页（自动刷新、不结转），
 * 星河社区 PaddleOCR-VL 每天 20000 页。老账号的额度可能不同，界面上可以改；
 * 显式填 0 表示不设额度，也就不提醒、不自动切换。
 */
export const DEFAULT_QUOTA:Record<string,number>={'unlimited-ocr':2000,'aistudio-vl':20000};
export const DEFAULT_USAGE:UsageFile={months:{},days:{},settings:{quota:{...DEFAULT_QUOTA},threshold:100,autoSwitch:true}};
export const usageMonth=(at=new Date())=>`${at.getFullYear()}-${String(at.getMonth()+1).padStart(2,'0')}`;
export const usageDay=(at=new Date())=>`${usageMonth(at)}-${String(at.getDate()).padStart(2,'0')}`;

export function usageStore(root:string){
 const file=async()=>assertNoSymlinks(root,'workspace/reading-layout/_usage.json',true);
 async function read():Promise<UsageFile>{
  try{
   const value=JSON.parse(await fs.readFile(await file(),'utf8')) as UsageFile;
   if(!value||typeof value!=='object')return structuredClone(DEFAULT_USAGE);
   return {months:value.months&&typeof value.months==='object'?value.months:{},
    days:value.days&&typeof value.days==='object'?value.days:{},
    // 缺这个引擎的那一项就补上官方免费额度；显式写 0 表示「不设额度」，会原样保留。
    settings:{quota:{...DEFAULT_QUOTA,...(value.settings?.quota&&typeof value.settings.quota==='object'?value.settings.quota:{})},
     threshold:Number.isFinite(value.settings?.threshold)?Math.max(0,Math.floor(value.settings!.threshold)):100,
     autoSwitch:value.settings?.autoSwitch!==false}};
  }catch(error:any){if(error.code==='ENOENT')return structuredClone(DEFAULT_USAGE);throw error;}
 }
 return {
  read,
  /** 已用页数：按该引擎的额度周期取当月或当天的计数。 */
  used(usage:UsageFile,engineId:string,at=new Date()):number{
   return parseEngine(engineId).period==='day'
    ?usage.days[usageDay(at)]?.[engineId]??0
    :usage.months[usageMonth(at)]?.[engineId]??0;
  },
  /** 剩余页数；没有设额度时返回 null，表示不提醒也不自动切换。 */
  remaining(usage:UsageFile,engineId:string,at=new Date()):number|null{
   const quota=usage.settings.quota[engineId];
   if(!Number.isFinite(quota)||quota<=0)return null;
   return Math.max(0,quota-this.used(usage,engineId,at));
  },
  async record(engineId:string,pages:number){
   return withLock(`bilingual-usage:${root}`,async()=>{
    const usage=await read(),month=usageMonth(),day=usageDay(),count=Math.max(0,Math.floor(pages));
    // 两套都记：周期是引擎的属性，可能改，历史计数不该因此作废。
    usage.months[month]={...usage.months[month],[engineId]:(usage.months[month]?.[engineId]??0)+count};
    usage.days[day]={...usage.days[day],[engineId]:(usage.days[day]?.[engineId]??0)+count};
    // 只保留最近 12 个月、最近 62 天，避免文件无限增长
    for(const key of Object.keys(usage.months).sort().slice(0,-12))delete usage.months[key];
    for(const key of Object.keys(usage.days).sort().slice(0,-62))delete usage.days[key];
    await atomicWrite(await file(),JSON.stringify(usage));
    return usage;
   });
  },
  async saveSettings(next:UsageSettings){
   return withLock(`bilingual-usage:${root}`,async()=>{
    const usage=await read();
    usage.settings=next;
    await atomicWrite(await file(),JSON.stringify(usage));
    return usage;
   });
  },
 };
}
