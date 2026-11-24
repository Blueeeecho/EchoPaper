import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import {PDFDocument} from 'pdf-lib';
import {registerReadingProcessingRoutes} from '../server/workspace/reading-processing';
import {registerWorkspaceRoutes} from '../server/workspace/index';
import {layoutStore,OcrResumeBlocked,PARSE_ENGINES,parseDocument,type OcrJobPart} from '../server/workspace/document-layout';
import {translationCacheKey} from '../shared/bilingual-cache';
import type {Resource} from '../shared/workspace-types';
import type {DocumentLayout} from '../shared/bilingual';
import type {ProviderRegistry} from '../server/model-providers';
import {registerUnifiedTranslationRoutes} from '../server/translation';
import {registerBilingualRoutes} from '../server/workspace/bilingual';
import type {PublicRegistry} from '../shared/model-providers';
import {HttpError} from '../server/security';

const config={translations:[{id:'zhipu',modelId:'glm',label:'智谱',enabled:true}],
 models:[{id:'glm',providerId:'provider',model:'glm-4-flash',label:'GLM',enabled:true,configured:true}],
 providers:[{id:'provider',kind:'zhipu-translate',enabled:true}]} as PublicRegistry;
const registry={publicConfig:async()=>config};
const engineOptions=async()=>PARSE_ENGINES.map(engine=>({id:engine.id,label:engine.label,configured:true}));
const resource=(id='paper',hash='hash1'):Resource=>({id,hash,name:`${id}.pdf`,path:`${id}.pdf`,kind:'file',rootId:'root',size:100,modifiedAt:new Date().toISOString(),tags:[],missing:false,revision:1});
function layout(id:string,hash:string):DocumentLayout {
 return {version:1,resourceId:id,sourceHash:hash,parsedAt:new Date().toISOString(),pageCount:1,costPages:1,engine:'aistudio-vl',pages:[{page_num:1,layouts:[
  {layout_id:'title',type:'title',text:'A Paper Title',sub_type:'title_1'},
  {layout_id:'body',type:'text',text:'The main body has useful evidence.'},
  {layout_id:'appendix',type:'title',text:'Appendix'},
  {layout_id:'extra',type:'text',text:'Additional evidence is retained here.'},
 ]}]};
}
async function fixture(t:test.TestContext,translate?:NonNullable<Parameters<typeof registerReadingProcessingRoutes>[5]>['translate'],providerConfig=config) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reading-processing-')));
 const app=Fastify();
 const resources:Resource[]=[];
 const workspace={resources:()=>resources,resourceFile:async(id:string)=>{
  const item=resources.find(item=>item.id===id);if(!item)throw new HttpError(404,'missing');
  return {resource:item,hash:item.hash!,filename:`${root}/${item.name}`};
 }};
 const store=layoutStore(root);let parses=0,calls=0;
 const parseRequests:Array<{engine:string}>=[];
 const providerRegistry={publicConfig:async()=>providerConfig};
 const bilingual={engineOptions,ensureLayout:async(id:string,options:any)=>{
  assert.ok(PARSE_ENGINES.some(engine=>engine.id===options.engine));assert.equal(options.allowSwitch,false);
  parseRequests.push({engine:options.engine});
  const item=resources.find(item=>item.id===id)!;
  const cached=await store.readLayout(id);if(cached&&cached.sourceHash===item.hash)return cached;
  parses++;const result=layout(id,item.hash!);result.engine=options.engine;await store.writeLayout(result);return result;
 }};
 const service=await registerReadingProcessingRoutes(app,root,workspace,providerRegistry,bilingual,{intervalMs:100000,translate:translate??(async()=>{calls++;return '完整译文';})});
 await app.ready();
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 return {app,root,resources,store,service,workspace,bilingual,providerRegistry,parseRequests,counts:()=>({parses,calls}),status:async()=> (await app.inject('/api/workspace/bilingual/processing?ids=paper')).json()};
}

test('new PDF imports are processed without a reader and complete only after local caches exist',async t=>{
 const f=await fixture(t);f.resources.push(resource());
 await f.service.tick();
 const status=await f.status();assert.equal(status.statuses.paper.stage,'complete');
 assert.equal(status.statuses.paper.done,status.statuses.paper.total);
 assert.ok(f.counts().calls>0);assert.equal(f.counts().parses,1);
 assert.equal(f.parseRequests[0].engine,'aistudio-vl');
 const analysis=JSON.parse(await fs.readFile(path.join(f.root,'workspace/reading-layout/paper.analysis.json'),'utf8'));
 assert.equal(analysis.sourceHash,'hash1');assert.equal(analysis.configuredTranslationSource.id,'zhipu');
 assert.deepEqual(analysis.cachedTranslationSources,[{id:'zhipu',modelLabel:'GLM'}]);
 assert.ok(analysis.blocks.some((block:any)=>block.section==='appendix'&&block.text));
 assert.ok(analysis.blocks.filter((block:any)=>block.translate).every((block:any)=>block.translationKey));
 const previous=f.counts();await f.service.tick();assert.deepEqual(f.counts(),previous);
});

test('appendix setting supplements existing caches and preserves earlier translations',async t=>{
 const f=await fixture(t);f.resources.push(resource());await f.service.tick();
 const previous=await f.store.readTranslations('paper');const initial=await f.status();
 assert.equal((await f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:initial.revision,translateAppendix:true}})).statusCode,200);
 assert.equal((await f.status()).statuses.paper.stage,'queued');
 await f.service.tick();const current=await f.status();
 assert.equal(current.statuses.paper.stage,'complete');assert.equal(current.statuses.paper.appendix,true);
 const translations=await f.store.readTranslations('paper');
 for(const [key,text] of Object.entries(previous))assert.equal(translations[key],text);
 assert.ok(Object.keys(translations).length>Object.keys(previous).length);assert.equal(f.counts().parses,1);
 assert.equal((await f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:initial.revision,enabled:false}})).statusCode,409);
});

test('partial translation failures retain progress and restart resumes from saved blocks',async t=>{
 let calls=0;
 const f=await fixture(t,async()=>{calls++;if(calls===2)throw new HttpError(502,'temporary failure');return '已保存译文';});
 f.resources.push(resource());await f.service.tick();
 assert.equal((await f.status()).statuses.paper.stage,'queued');
 assert.equal(Object.keys(await f.store.readTranslations('paper')).length,1);
 await f.service.close();
 const app=Fastify();
 const service=await registerReadingProcessingRoutes(app,f.root,f.workspace,registry,f.bilingual,{intervalMs:100000,translate:async()=>{calls++;return '补齐译文';}});
 t.after(()=>app.close());await app.ready();
 // A manual retry clears the persisted backoff, without clearing cached blocks.
 await app.inject({method:'POST',url:'/api/workspace/bilingual/processing',payload:{resourceIds:['paper']}});
 const saved=JSON.parse(await fs.readFile(path.join(f.root,'workspace/reading-layout/_processing.json'),'utf8'));
 assert.equal(saved.jobs.paper.done,1);
 await service.tick();
 assert.equal((await app.inject('/api/workspace/bilingual/processing?ids=paper')).json().statuses.paper.stage,'complete');
 assert.equal(calls,3);
});

test('pause aborts running work and preserves the durable queue for resume',async t=>{
 let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
 const f=await fixture(t,async(_id,_source,_text,signal)=>{
  began();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));return '';
 });
 f.resources.push(resource());const run=f.service.tick();await started;
 const before=await f.status();assert.equal(before.statuses.paper.stage,'translating');
 const result=await f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:before.revision,enabled:false}});
 assert.equal(result.statusCode,200);await run;
 assert.equal((await f.status()).statuses.paper.stage,'queued');assert.equal(f.service.busy(),false);
});

test('existing legacy caches report completion and never require an upstream translation',async t=>{
 const f=await fixture(t);f.resources.push(resource());
 await f.store.writeLayout(layout('paper','hash1'));
 const translations={
  [translationCacheKey({id:'old-source',model:'old-model'},'zh-CN','A Paper Title')]:'标题',
  [translationCacheKey({id:'old-source',model:'old-model'},'zh-CN','The main body has useful evidence.')]:'正文',
 };
 await f.store.mergeTranslations('paper',translations,'hash1');
 assert.equal((await f.status()).statuses.paper.stage,'complete');
 await f.service.tick();assert.deepEqual(f.counts(),{parses:0,calls:0});
 await assert.rejects(f.store.mergeTranslations('paper',{'bad':'错误译文'},'old-hash'),/缓存已更新/);
});

test('normal topic PDF upload automatically enters processing on the next queue pass',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reading-upload-')));const app=Fastify();
 await app.register(multipart);
 const workspace=await registerWorkspaceRoutes(app,root,{watch:false});
 const store=layoutStore(root);
 const bilingual={engineOptions,ensureLayout:async(id:string)=>{
  const detail=await workspace.resourceFile(id);const result=layout(id,detail.hash);await store.writeLayout(result);return result;
 }};
 const service=await registerReadingProcessingRoutes(app,root,workspace,registry,bilingual,{intervalMs:100000,translate:async()=> '自动翻译'});
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 const created=await app.inject({method:'POST',url:'/api/workspace/topics',payload:{title:'Upload test'}});assert.equal(created.statusCode,201);
 const topic=created.json();const pdf=await PDFDocument.create();pdf.addPage();const bytes=Buffer.from(await pdf.save());
 const boundary='reading-upload-boundary';
 const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="uploaded.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 const uploaded=await app.inject({method:'POST',url:`/api/workspace/topics/${topic.id}/upload?expectedRevision=${topic.revision}`,headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:body});
 assert.equal(uploaded.statusCode,201,uploaded.body);
 await service.tick();const id=uploaded.json().resource.id;
 const status=(await app.inject(`/api/workspace/bilingual/processing?ids=${id}`)).json();
 assert.equal(status.statuses[id].stage,'complete');assert.ok(await store.readLayout(id));
});

test('background translation shares the adapter, rejects incomplete text, and aborts an in-flight request',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reading-adapter-')));
 const app=Fastify(),resources:Resource[]=[],store=layoutStore(root);
 const workspace={resources:()=>resources,resourceFile:async()=>({resource:resources[0],filename:'unused',hash:'hash1'})};
 const data={...config,providers:[{...config.providers[0],baseUrl:'https://fixture.invalid',auth:'bearer'}]};
 const providerRegistry={...registry,read:async()=>({data}),getKey:async()=> 'fixture-only',scheduler:{acquire:async()=>()=>{}}};
 let calls=0, aborted=false, entered!:()=>void;
 const inFlight=new Promise<void>(resolve=>{entered=resolve;});
 const translate=registerUnifiedTranslationRoutes(app,root,providerRegistry as unknown as ProviderRegistry,{
  validateResource:workspace.resourceFile,
  fetch:async(_input,init)=>{
   calls++;
   if(calls===2)await new Promise<void>((_resolve,reject)=>{
    init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Stopped','AbortError'));},{once:true});
    entered();
   });
   return Response.json({choices:[{finish_reason:calls===1?'length':'stop',message:{content:'完整译文'}}]});
  },
 });
 const queue=await registerReadingProcessingRoutes(app,root,workspace,registry,{engineOptions,ensureLayout:async()=>{
  const result=layout('paper','hash1');
  result.pages[0].layouts=[{layout_id:'body',type:'text',text:'One synthetic paragraph for the shared adapter.'}];
  await store.writeLayout(result);return result;
 }},{intervalMs:100000,translate:async(resourceId,sourceId,text,signal)=>(await translate({resourceId,sourceId,text,target:'zh-CN',source:'pdf'},signal)).text});
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 await app.ready();resources.push(resource());
 const route='/api/workspace/bilingual/processing';
 const status=async()=>(await app.inject(route+'?ids=paper')).json();
 const settings=async(enabled:boolean)=>app.inject({method:'PUT',url:route,payload:{expectedRevision:(await status()).revision,enabled}});
 await queue.tick();
 assert.equal(calls,1,JSON.stringify(await status()));
 assert.deepEqual(await store.readTranslations('paper'),{});
 await app.inject({method:'POST',url:route,payload:{resourceIds:['paper']}});
 const pending=queue.tick();
 const started=await Promise.race([inFlight.then(()=>true),pending.then(()=>false)]);
 assert.equal(started,true,JSON.stringify(await status()));
 assert.equal((await settings(false)).statusCode,200);
 await pending;
 assert.equal(aborted,true);
 assert.deepEqual(await store.readTranslations('paper'),{});
 assert.equal((await settings(true)).statusCode,200);
 await queue.tick();
 assert.equal((await status()).statuses.paper.stage,'complete');
 assert.equal(calls,3);
});

test('source revisions archive earlier OCR, translations and analysis before replacing caches',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reading-history-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=layoutStore(root);
 await store.writeLayout(layout('paper','hash1'));
 await store.mergeTranslations('paper',{'legacy':'译文'},'hash1');
 await store.writeAnalysis('paper',{sourceHash:'hash1',blocks:['evidence']});
 await store.archiveLayout('paper','hash1');await store.writeLayout(layout('paper','hash2'));
 const history=path.join(root,'workspace/reading-layout/history/paper');
 assert.equal(JSON.parse(await fs.readFile(path.join(history,'hash1.json'),'utf8')).sourceHash,'hash1');
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(history,'hash1.translations.json'),'utf8')),{'legacy':'译文'});
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(history,'hash1.analysis.json'),'utf8')).blocks,['evidence']);
 assert.deepEqual(await store.readTranslations('paper'),{});
});

test('a changed PDF cannot receive a translation from an earlier version',async t=>{
 let update!:()=>void;
 const f=await fixture(t,async()=>{update();return '旧版译文';});
 f.resources.push(resource());update=()=>{f.resources[0].hash='hash2';};
 await f.service.tick();
 assert.deepEqual(await f.store.readTranslations('paper'),{});
 assert.equal((await f.status()).statuses.paper.stage,'stale');
});

test('stale setting updates leave a running translation active',async t=>{
 let began!:()=>void,finish!:(text:string)=>void;
 const started=new Promise<void>(resolve=>{began=resolve;});
 const pending=new Promise<string>(resolve=>{finish=resolve;});
 const f=await fixture(t,async()=>{began();return pending;});
 f.resources.push(resource());const run=f.service.tick();await started;
 const response=await f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:0,enabled:false}});
 assert.equal(response.statusCode,409);assert.equal(f.service.busy(),true);
 for(const selection of [{engineId:'unknown'},{translationSourceId:'removed'}]){
  const invalid=await f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:1,...selection}});
  assert.equal(invalid.statusCode,400);assert.equal(f.service.busy(),true);
 }
 finish('完整译文');await run;assert.equal((await f.status()).statuses.paper.stage,'complete');
});

test('selected OCR and translation source are persisted and used by later imports',async t=>{
 const otherConfig={...config,
  translations:[...config.translations,{...config.translations[0],id:'alternate',modelId:'second',label:'其他翻译'}],
  models:[...config.models,{...config.models[0],id:'second',model:'second-model',label:'Second model'}]};
 const calls:Array<{id:string;source:string}>=[];
 const f=await fixture(t,async(id,source)=>{calls.push({id,source});return '所选来源的译文';},otherConfig);
 f.resources.push(resource());await f.service.tick();
 const cached=await f.store.readTranslations('paper');
 const snapshot=await f.status();
 assert.equal(snapshot.choices.engines.length,2);assert.equal(snapshot.choices.translations[1].model,'Second model');
 const saved=await f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:snapshot.revision,engineId:'unlimited-ocr',translationSourceId:'alternate'}});
 assert.equal(saved.statusCode,200);
 assert.deepEqual(await f.store.readTranslations('paper'),cached);
 assert.equal((await f.status()).statuses.paper.stage,'complete');
 f.resources.push(resource('new-paper','new-hash'));await f.service.tick();
 assert.equal(f.parseRequests.at(-1)?.engine,'unlimited-ocr');
 assert.ok(calls.filter(call=>call.id==='new-paper').every(call=>call.source==='alternate'));
 const analysis=JSON.parse(await fs.readFile(path.join(f.root,'workspace/reading-layout/new-paper.analysis.json'),'utf8'));
 assert.equal(analysis.engine,'unlimited-ocr');assert.equal(analysis.configuredTranslationSource.id,'alternate');
 await f.service.close();
 const app=Fastify();
 await registerReadingProcessingRoutes(app,f.root,f.workspace,f.providerRegistry,f.bilingual,{intervalMs:100000});
 try{
  const restarted=(await app.inject('/api/workspace/bilingual/processing')).json();
  assert.equal(restarted.settings.engineId,'unlimited-ocr');assert.equal(restarted.settings.translationSourceId,'alternate');
  assert.equal(restarted.sources.translation,'其他翻译');
 }finally{await app.close();}
});

test('older queue settings receive default model choices while preserving pause and appendix settings',async t=>{
 const f=await fixture(t);await f.service.close();
 const filename=path.join(f.root,'workspace/reading-layout/_processing.json');
 await fs.writeFile(filename,JSON.stringify({version:1,revision:4,settings:{enabled:false,translateAppendix:true},seen:{},jobs:{}}));
 const app=Fastify();
 await registerReadingProcessingRoutes(app,f.root,f.workspace,registry,f.bilingual,{intervalMs:100000});
 try{
  const snapshot=(await app.inject('/api/workspace/bilingual/processing')).json();
  assert.deepEqual(snapshot.settings,{enabled:false,translateAppendix:true,engineId:'aistudio-vl',translationSourceId:null});
  assert.equal(snapshot.sources.translation,'智谱');
 }finally{await app.close();}
});

test('an unavailable saved translation source is reported and never replaced silently',async t=>{
 const changingConfig={...config,translations:[...config.translations]};
 const f=await fixture(t,undefined,changingConfig);
 const initial=await f.status();
 await f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:initial.revision,translationSourceId:'zhipu'}});
 changingConfig.translations=[];
 f.resources.push(resource());await f.service.tick();
 const unavailable=await f.status();
 assert.match(unavailable.statuses.paper.error,/所选翻译来源已停用/);
 assert.deepEqual(f.counts(),{parses:0,calls:0});
 changingConfig.translations=[...config.translations];
 const updated=await f.app.inject({method:'PUT',url:'/api/workspace/bilingual/processing',payload:{expectedRevision:unavailable.revision,translationSourceId:null}});
 assert.equal(updated.statusCode,200);await f.service.tick();
 assert.equal((await f.status()).statuses.paper.stage,'complete');
});


test('byte-identical resources share existing OCR and translations without upstream calls',async t=>{
 const f=await fixture(t);f.resources.push(resource());await f.service.tick();
 const before=f.counts();f.resources.push(resource('copy','hash1'));
 await f.service.tick();assert.deepEqual(f.counts(),before);
 const status=(await f.app.inject('/api/workspace/bilingual/processing?ids=paper,copy')).json();
 assert.equal(status.statuses.copy.stage,'complete');
 assert.equal((await f.store.readLayout('copy'))?.resourceId,'copy');
 assert.deepEqual(await f.store.readTranslations('copy'),await f.store.readTranslations('paper'));
});

test('OCR journals the accepted provider job and queries it after pause and restart', {timeout:5000}, async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reading-ocr-resume-')));
 const filename=path.join(root,'paper.pdf');
 const bytes=Buffer.from('%PDF-1.4');
 await fs.writeFile(filename,bytes);
 const item=resource('paper',createHash('sha256').update(bytes).digest('hex')), resources:Resource[]=[];
 const workspace={resources:()=>resources,resourceFile:async()=>({resource:item,filename,hash:item.hash!})};
 let submissions=0, firstPoll!:()=>void, polls=0;
 const polling=new Promise<void>(resolve=>{firstPoll=resolve;});
 const mock:typeof fetch=async (input,init)=>{
  const url=String(input);
  if(url.endsWith('/ocr/jobs')&&init?.method==='POST'){
   submissions++;
   return Response.json({errorCode:0,data:{jobId:'accepted-job'}});
  }
  if(url.endsWith('/ocr/jobs/accepted-job')){
   polls++;
   if(polls===1)await new Promise((_resolve,reject)=>{
    init!.signal!.addEventListener('abort',()=>reject(new DOMException('Paused','AbortError')),{once:true});
    firstPoll();
   });
   return Response.json({errorCode:0,data:{state:'done',extractProgress:{extractedPages:1},resultUrl:{jsonUrl:'https://fixture.invalid/result.jsonl'}}});
  }
  assert.ok(url.endsWith('result.jsonl'));
  return new Response(JSON.stringify({errorCode:0,result:{layoutParsingResults:[
   {prunedResult:{width:100,height:100,parsing_res_list:[
    {block_label:'text',block_content:'A synthetic paragraph used to verify OCR resume.',block_bbox:[1,2,3,4],block_order:1},
   ]},markdown:{text:'',images:{}},outputImages:{}},
  ]}}));
 };
 async function open(){
  const app=Fastify();
  const bilingual=registerBilingualRoutes(app,root,workspace,{fetch:mock,readKey:async()=> 'fixture-only',sleep:async()=>{}});
  const queue=await registerReadingProcessingRoutes(app,root,workspace,registry,bilingual,{intervalMs:100000,translate:async()=> '模拟译文'});
  await app.ready();
  return {app,queue};
 }
 let server=await open();
 t.after(async()=>{await server.app.close();await fs.rm(root,{recursive:true,force:true});});
 const route='/api/workspace/bilingual/processing';
 const status=async()=>(await server.app.inject(route+'?ids=paper')).json();
 const settings=async(enabled:boolean)=>server.app.inject({method:'PUT',url:route,payload:{expectedRevision:(await status()).revision,enabled}});
 resources.push(item);
 const first=server.queue.tick();
 await polling;
 assert.equal((await settings(false)).statusCode,200);
 await first;
 const saved=JSON.parse(await fs.readFile(path.join(root,'workspace/reading-layout/_processing.json'),'utf8'));
 assert.deepEqual(saved.jobs.paper.ocr,{engineId:'aistudio-vl',parts:{0:{state:'accepted',id:'accepted-job'}}});
 await server.app.close();
 server=await open();
 assert.equal((await settings(true)).statusCode,200);
 await server.queue.tick();
 assert.equal(submissions,1);
 assert.equal(polls,2);
 assert.equal((await status()).statuses.paper.stage,'complete');
});

test('an ambiguous OCR submission is preserved and cannot be automatically sent again',async()=>{
 const parts=new Map<number,OcrJobPart>();
 let submissions=0;
 const deps={
  checkpoint:{read:(i:number)=>parts.get(i),write:async(i:number,value:OcrJobPart|null)=>{if(value)parts.set(i,value);else parts.delete(i);}},
  readKey:async()=> 'fixture-only',
  fetch:async()=>{submissions++;throw new Error('Connection lost after send');},
 };
 const attempt=()=>parseDocument(Buffer.from('%PDF-1.4'),'paper.pdf',deps,new AbortController().signal,'aistudio-vl');
 await assert.rejects(attempt,OcrResumeBlocked);
 assert.deepEqual(parts.get(0),{state:'submitting'});
 await assert.rejects(attempt,OcrResumeBlocked);
 assert.equal(submissions,1);
});

test('Unlimited OCR resumes its persisted task without a new submit',async()=>{
 const calls:string[]=[];
 const result=await parseDocument(Buffer.from('%PDF-1.4'),'paper.pdf',{
  readKey:async()=> 'fixture-only',
  sleep:async()=>{},
  checkpoint:{read:()=>({state:'accepted',id:'previous-task'}),write:async()=>{throw Error('No journal change expected');}},
  fetch:async(input,init)=>{
   const url=String(input);calls.push(url);
   if(url.endsWith('/query')){
    assert.equal(new URLSearchParams(String(init?.body)).get('task_id'),'previous-task');
    return Response.json({result:{status:'success',parse_result_url:'https://fixture.invalid/result'}});
   }
   assert.equal(url,'https://fixture.invalid/result');
   return Response.json({pages:[{page_num:1,layouts:[]}]});
  },
 },new AbortController().signal,'unlimited-ocr');
 assert.equal(result.costPages,1);
 assert.equal(calls.length,2);
});

test('upgrading an already-paused legacy OCR preserves an unknown acceptance state',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reading-ocr-upgrade-')));
 const filename=path.join(root,'workspace/reading-layout/_processing.json');
 await fs.mkdir(path.dirname(filename),{recursive:true});
 const item=resource();
 await fs.writeFile(filename,JSON.stringify({version:1,revision:1,settings:{enabled:false,translateAppendix:false,engineId:'aistudio-vl',translationSourceId:null},
  seen:{paper:item.hash},jobs:{paper:{resourceId:'paper',hash:item.hash,stage:'queued',done:0,total:0,pageCount:0,appendix:false,attempts:0,ocrStartedAt:'2026-01-01T00:00:00Z'}}}));
 const app=Fastify();
 const workspace={resources:()=>[item],resourceFile:async()=>({resource:item,filename:'unused',hash:item.hash!})};
 await registerReadingProcessingRoutes(app,root,workspace,registry,{engineOptions,ensureLayout:async()=>{throw Error('Disabled queue');}});
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 const saved=JSON.parse(await fs.readFile(filename,'utf8'));
 assert.equal(saved.ocrCheckpoints,true);
 assert.deepEqual(saved.jobs.paper.ocr.parts,{0:{state:'submitting'}});
});

test('completed jobs fast-path status queries without re-reading layout JSON',async t=>{
 const f=await fixture(t);f.resources.push(resource());
 await f.service.tick();
 assert.equal((await f.status()).statuses.paper.stage,'complete');
 const originalReadFile=fs.readFile;let layoutReads=0;
 fs.readFile=(async(target:any,...args:any[])=>{
  if(String(target).endsWith('reading-layout/paper.json'))layoutReads++;
  return (originalReadFile as any)(target,...args);
 }) as typeof fs.readFile;
 try{
  const polled=await f.status();
  assert.equal(polled.statuses.paper.stage,'complete');
  assert.equal(layoutReads,0);
 }finally{fs.readFile=originalReadFile;}
});

test('permanent 402 quota errors fail fast without retry and auto-pause the queue',async t=>{
 let calls=0;
 const f=await fixture(t,async()=>{calls++;throw new HttpError(502,'余额或额度不足',{upstreamStatus:402});});
 f.resources.push(resource());
 await f.service.tick();
 const snap=await f.status();
 assert.equal(snap.statuses.paper.stage,'failed');
 assert.equal(snap.settings.enabled,false);
 const saved=JSON.parse(await fs.readFile(path.join(f.root,'workspace/reading-layout/_processing.json'),'utf8'));
 assert.equal(saved.jobs.paper.attempts,1);
 assert.equal(saved.jobs.paper.retryAt,undefined);
 const afterFirst=calls;
 await f.service.tick();
 assert.equal(calls,afterFirst);
});
