import fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import type {FastifyInstance} from 'fastify';
import {atomicWrite,withLock} from '../storage';
import {assertNoSymlinks,HttpError} from '../security';
import {workspaceMaintenance} from '../agents/maintenance';
import type {ProviderRegistry} from '../model-providers';
import {buildBilingualDocument,type DocumentLayout} from '../../shared/bilingual';
import {cachedTranslationKey,translationCacheKey} from '../../shared/bilingual-cache';
import type {ReadingSettings,ReadingStatus,ReadingProcessingSnapshot,ReadingEngineChoice} from '../../shared/reading-processing';
import type {WorkspaceService} from './index';
import type {EnsureLayoutOptions} from './bilingual';
import {layoutStore,PARSE_ENGINES} from './document-layout';
import {createTaskPool} from './task-pool';
import type {PublicRegistry} from '../../shared/model-providers';

interface ProcessingJob extends ReadingStatus {
 hash:string;
 attempts:number;
 retryAt?:number;
 ocrStartedAt?:string;
 translationStartedAt?:string;
}
interface ProcessingState {
 version:1;
 revision:number;
 settings:ReadingSettings;
 seen:Record<string,string>;
 jobs:Record<string,ProcessingJob>;
}
interface ProcessingOptions {
 intervalMs?:number;
 retryDelayMs?:number;
 ocrConcurrency?:1|2;
 translate?:(resourceId:string,sourceId:string,text:string,signal:AbortSignal)=>Promise<string>;
}
type BilingualService={engineOptions:()=>Promise<ReadingEngineChoice[]>;ensureLayout:(id:string,options?:EnsureLayoutOptions)=>Promise<DocumentLayout>};

/** A single durable queue owns background work, independent of reader lifetime. */
export async function registerReadingProcessingRoutes(app:FastifyInstance,root:string,workspace:Pick<WorkspaceService,'resources'|'resourceFile'>,registry:Pick<ProviderRegistry,'publicConfig'>,bilingual:BilingualService,options:ProcessingOptions={}) {
 const store=layoutStore(root);
 const filename=await assertNoSymlinks(root,'workspace/reading-layout/_processing.json',true);
 const lock=`reading-processing:${root}`;
 let state:ProcessingState;
 try {
  state=JSON.parse(await fs.readFile(filename,'utf8'));
  if(state.version!==1||!state.settings||!state.jobs||!state.seen)throw Error('文献处理队列格式无效。');
 }catch(error) {
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  state={version:1,revision:1,settings:{enabled:true,translateAppendix:false,engineId:'aistudio-vl',translationSourceId:null},seen:{},jobs:{}};
  // Existing imports remain available for explicit bulk processing. New imports are detected durably.
  for(const resource of workspace.resources())if(resource.hash)state.seen[resource.id]=resource.hash;
 }
 // Older queues stored only the enabled and appendix flags.
 state.settings.engineId??='aistudio-vl';
 state.settings.translationSourceId??=null;
 const ocrPool=createTaskPool(options.ocrConcurrency??2,{maxLimit:options.ocrConcurrency??4});
 const translationPool=createTaskPool(2,{maxLimit:6});
 const running=new Map<string,{controller:AbortController;promise:Promise<void>}>();

 let closing=false,closed:Promise<void>|undefined,pumping:Promise<void>|undefined,settingsChanges=0;
 let timer:ReturnType<typeof setInterval>|undefined;
 const save=()=>withLock(lock,()=>atomicWrite(filename,JSON.stringify(state)));
 const pdfs=()=>workspace.resources().filter(resource=>resource.kind==='file'&&!resource.missing&&/\.pdf$/i.test(resource.name));
 const touch=(job:ProcessingJob)=>{job.updatedAt=new Date().toISOString();};
 const queue=(id:string,hash:string)=>{
  const job:ProcessingJob={resourceId:id,hash,stage:'queued',done:0,total:0,pageCount:0,appendix:state.settings.translateAppendix,attempts:0};
  touch(job);state.jobs[id]=job;return job;
 };
 for(const job of Object.values(state.jobs))if(job.stage==='ocr'||job.stage==='translating')job.stage='queued';
 await save();

 function translationChoices(config:PublicRegistry){
  return config.translations.filter(source=>source.enabled).flatMap(source=>{
   const model=config.models.find(model=>model.id===source.modelId&&model.enabled);
   if(!model||!config.providers.some(provider=>provider.id===model.providerId&&provider.enabled))return [];
   return [{id:source.id,label:source.label,model:model.label,configured:model.configured}];
  });
 }

 function translationSource(config:PublicRegistry){
  const choices=translationChoices(config);
  const selected=state.settings.translationSourceId;
  const choice=selected?choices.find(source=>source.id===selected):choices[0];
  const source=config.translations.find(source=>source.id===choice?.id);
  const model=config.models.find(model=>model.id===source?.modelId);
  if(!source||!model)throw new HttpError(503,selected?'所选翻译来源已停用或移除，请重新选择。':'请在设置中启用翻译来源。');
  return {id:source.id,label:source.label,model:model.label,modelId:model.model,providerId:model.providerId,configured:model.configured};
 }

 async function translate(resourceId:string,sourceId:string,text:string,signal:AbortSignal) {
  for(let attempt=0;;attempt++){
   try{
    const translated=await translationPool.run(signal,async()=>{
     if(options.translate)return await options.translate(resourceId,sourceId,text,signal);
     const response=await app.inject({method:'POST',url:'/api/ai/translate',signal,payload:{resourceId,sourceId,text,target:'zh-CN',source:'pdf'}});
     signal.throwIfAborted();
     if(response.statusCode!==200){
      const error=JSON.parse(response.body||'{}');
      if(error.code==='translation_cancelled')throw new HttpError(499,'翻译已停止。');
      throw new HttpError(response.statusCode,`翻译暂未完成（HTTP ${response.statusCode}），已保存进度。`);
     }
     let result='',complete=false;
     for(const line of response.body.split('\n').filter(Boolean)){
      const event=JSON.parse(line);
      if(event.type==='error')throw new HttpError(event.code==='translation_cancelled'?499:502,String(event.error));
      if(event.type==='delta')result+=event.text;
      if(event.type==='done'&&event.finishReason==='stop')complete=true;
     }
     if(!complete||!result.trim())throw new HttpError(502,'翻译未完整返回，已保存进度。');
     return result.trim();
    });
    translationPool.recover();return translated;
   }catch(error){
    if(signal.aborted)throw error;
    if(error instanceof HttpError&&[429,500,502,503,504].includes(error.statusCode))translationPool.reduce();
    if(!(error instanceof HttpError)||![429,503].includes(error.statusCode)||attempt>=2)throw error;
    await delay((options.retryDelayMs??1000)*2**attempt,undefined,{signal});
   }
  }
 }

 async function process(job:ProcessingJob,signal:AbortSignal,hasLayout:boolean) {
  job.attempts++;delete job.error;delete job.retryAt;
  const source=translationSource(await registry.publicConfig());
  if(!source.configured)throw new HttpError(503,`${source.label}尚未配置密钥，请在设置中补齐。`);
  const engineId=state.settings.engineId;
  if(!PARSE_ENGINES.some(engine=>engine.id===engineId))throw new HttpError(503,'所选 OCR 引擎不可用，请重新选择。');
  const peers=workspace.resources().filter(resource=>resource.hash===job.hash).map(resource=>resource.id);
  const cached=hasLayout?await store.reuseLayout(job.resourceId,job.hash,peers):null;
  const layout=cached?.sourceHash===job.hash?cached:await ocrPool.run(signal,async()=>{
   const reused=await store.reuseLayout(job.resourceId,job.hash,peers);
   if(reused)return reused;
   const started=Date.now();job.ocrStartedAt=new Date(started).toISOString();
   job.stage='ocr';touch(job);await save();
   const result=await bilingual.ensureLayout(job.resourceId,{engine:engineId,allowSwitch:false,signal,onBackpressure:()=>ocrPool.reduce(),onProgress:completedPages=>{
    if(completedPages<=job.pageCount)return;
    job.pageCount=completedPages;touch(job);
    void save().catch(error=>app.log.error(error,'OCR progress could not be saved'));
   }});
   job.ocrMs=Date.now()-started;ocrPool.recover();return result;
  });
  signal.throwIfAborted();
  if(layout.sourceHash!==job.hash)throw new HttpError(409,'原文已更新，等待处理新版本。');
  const document=buildBilingualDocument(layout,{translateAppendix:job.appendix});
  const blocks=document.blocks.filter(block=>block.translate);
  if(!blocks.length)throw new HttpError(422,'OCR 未提取到可翻译正文，请检查解析结果。');
  const translations=await store.readTranslations(job.resourceId);
  job.pageCount=layout.pageCount;job.total=blocks.length;
  job.done=blocks.filter(block=>cachedTranslationKey(translations,'zh-CN',block.text)).length;
  const translationStarted=Date.now();
  job.translationStartedAt=new Date(translationStarted).toISOString();
  job.stage='translating';touch(job);await save();
  const pending=new Map<string,(typeof blocks)[number]>();
  for(const block of blocks){
   if(!cachedTranslationKey(translations,'zh-CN',block.text))pending.set(translationCacheKey(source,'zh-CN',block.text),block);
  }
  const queue=[...pending.values()];
  let next=0,failure:unknown;
  const worker=async()=>{
   while(!failure&&!signal.aborted&&next<queue.length){
    const block=queue[next++];
    try{
     signal.throwIfAborted();
     const pieces=block.text.match(/[\s\S]{1,5500}/g)??[];
     const translated:string[]=[];
     for(const piece of pieces)translated.push(await translate(job.resourceId,source.id,piece,signal));
     signal.throwIfAborted();
     const detail=await workspace.resourceFile(job.resourceId);
     if(detail.hash!==job.hash)throw new HttpError(409,'原文已更新，等待处理新版本。');
     const key=translationCacheKey(source,'zh-CN',block.text),text=translated.join('\n');
     await store.mergeTranslations(job.resourceId,{[key]:text},job.hash);
     translations[key]=text;
     job.done=blocks.filter(candidate=>cachedTranslationKey(translations,'zh-CN',candidate.text)).length;
     job.translationMs=Date.now()-translationStarted;touch(job);await save();
    }catch(error){failure??=error;}
   }
  };
  // Drain already-started blocks before a retry can claim this document again.
  await Promise.all(Array.from({length:Math.min(2,queue.length)},worker));
  if(failure)throw failure;
  job.translationMs=Date.now()-translationStarted;
  signal.throwIfAborted();
  const detail=await workspace.resourceFile(job.resourceId);
  if(detail.hash!==job.hash)throw new HttpError(409,'原文已更新，等待处理新版本。');
  // Source anchors and translation keys make the cache reusable by later analysis tools.
  const usedKeys=blocks.map(block=>cachedTranslationKey(translations,'zh-CN',block.text)).filter((key):key is string=>!!key);
  const cachedSources=[...new Set(usedKeys.map(key=>key.split('|').slice(0,2).join('|')))].map(key=>{
   const [id,modelLabel]=key.split('|');return {id,modelLabel};
  });
  const analysis={version:1,resourceId:job.resourceId,sourceHash:job.hash,sourcePath:detail.resource.path,
   cachedAt:new Date().toISOString(),target:'zh-CN',translateAppendix:job.appendix,
   layoutFile:`${job.resourceId}.json`,translationsFile:`${job.resourceId}.translations.json`,
   engine:layout.engine??null,configuredTranslationSource:source,cachedTranslationSources:cachedSources,
   blocks:document.blocks.map(({imageUrl,...block})=>({...block,hasImage:!!imageUrl,
    translationKey:cachedTranslationKey(translations,'zh-CN',block.text)??null}))};
  await withLock(`bilingual:${root}:${job.resourceId}`,async()=>{
   const current=await store.readLayout(job.resourceId);
   if(current?.sourceHash!==job.hash||current.parsedAt!==layout.parsedAt)throw new HttpError(409,'版面缓存已更新。');
   await store.writeAnalysis(job.resourceId,analysis);
  });
  job.stage='complete';touch(job);await save();
 }

 function start(job:ProcessingJob,hasLayout:boolean){
  const controller=new AbortController();
  const task=Promise.resolve().then(()=>process(job,controller.signal,hasLayout)).catch(async error=>{
   const cancelled=error instanceof Error&&(error.name==='AbortError'||(error as NodeJS.ErrnoException).code==='FST_ERR_REOPENED_CLOSE_SERVER');
   if(closing||controller.signal.aborted||(error instanceof HttpError&&error.statusCode===499)||cancelled){
    job.stage='queued';job.attempts=Math.max(0,job.attempts-1);delete job.error;delete job.retryAt;
   }else{
    job.error=error instanceof HttpError?error.message:'处理暂未完成，请重试。已完成的缓存已保留。';
    job.stage=job.attempts<3?'queued':'failed';
    job.retryAt=Date.now()+Math.min(60000,10000*job.attempts);
   }
   touch(job);await save();
  }).finally(()=>{running.delete(job.resourceId);});
  running.set(job.resourceId,{controller,promise:task});
  return task;
 }

 async function tick(){
  if(closing||settingsChanges||workspaceMaintenance(root).isLocked())return;
  if(pumping){await pumping;return;}
  const started:Promise<void>[]=[];
  pumping=(async()=>{
   let changed=false;
   for(const resource of pdfs()){
    if(!resource.hash||state.seen[resource.id]===resource.hash)continue;
    if(state.settings.enabled){
     if(running.has(resource.id))continue;
     queue(resource.id,resource.hash);
    }
    state.seen[resource.id]=resource.hash;changed=true;
   }
   if(changed)await save();
   const available=ocrPool.limit()+translationPool.limit()-running.size;
   if(!state.settings.enabled||available<=0||closing||settingsChanges)return;
   const candidates=Object.values(state.jobs).filter(job=>job.stage==='queued'&&!running.has(job.resourceId)&&(!job.retryAt||job.retryAt<=Date.now()));
   const ready=await Promise.all(candidates.map(async job=>({job,cached:(await store.readLayout(job.resourceId).catch(()=>null))?.sourceHash===job.hash})));
   // Cached documents can feed translation while the next PDF is still being OCRed.
   ready.sort((a,b)=>Number(b.cached)-Number(a.cached));
   const preparing=[...running.keys()].filter(id=>state.jobs[id].stage!=='translating').length;
   const reserved=ready.filter(candidate=>!candidate.cached).slice(0,Math.max(0,Math.min(available,ocrPool.limit()-preparing)));
   const reservedIds=new Set(reserved.map(candidate=>candidate.job.resourceId));
   const occupiedHashes=new Set([...running.keys()].map(id=>state.jobs[id].hash));
   const selected=[...reserved,...ready.filter(candidate=>!reservedIds.has(candidate.job.resourceId))].filter(({job})=>{
    if(occupiedHashes.has(job.hash))return false;
    occupiedHashes.add(job.hash);return true;
   }).slice(0,available);
   for(const {job,cached} of selected){
    if(closing||settingsChanges||workspaceMaintenance(root).isLocked())break;
    started.push(start(job,cached));
   }
  })();
  try{await pumping;}finally{pumping=undefined;}
  await Promise.allSettled(started);
 }

 async function stopRunning(){
  await pumping?.catch(()=>{});
  const tasks=[...running.values()];
  for(const task of tasks)task.controller.abort();
  await Promise.allSettled(tasks.map(task=>task.promise));
 }

 async function statuses(ids:string[]):Promise<Record<string,ReadingStatus>> {
  const resources=new Map(workspace.resources().map(resource=>[resource.id,resource]));
  const entries=await Promise.all(ids.map(async id=>{
   const resource=resources.get(id);
   if(!resource||resource.kind!=='file'||!/\.pdf$/i.test(resource.name))return null;
   const job=state.jobs[id];
   const base:ReadingStatus={resourceId:id,stage:'uncached',done:0,total:0,pageCount:0,appendix:state.settings.translateAppendix};
   if(job?.hash===resource.hash&&['queued','ocr','translating','failed'].includes(job.stage))return [id,{...job}] as const;
   const own=await store.readLayout(id);
   const layout=own?.sourceHash===resource.hash?own:resource.hash?(await store.reuseLayout(id,resource.hash,[...resources.values()].filter(peer=>peer.hash===resource.hash).map(peer=>peer.id)))??own:own;
   if(!layout)return [id,base] as const;
   if(layout.sourceHash!==resource.hash)return [id,{...base,stage:'stale' as const}] as const;
   const blocks=buildBilingualDocument(layout,{translateAppendix:base.appendix}).blocks.filter(block=>block.translate);
   const translations=await store.readTranslations(id);
   const done=blocks.filter(block=>cachedTranslationKey(translations,'zh-CN',block.text)).length;
   return [id,{...base,pageCount:layout.pageCount,done,total:blocks.length,stage:blocks.length&&done===blocks.length?'complete' as const:'uncached' as const}] as const;
  }));
  return Object.fromEntries(entries.filter(entry=>entry!==null));
 }

 app.get<{Querystring:{ids?:string}}>('/api/workspace/bilingual/processing',async request=>{
  const ids=[...new Set((request.query.ids??'').split(',').filter(Boolean))];
  if(ids.length>1000)throw new HttpError(400,'一次最多查询 1000 篇文献。');
  const [config,engines]=await Promise.all([registry.publicConfig(),bilingual.engineOptions()]);
  let source:ReturnType<typeof translationSource>|undefined;
  try{source=translationSource(config);}catch{/* Keep an unavailable saved selection visible in the controls. */}
  const jobs=Object.values(state.jobs);
  const snapshot:ReadingProcessingSnapshot={revision:state.revision,settings:{...state.settings},
   sources:{engine:PARSE_ENGINES.find(engine=>engine.id===state.settings.engineId)?.label??'所选 OCR 不可用',translation:source?.label??'所选翻译来源不可用'},
   choices:{engines,translations:translationChoices(config)},
   statuses:await statuses(ids),queue:{pending:jobs.filter(job=>job.stage==='queued').length,
    active:jobs.filter(job=>job.stage==='ocr'||job.stage==='translating').length,failed:jobs.filter(job=>job.stage==='failed').length},
   parallelism:{ocr:ocrPool.limit(),translation:translationPool.limit(),activeDocuments:running.size,activeOcr:ocrPool.active(),activeTranslations:translationPool.active(),throttled:ocrPool.throttled()||translationPool.throttled(),ocrMax:ocrPool.maximum(),translationMax:translationPool.maximum()}};
  return snapshot;
 });

 app.put<{Body:Partial<ReadingSettings>&{expectedRevision:number}}>('/api/workspace/bilingual/processing',async request=>{
  workspaceMaintenance(root).assertAvailable();
  if(request.body?.expectedRevision!==state.revision)throw new HttpError(409,'自动处理设置已更新，请刷新后重试。');
  for(const key of ['enabled','translateAppendix'] as const)if(request.body[key]!==undefined&&typeof request.body[key]!=='boolean')throw new HttpError(400,'自动处理设置无效。');
  const {engineId,translationSourceId}=request.body;
  if(engineId!==undefined&&!PARSE_ENGINES.some(engine=>engine.id===engineId))throw new HttpError(400,'请选择可用的 OCR 引擎。');
  if(translationSourceId!==undefined&&translationSourceId!==null){
   const choices=translationChoices(await registry.publicConfig());
   if(typeof translationSourceId!=='string'||!choices.some(source=>source.id===translationSourceId))throw new HttpError(400,'请选择已启用的翻译来源。');
  }
  if(request.body.expectedRevision!==state.revision)throw new HttpError(409,'自动处理设置已更新，请刷新后重试。');
  settingsChanges++;
  try{
   await stopRunning();
   await withLock(lock,async()=>{
    if(request.body.expectedRevision!==state.revision)throw new HttpError(409,'自动处理设置已更新，请刷新后重试。');
    const sourceChanged=(engineId!==undefined&&engineId!==state.settings.engineId)||(translationSourceId!==undefined&&translationSourceId!==state.settings.translationSourceId);
    const appendixChanged=request.body.translateAppendix!==undefined&&request.body.translateAppendix!==state.settings.translateAppendix;
    for(const key of ['enabled','translateAppendix'] as const) {
     if(request.body[key]!==undefined)state.settings[key]=request.body[key];
    }
    if(engineId!==undefined)state.settings.engineId=engineId;
    if(translationSourceId!==undefined)state.settings.translationSourceId=translationSourceId;
    for(const job of Object.values(state.jobs)) {
     if(sourceChanged&&job.stage!=='complete'){job.stage='queued';job.attempts=0;delete job.error;delete job.retryAt;touch(job);}
     if(job.appendix===state.settings.translateAppendix)continue;
     job.appendix=state.settings.translateAppendix;job.attempts=0;job.stage='queued';delete job.retryAt;
    }
    if(appendixChanged){
     for(const resource of pdfs()){
      const layout=await store.readLayout(resource.id);
      if(layout&&layout.sourceHash===resource.hash)queue(resource.id,resource.hash!);
     }
    }
    state.revision++;
    await atomicWrite(filename,JSON.stringify(state));
  });
   return {revision:state.revision,settings:state.settings};
  }finally{settingsChanges--;}
 });

 app.post<{Body:{resourceIds:string[]}}>('/api/workspace/bilingual/processing',async request=>{
  workspaceMaintenance(root).assertAvailable();
  const ids=request.body?.resourceIds;
  if(!Array.isArray(ids)||ids.length>1000||ids.some(id=>typeof id!=='string'))throw new HttpError(400,'请选择需要缓存的 PDF。');
  const resources=new Map(pdfs().map(resource=>[resource.id,resource]));
  const accepted=[...new Set(ids)].map(id=>{
   const resource=resources.get(id);
   if(!resource?.hash)throw new HttpError(404,'PDF 不存在或已失联。');
   return resource;
  });
  for(const resource of accepted) {
   const previous=state.jobs[resource.id];
   if(previous&&['ocr','translating','queued'].includes(previous.stage)){
    if(previous.stage==='queued'&&previous.error){delete previous.retryAt;previous.attempts=0;}
    continue;
   }
   queue(resource.id,resource.hash!);
  }
  await save();
  return {queued:accepted.length};
 });

 app.addHook('onReady',async()=>{
  timer=setInterval(()=>{void tick().catch(error=>app.log.error(error,'Background reading processing failed'));},options.intervalMs??2000);
  timer.unref();
 });
 async function close(persist=true) {
  if(closed)return closed;
  closing=true;if(timer)clearInterval(timer);
  closed=(async()=>{await stopRunning();if(persist)await save();})();
  return closed;
 }
 app.addHook('preClose',()=>close());
 return {busy:()=>running.size>0||!!pumping,checkpoint:save,close,tick};
}
