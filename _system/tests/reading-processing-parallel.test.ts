import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import Fastify from 'fastify';
import {registerReadingProcessingRoutes} from '../server/workspace/reading-processing';
import {layoutStore,PARSE_ENGINES,parseDocument} from '../server/workspace/document-layout';
import {createTaskPool} from '../server/workspace/task-pool';
import type {EnsureLayoutOptions} from '../server/workspace/bilingual';
import type {DocumentLayout} from '../shared/bilingual';
import type {PublicRegistry} from '../shared/model-providers';
import type {Resource} from '../shared/workspace-types';
import {HttpError} from '../server/security';

type Translate=NonNullable<Parameters<typeof registerReadingProcessingRoutes>[5]>['translate'];
const config={translations:[{id:'zhipu',modelId:'glm',label:'智谱',enabled:true}],
 models:[{id:'glm',providerId:'provider',model:'glm-4-flash',label:'GLM',enabled:true,configured:true}],
 providers:[{id:'provider',kind:'zhipu-translate',enabled:true}]} as PublicRegistry;
const registry={publicConfig:async()=>config};
const engineOptions=async()=>PARSE_ENGINES.map(engine=>({id:engine.id,label:engine.label,configured:true}));
const resource=(id:string):Resource=>({id,hash:`hash-${id}`,name:`${id}.pdf`,path:`${id}.pdf`,kind:'file',rootId:'root',size:100,modifiedAt:new Date().toISOString(),tags:[],missing:false,revision:1});

function deferred(){
 let resolve!:()=>void;
 const promise=new Promise<void>(done=>{resolve=done;});
 return {promise,resolve};
}

function waitForGate(signal:AbortSignal,gate:Promise<void>):Promise<void>{
 signal.throwIfAborted();
 return new Promise<void>((resolve,reject)=>{
  const abort=()=>reject(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  void gate.then(()=>{signal.removeEventListener('abort',abort);resolve();},error=>{signal.removeEventListener('abort',abort);reject(error);});
 });
}

async function until(ready:()=>boolean,timeout=2000){
 const deadline=Date.now()+timeout;
 while(!ready()){
  if(Date.now()>deadline)throw Error('Parallel processing condition did not occur.');
  await delay(5);
 }
}

function layout(id:string,texts?:string[]):DocumentLayout{
 const paragraphs=texts??Array.from({length:4},(_,index)=>`Paragraph ${index+1} provides useful evidence for ${id}.`);
 return {version:1,resourceId:id,sourceHash:`hash-${id}`,parsedAt:new Date().toISOString(),pageCount:1,costPages:1,engine:'aistudio-vl',
  pages:[{page_num:1,layouts:paragraphs.map((text,index)=>({layout_id:`${id}-${index}`,type:'text',text}))}]};
}

async function fixture(t:test.TestContext,hooks:{translate?:Translate;ocr?:(id:string,options:EnsureLayoutOptions)=>Promise<void>;config?:()=>Promise<PublicRegistry>;ocrConcurrency?:1|2|null}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reading-parallel-')));
 const app=Fastify();const resources:Resource[]=[];const store=layoutStore(root);
 const workspace={resources:()=>resources,resourceFile:async(id:string)=>{
  const item=resources.find(resource=>resource.id===id);if(!item)throw new HttpError(404,'Missing test resource');
  return {resource:item,hash:item.hash!,filename:path.join(root,item.name)};
 }};
 const bilingual={engineOptions,ensureLayout:async(id:string,options:EnsureLayoutOptions={})=>{
  await hooks.ocr?.(id,options);options.signal?.throwIfAborted();
  const parsed=layout(id);await store.writeLayout(parsed);return parsed;
 }};
 const providers=hooks.config?{publicConfig:hooks.config}:registry;
 const concurrency=hooks.ocrConcurrency===null?{}:{ocrConcurrency:hooks.ocrConcurrency??1};
 const service=await registerReadingProcessingRoutes(app,root,workspace,providers,bilingual,{intervalMs:100000,retryDelayMs:5,...concurrency,translate:hooks.translate??(async()=> '完整译文')});
 await app.ready();
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 const snapshot=async()=> (await app.inject(`/api/workspace/bilingual/processing?ids=${resources.map(resource=>resource.id).join(',')}`)).json();
 return {app,root,resources,store,service,snapshot};
}

test('OCR of the next document overlaps translation while OCR remains single-slot',{timeout:5000},async t=>{
 const secondOcr=deferred(),translations=deferred();
 const ocrStarted:string[]=[];let activeOcr=0,maxOcr=0,translationCalls=0;
 const f=await fixture(t,{ocr:async(id,{signal})=>{
  ocrStarted.push(id);activeOcr++;maxOcr=Math.max(maxOcr,activeOcr);
  try{if(id==='second')await waitForGate(signal!,secondOcr.promise);}finally{activeOcr--;}
 },translate:async(_id,_source,_text,signal)=>{
  translationCalls++;await waitForGate(signal,translations.promise);return '并行译文';
 }});
 f.resources.push(resource('first'),resource('second'),resource('third'));
 const run=f.service.tick();
 await until(()=>translationCalls===2&&ocrStarted.includes('second'));
 const current=await f.snapshot();
 assert.equal(current.statuses.first.stage,'translating');assert.equal(current.statuses.second.stage,'ocr');
 assert.equal(current.statuses.third.stage,'queued');assert.equal(current.parallelism.activeDocuments,3);
 assert.equal(maxOcr,1);assert.equal(ocrStarted.includes('third'),false);
 secondOcr.resolve();translations.resolve();await run;
 assert.equal(maxOcr,1);assert.ok(Object.values(current.statuses).length===3);
 const finished=await f.snapshot();assert.ok(Object.values(finished.statuses).every((status:any)=>status.stage==='complete'));
});

test('default aistudio-vl caps OCR concurrency at 1 to avoid queue-full storms',{timeout:5000},async t=>{
 const ocrGate=deferred();
 let activeOcr=0,maxOcr=0,ocrCalls=0;
 const f=await fixture(t,{ocrConcurrency:null,ocr:async(_id,{signal})=>{
  ocrCalls++;activeOcr++;maxOcr=Math.max(maxOcr,activeOcr);
  try{await waitForGate(signal!,ocrGate.promise);}finally{activeOcr--;}
 }});
 f.resources.push(resource('first'),resource('second'));
 const run=f.service.tick();await until(()=>ocrCalls===1);
 const current=await f.snapshot();
 assert.equal(current.parallelism.ocr,1);assert.equal(current.parallelism.activeOcr,1);
 ocrGate.resolve();await run;
 assert.equal(maxOcr,1);assert.equal(ocrCalls,2);
 assert.ok(Object.values((await f.snapshot()).statuses).every((status:any)=>status.stage==='complete'));
});

test('explicit two-slot OCR overlaps two translations within four document slots',{timeout:5000},async t=>{
 const ocrGate=deferred(),translationGate=deferred();
 let activeOcr=0,maxOcr=0,ocrCalls=0,activeTranslations=0,maxTranslations=0,translationCalls=0;
 const f=await fixture(t,{ocrConcurrency:2,ocr:async(_id,{signal})=>{
  ocrCalls++;activeOcr++;maxOcr=Math.max(maxOcr,activeOcr);
  try{await waitForGate(signal!,ocrGate.promise);}finally{activeOcr--;}
 },translate:async(_id,_source,_text,signal)=>{
  translationCalls++;activeTranslations++;maxTranslations=Math.max(maxTranslations,activeTranslations);
  try{await waitForGate(signal,translationGate.promise);return '双OCR并行译文';}finally{activeTranslations--;}
 }});
 for(const id of ['first','second']){f.resources.push(resource(id));await f.store.writeLayout(layout(id));}
 f.resources.push(resource('third'),resource('fourth'));
 const run=f.service.tick();await until(()=>ocrCalls===2&&translationCalls===2);
 const current=await f.snapshot();
 assert.equal(current.parallelism.ocr,2);assert.equal(current.parallelism.activeDocuments,4);
 assert.equal(current.parallelism.activeOcr,2);assert.equal(current.parallelism.activeTranslations,2);
 assert.equal(current.statuses.third.stage,'ocr');assert.equal(current.statuses.fourth.stage,'ocr');
 await f.service.tick();assert.equal(ocrCalls,2);assert.equal(translationCalls,2);
 ocrGate.resolve();translationGate.resolve();await run;
 assert.equal(maxOcr,2);assert.equal(maxTranslations,2);
 assert.ok(Object.values((await f.snapshot()).statuses).every((status:any)=>status.stage==='complete'));
});

test('OCR backpressure reduces later parse starts to one slot',{timeout:5000},async t=>{
 const initialWave=deferred(),first=deferred(),second=deferred(),later=deferred();
 const started:string[]=[];let reduced=false,active=0,maxLaterActive=0;
 const f=await fixture(t,{ocrConcurrency:2,ocr:async(id,options)=>{
  started.push(id);active++;
  if(started.length===2)initialWave.resolve();
  try{
   await waitForGate(options.signal!,initialWave.promise);
   if(id==='first'){options.onBackpressure?.();reduced=true;await waitForGate(options.signal!,first.promise);}
   else if(id==='second')await waitForGate(options.signal!,second.promise);
   else{maxLaterActive=Math.max(maxLaterActive,active);await waitForGate(options.signal!,later.promise);}
  }finally{active--;}
 }});
 f.resources.push(...['first','second','third','fourth'].map(resource));
 const run=f.service.tick();await until(()=>started.length===2&&reduced);
 assert.equal((await f.snapshot()).parallelism.ocr,1);
 first.resolve();await delay(20);
 // Concurrent callbacks can start in either order, while later documents must still wait.
 assert.deepEqual([...started].sort(),['first','second']);
 second.resolve();await until(()=>started.includes('third'));
 assert.equal(started.includes('fourth'),false);assert.equal((await f.snapshot()).parallelism.activeOcr,1);
 later.resolve();await run;
 assert.equal(maxLaterActive,1);assert.equal(started.length,4);
 assert.ok(Object.values((await f.snapshot()).statuses).every((status:any)=>status.stage==='complete'));
});

test('translation requests stay globally bounded at two across three documents',{timeout:5000},async t=>{
 let active=0,maximum=0,calls=0,ocrCalls=0;
 const f=await fixture(t,{ocr:async()=>{ocrCalls++;},translate:async()=>{
  calls++;active++;maximum=Math.max(maximum,active);
  try{await delay(10);return '并行译文';}finally{active--;}
 }});
 for(const id of ['first','second','third']){f.resources.push(resource(id));await f.store.writeLayout(layout(id));}
 await f.service.tick();
 assert.equal(maximum,2);assert.equal(calls,12);assert.equal(ocrCalls,0);
 const finished=await f.snapshot();
 assert.ok(Object.values(finished.statuses).every((status:any)=>status.stage==='complete'&&status.done===4));
});

test('pause cancels all documents and pending OCR and translation slots',{timeout:5000},async t=>{
 const never=deferred();let translationCalls=0,ocrCalls=0,cancelled=0;
 const f=await fixture(t,{ocr:async(_id,{signal})=>{
  ocrCalls++;await waitForGate(signal!,never.promise);
 },translate:async(_id,_source,_text,signal)=>{
  translationCalls++;
  try{await waitForGate(signal,never.promise);return '未完成';}catch(error){cancelled++;throw error;}
 }});
 for(const id of ['first','second']){f.resources.push(resource(id));await f.store.writeLayout(layout(id));}
 f.resources.push(resource('third'));
 const run=f.service.tick();await until(()=>translationCalls===2&&ocrCalls===1);
 const before=await f.snapshot();
 const paused=await f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:before.revision,enabled:false}});
 assert.equal(paused.statusCode,200);await run;await delay(15);
 assert.equal(f.service.busy(),false);assert.equal(translationCalls,2);assert.equal(cancelled,2);assert.equal(ocrCalls,1);
 const after=await f.snapshot();
 assert.equal(after.parallelism.activeDocuments,0);assert.equal(after.parallelism.activeTranslations,0);assert.equal(after.parallelism.activeOcr,0);
 assert.ok(Object.values(after.statuses).every((status:any)=>status.stage==='queued'));
 assert.deepEqual(await f.store.readTranslations('first'),{});assert.deepEqual(await f.store.readTranslations('second'),{});
 await f.service.tick();assert.equal(translationCalls,2);
});

test('duplicate paragraph text is translated once and progress counts every source block',{timeout:5000},async t=>{
 const repeated='Repeated paragraph provides the same useful evidence.';
 const calls=new Map<string,number>();
 const f=await fixture(t,{translate:async(_id,_source,text)=>{
  calls.set(text,(calls.get(text)??0)+1);await delay(5);return '去重后的译文';
 }});
 f.resources.push(resource('paper'));await f.store.writeLayout(layout('paper',[repeated,repeated,'A different paragraph provides further evidence.']));
 await f.service.tick();
 assert.equal(calls.get(repeated),1);assert.equal(calls.size,2);
 const finished=await f.snapshot();assert.equal(finished.statuses.paper.done,3);assert.equal(finished.statuses.paper.total,3);
 assert.equal(finished.statuses.paper.stage,'complete');
});

test('closing drains cancellations and persists resumable jobs for every active document',{timeout:5000},async t=>{
 const never=deferred();let translationCalls=0,ocrCalls=0;
 const f=await fixture(t,{ocr:async(_id,{signal})=>{ocrCalls++;await waitForGate(signal!,never.promise);},
  translate:async(_id,_source,_text,signal)=>{translationCalls++;await waitForGate(signal,never.promise);return '未完成';}});
 for(const id of ['first','second']){f.resources.push(resource(id));await f.store.writeLayout(layout(id));}
 f.resources.push(resource('third'));
 const run=f.service.tick();await until(()=>translationCalls===2&&ocrCalls===1);
 await f.service.close();await run;
 const saved=JSON.parse(await fs.readFile(path.join(f.root,'workspace/reading-layout/_processing.json'),'utf8'));
 assert.ok(Object.values(saved.jobs).every((job:any)=>job.stage==='queued'&&job.attempts===0));
 assert.equal(f.service.busy(),false);await f.service.tick();assert.equal(translationCalls,2);assert.equal(ocrCalls,1);
});

test('a setting request that becomes stale during validation leaves newer tasks running',{timeout:5000},async t=>{
 const validation=deferred(),translations=deferred();
 let blockNextConfig=false,validationStarted=false,translationCalls=0,cancelled=0;
 const f=await fixture(t,{config:async()=>{
  if(blockNextConfig){blockNextConfig=false;validationStarted=true;await validation.promise;}
  return config;
 },translate:async(_id,_source,_text,signal)=>{
  translationCalls++;
  try{await waitForGate(signal,translations.promise);return '新版设置任务译文';}catch(error){cancelled++;throw error;}
 }});
 const before=await f.snapshot();blockNextConfig=true;
 const stale=Promise.resolve(f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:before.revision,translationSourceId:'zhipu'}}));
 let run:Promise<void>|undefined;
 try{
  await until(()=>validationStarted);
  const current=await f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:before.revision,enabled:true}});
  assert.equal(current.statusCode,200);
  f.resources.push(resource('paper'));await f.store.writeLayout(layout('paper'));
  run=f.service.tick();await until(()=>translationCalls===2);
  validation.resolve();assert.equal((await stale).statusCode,409);
  assert.equal(f.service.busy(),true);assert.equal(cancelled,0);
  translations.resolve();await run;
  assert.equal((await f.snapshot()).statuses.paper.stage,'complete');
 }finally{validation.resolve();translations.resolve();await stale;await run;}
});

test('simultaneous rate limits reduce subsequent real requests to one slot',{timeout:5000},async t=>{
 const firstWave=deferred(),limitedTexts=new Set<string>(),attempts=new Map<string,number>();
 let active=0,maximumAfterRateLimit=0,initialArrivals=0;
 const f=await fixture(t,{translate:async(_id,_source,text)=>{
  const attempt=(attempts.get(text)??0)+1;attempts.set(text,attempt);
  if(attempt===1&&limitedTexts.size<2)limitedTexts.add(text);
  active++;
  try{
   if(attempt===1&&limitedTexts.has(text)){
    initialArrivals++;if(initialArrivals===2)firstWave.resolve();await firstWave.promise;
    throw new HttpError(429,'Simulated rate limit');
   }
   maximumAfterRateLimit=Math.max(maximumAfterRateLimit,active);
   await delay(10);return '退避后的译文';
  }finally{active--;}
 }});
 f.resources.push(resource('paper'));await f.store.writeLayout(layout('paper'));
 await f.service.tick();
 const finished=await f.snapshot();
 assert.equal(initialArrivals,2);assert.equal(finished.parallelism.translation,1);assert.equal(maximumAfterRateLimit,1);
 assert.equal(finished.statuses.paper.stage,'complete');assert.equal(finished.statuses.paper.done,4);
 assert.equal([...attempts.values()].reduce((total,count)=>total+count,0),6);
});

test('adaptive pool recovery respects cooldown and restores the original capacity',()=>{
 const pool=createTaskPool(2);
 pool.reduce();assert.equal(pool.limit(),1);
 pool.recover();assert.equal(pool.limit(),1);
 pool.recover(0);assert.equal(pool.limit(),2);
 pool.reduce();pool.recover();assert.equal(pool.limit(),1);
 const conservative=createTaskPool(1);conservative.reduce();conservative.recover(0);assert.equal(conservative.limit(),1);
});

test('an upstream AbortError is resumable and does not consume a failed attempt',{timeout:5000},async t=>{
 let calls=0;
 const f=await fixture(t,{ocr:async()=>{if(++calls===1)throw new DOMException('Upstream closed','AbortError');}});
 f.resources.push(resource('paper'));await f.service.tick();
 const paused=(await f.snapshot()).statuses.paper;
 assert.equal(paused.stage,'queued');assert.equal(paused.attempts,0);assert.equal(paused.error,undefined);assert.equal(paused.retryAt,undefined);
 await f.service.tick();const resumed=(await f.snapshot()).statuses.paper;
 const saved=JSON.parse(await fs.readFile(path.join(f.root,'workspace/reading-layout/_processing.json'),'utf8'));
 assert.equal(resumed.stage,'complete');assert.equal(saved.jobs.paper.attempts,1);assert.equal(calls,2);
});

test('AI Studio failed tasks signal backpressure for source 500 and 503 responses',{timeout:5000},async()=>{
 for(const status of [500,503,422]){
  let backpressure=0;
  const upstream=(async(input:RequestInfo|URL)=>{
   const body=String(input).endsWith('/jobs')?{data:{jobId:'source-failure'}}:{data:{state:'failed',errorMsg:`下游服务状态码 ${status}`}};
   return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  await assert.rejects(parseDocument(Buffer.from('%PDF-1.4 fixture'),'paper.pdf',{fetch:upstream,readKey:async()=> 'fake-test-token',sleep:async()=>{},onBackpressure:()=>{backpressure++;}},new AbortController().signal,'aistudio-vl'),/AI Studio 解析失败/);
  assert.equal(backpressure,status===422?0:1);
 }
});


test('adaptive concurrency grows gradually, backs off on busy responses, and obeys cooldown',()=>{
 let now=1000;
 const pool=createTaskPool(2,{maxLimit:6,now:()=>now});
 for(let i=0;i<10;i++)pool.recover();assert.equal(pool.limit(),2);
 now+=30000;pool.recover();assert.equal(pool.limit(),3);
 now+=30000;for(let i=0;i<4;i++)pool.recover();assert.equal(pool.limit(),4);
 pool.reduce();assert.equal(pool.limit(),2);assert.equal(pool.throttled(),true);
 now+=60000;for(let i=0;i<20;i++)pool.recover();assert.equal(pool.limit(),2);
 now+=60000;pool.recover();assert.equal(pool.limit(),3);assert.equal(pool.throttled(),false);
 for(let round=0;round<8;round++){now+=30000;for(let i=0;i<4;i++)pool.recover();}
 assert.equal(pool.limit(),6);pool.reduce();assert.equal(pool.limit(),3);
 pool.reduce();assert.equal(pool.limit(),1);
});
