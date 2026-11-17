import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import {PDFDocument} from 'pdf-lib';
import {registerReadingProcessingRoutes} from '../server/workspace/reading-processing';
import {registerWorkspaceRoutes} from '../server/workspace/index';
import {layoutStore,PARSE_ENGINES} from '../server/workspace/document-layout';
import {translationCacheKey} from '../shared/bilingual-cache';
import type {Resource} from '../shared/workspace-types';
import type {DocumentLayout} from '../shared/bilingual';
import type {PublicRegistry} from '../shared/model-providers';
import {HttpError} from '../server/security';

const config={translations:[{id:'zhipu',modelId:'glm',label:'智谱',enabled:true}],
 models:[{id:'glm',providerId:'provider',model:'glm-4-flash',label:'GLM',enabled:true,configured:true}],
 providers:[{id:'provider',enabled:true}]} as PublicRegistry;
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

test('background translation consumes the existing NDJSON route and rejects incomplete responses',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reading-stream-')));
 const app=Fastify();const resources:Resource[]=[];const store=layoutStore(root);
 const workspace={resources:()=>resources,resourceFile:async()=>({resource:resources[0],filename:'unused',hash:'hash1'})};
 let complete=false;
 app.post<{Body:{sourceId:string;text:string}}>('/api/ai/translate',async request=>{
  assert.equal(request.body.sourceId,'zhipu');
  return JSON.stringify({type:'delta',text:'译文'})+'\n'+(complete?JSON.stringify({type:'done',finishReason:'stop'})+'\n':'');
 });
 const service=await registerReadingProcessingRoutes(app,root,workspace,registry,{engineOptions,ensureLayout:async()=>{
  const result=layout('paper','hash1');await store.writeLayout(result);return result;
 }},{intervalMs:100000});
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 await app.ready();resources.push(resource());await service.tick();
 assert.deepEqual(await store.readTranslations('paper'),{});
 assert.equal((await app.inject('/api/workspace/bilingual/processing?ids=paper')).json().statuses.paper.stage,'queued');
 complete=true;await app.inject({method:'POST',url:'/api/workspace/bilingual/processing',payload:{resourceIds:['paper']}});
 await service.tick();
 assert.equal((await app.inject('/api/workspace/bilingual/processing?ids=paper')).json().statuses.paper.stage,'complete');
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
