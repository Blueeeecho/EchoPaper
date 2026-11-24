import fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import type {FastifyInstance} from 'fastify';
import {atomicWrite,withLock} from '../storage';
import {assertNoSymlinks,HttpError} from '../security';
import {workspaceMaintenance} from '../agents/maintenance';
import type {ProviderRegistry} from '../model-providers';
import {buildBilingualDocument,type DocumentLayout} from '../../shared/bilingual';
import {textFingerprint,translationCacheKey,translationKeyIndex} from '../../shared/bilingual-cache';
import type {ReadingSettings,ReadingStatus,ReadingProcessingSnapshot,ReadingEngineChoice} from '../../shared/reading-processing';
import type {WorkspaceService} from './index';
import type {EnsureLayoutOptions} from './bilingual';
import {layoutStore,OcrResumeBlocked,PARSE_ENGINES,type OcrJobPart} from './document-layout';
import {createTaskPool} from './task-pool';
import {isDedicatedTranslationSource,type PublicRegistry} from '../../shared/model-providers';

interface ProcessingJob extends ReadingStatus {
 hash:string;
 attempts:number;
 retryAt?:number;
 ocrStartedAt?:string;
 ocr?:{engineId:string;parts:Record<number,OcrJobPart>};
 translationStartedAt?:string;
}
interface ProcessingState {
 version:1;
 ocrCheckpoints?:true;
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
 onEvent?:(event:any)=>void;
}
type BilingualService={engineOptions:()=>Promise<ReadingEngineChoice[]>;ensureLayout:(id:string,options?:EnsureLayoutOptions)=>Promise<DocumentLayout>};
type WorkspaceView=Pick<WorkspaceService,'resources'|'resourceFile'>&Partial<Pick<WorkspaceService,'resourcesRef'|'onResourcesChanged'|'onEvent'>>;

function isPermanentAuthOrQuotaError(error:unknown):boolean {
 if(error instanceof HttpError&&[401,402,403,456].includes(error.statusCode))return true;
 const extraStatus=(error as {extra?:{upstreamStatus?:number}}|undefined)?.extra?.upstreamStatus;
 if(typeof extraStatus==='number'&&[401,402,403,456].includes(extraStatus))return true;
 const upstream=(error as {upstream?:number}|undefined)?.upstream;
 if(typeof upstream==='number'&&[401,402,403,456].includes(upstream))return true;
 const msg=error instanceof Error?error.message:'';
 return /用量上限|额度已用尽|额度已耗尽|额度不足|余额或额度不足|insufficient.?quota|令牌无效|无权调用|认证失败|APP ID 或密钥无效/i.test(msg);
}

/** A single durable queue owns background work, independent of reader lifetime. */
export async function registerReadingProcessingRoutes(app:FastifyInstance,root:string,workspace:WorkspaceView,registry:Pick<ProviderRegistry,'publicConfig'>,bilingual:BilingualService,options:ProcessingOptions={}) {
 const store=layoutStore(root);
 const lock=`reading-processing:${root}`;
 const emitEvent=options.onEvent??workspace.onEvent;
 const emitProcessing=()=>{try{emitEvent?.({type:'reading.processing',projectId:''});}catch{/* Event delivery never breaks processing. */}};
 function unavailable(error: unknown) {
  app.log.warn({err:error},'Reading processing queue unavailable');
  const message='自动文献处理队列无法读写，原队列与已有缓存已保留。请检查 workspace/reading-layout/_processing.json 后重启。';
  app.route({method:['GET','PUT','POST'],url:'/api/workspace/bilingual/processing',
   handler:(_request,reply)=>reply.code(503).send({error:message})});
  const idle=async()=>{};
  return {busy:()=>false,checkpoint:idle,close:async(_persist?:boolean)=>{},tick:idle};
 }
 let filename: string;
 let state:ProcessingState;
 try {
  filename=await assertNoSymlinks(root,'workspace/reading-layout/_processing.json',true);
  state=JSON.parse(await fs.readFile(filename,'utf8'));
  if(state?.version!==1||!Number.isSafeInteger(state.revision)||typeof state.settings?.enabled!=='boolean'
     ||!state.jobs||typeof state.jobs!=='object'||Array.isArray(state.jobs)
     ||Object.values(state.jobs).some(job=>!job||typeof job.resourceId!=='string'||typeof job.hash!=='string'||
      (job.ocr&&(!PARSE_ENGINES.some(engine=>engine.id===job.ocr?.engineId)||
       !job.ocr.parts||Array.isArray(job.ocr.parts)||typeof job.ocr.parts!=='object'||
       Object.entries(job.ocr.parts).some(([part,entry])=>!/^\d+$/.test(part)||!entry||
        (entry.state!=='submitting'&&(!['accepted','failed'].includes(entry.state)||typeof entry.id!=='string'||!entry.id))))))
     ||!state.seen||typeof state.seen!=='object'||Array.isArray(state.seen))throw Error('文献处理队列格式无效。');
 }catch(error) {
  if((error as NodeJS.ErrnoException).code!=='ENOENT')return unavailable(error);
  filename=await assertNoSymlinks(root,'workspace/reading-layout/_processing.json',true);
  state={version:1,revision:1,settings:{enabled:true,translateAppendix:false,engineId:'aistudio-vl',translationSourceId:null},seen:{},jobs:{}};
  // Existing imports remain available for explicit bulk processing. New imports are detected durably.
  for(const resource of (workspace.resourcesRef?.()??workspace.resources()))if(resource.hash)state.seen[resource.id]=resource.hash;
 }
 // Older queues stored only the enabled and appendix flags.
 state.settings.engineId??='aistudio-vl';
 state.settings.translationSourceId??=null;
 const initialOcr=options.ocrConcurrency??(state.settings.engineId==='aistudio-vl'?1:2);
 const maxOcr=options.ocrConcurrency??(state.settings.engineId==='aistudio-vl'?1:4);
 const ocrPool=createTaskPool(initialOcr,{maxLimit:maxOcr});
 const translationPool=createTaskPool(2,{maxLimit:6});
 const running=new Map<string,{controller:AbortController;promise:Promise<void>}>();
 const statusCache=new Map<string,{stamp:string;status:ReadingStatus}>();
 const layoutHashCache=new Map<string,{stamp:string;sourceHash:string}>();
 const autoSchedule=options.intervalMs===undefined||options.intervalMs<=10000;

 let closing=false,closed:Promise<void>|undefined,pumping:Promise<void>|undefined,settingsChanges=0;
 let wakeTimer:ReturnType<typeof setTimeout>|undefined;
 let unsubscribeResources:(()=>void)|undefined;
 const save=()=>withLock(lock,()=>atomicWrite(filename,JSON.stringify(state)));
 const allResources=()=>workspace.resourcesRef?.()??workspace.resources();
 const pdfs=()=>allResources().filter(resource=>resource.kind==='file'&&!resource.missing&&/\.pdf$/i.test(resource.name));
 const touch=(job:ProcessingJob)=>{job.updatedAt=new Date().toISOString();};
 const effectiveOcrLimit=()=>!options.ocrConcurrency&&state.settings.engineId==='aistudio-vl'?1:ocrPool.limit();
 const effectiveOcrMax=()=>!options.ocrConcurrency&&state.settings.engineId==='aistudio-vl'?1:ocrPool.maximum();
 const queue=(id:string,hash:string)=>{
  const job:ProcessingJob={resourceId:id,hash,stage:'queued',done:0,total:0,pageCount:0,appendix:state.settings.translateAppendix,attempts:0};
  touch(job);state.jobs[id]=job;statusCache.delete(id);return job;
 };
 async function fileStamp(id:string,suffix:string):Promise<string>{
  try{
   const target=await assertNoSymlinks(root,`workspace/reading-layout/${id}${suffix}.json`,true);
   const stat=await fs.stat(target);
   return `${stat.mtimeMs}:${stat.size}`;
  }catch(error:any){if(error.code==='ENOENT')return '';throw error;}
 }
 function rememberStatus(id:string,stamp:string,status:ReadingStatus){
  statusCache.delete(id);
  statusCache.set(id,{stamp,status});
  if(statusCache.size>2000)statusCache.delete(statusCache.keys().next().value!);
 }
 for(const job of Object.values(state.jobs)){
  if(!state.ocrCheckpoints&&!job.ocr&&(job.stage==='ocr'||(job.stage==='queued'&&job.ocrStartedAt))){
   // A pre-upgrade pause could have lost an accepted provider task ID.
   const engineId=PARSE_ENGINES.some(engine=>engine.id===state.settings.engineId)?state.settings.engineId:'aistudio-vl';
   job.ocr={engineId,parts:{0:{state:'submitting'}}};
  }
  if(job.stage==='ocr'||job.stage==='translating')job.stage='queued';
 }
 state.ocrCheckpoints=true;
 try { await save(); } catch (error) { return unavailable(error); }

 function scheduleWake(delayMs?:number){
  if(!autoSchedule||closing)return;
  if(wakeTimer){clearTimeout(wakeTimer);wakeTimer=undefined;}
  let wait=delayMs;
  if(wait===undefined){
   if(!state.settings.enabled)return;
   const now=Date.now();
   let earliest=Infinity;
   for(const job of Object.values(state.jobs)){
    if(job.stage!=='queued'||running.has(job.resourceId))continue;
    earliest=Math.min(earliest,job.retryAt??now);
   }
   if(!Number.isFinite(earliest))return;
   wait=Math.max(50,earliest-now);
  }
  wakeTimer=setTimeout(()=>{
   wakeTimer=undefined;
   void tick().catch(error=>app.log.error(error,'Background reading processing failed'));
  },wait);
  wakeTimer.unref();
 }

 function translationChoices(config:PublicRegistry){
  return config.translations.filter(source=>source.enabled&&isDedicatedTranslationSource(config,source)).flatMap(source=>{
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
     if(!options.translate)throw new HttpError(503,'后台翻译服务尚未初始化。');
     const output=await options.translate(resourceId,sourceId,text,signal);
     signal.throwIfAborted();
     if(!output.trim())throw new HttpError(502,'翻译未完整返回，已保存进度。');
     return output.trim();
    });
    translationPool.recover();return translated;
   }catch(error){
    if(signal.aborted||isPermanentAuthOrQuotaError(error))throw error;
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
  const engineId=job.ocr?.engineId??state.settings.engineId;
  if(!PARSE_ENGINES.some(engine=>engine.id===engineId))throw new HttpError(503,'所选 OCR 引擎不可用，请重新选择。');
  const peers=allResources().filter(resource=>resource.hash===job.hash).map(resource=>resource.id);
  const cached=hasLayout?await store.reuseLayout(job.resourceId,job.hash,peers):null;
  const layout=cached?.sourceHash===job.hash?cached:await ocrPool.run(signal,async()=>{
   const reused=await store.reuseLayout(job.resourceId,job.hash,peers);
   if(reused)return reused;
   const started=Date.now();job.ocrStartedAt=new Date(started).toISOString();
   job.stage='ocr';touch(job);await save();emitProcessing();
   const result=await bilingual.ensureLayout(job.resourceId,{engine:engineId,allowSwitch:false,signal,expectedSourceHash:job.hash,checkpoint:{
    read:part=>job.ocr?.parts[part],
    async write(part,value){
     const ocr=job.ocr??={engineId,parts:{}};
     if(value)ocr.parts[part]=value;
     else {
      delete ocr.parts[part];
      if(!Object.keys(ocr.parts).length)delete job.ocr;
     }
     await save();
    },
   },onBackpressure:()=>ocrPool.reduce(),onProgress:completedPages=>{
    if(completedPages<=job.pageCount)return;
    job.pageCount=completedPages;touch(job);emitProcessing();
    void save().catch(error=>app.log.error(error,'OCR progress could not be saved'));
   }});
   job.ocrMs=Date.now()-started;ocrPool.recover();return result;
  });
  signal.throwIfAborted();
  if(layout.sourceHash!==job.hash)throw new HttpError(409,'原文已更新，等待处理新版本。');
  delete job.ocr;
  const document=buildBilingualDocument(layout,{translateAppendix:job.appendix});
  const blocks=document.blocks.filter(block=>block.translate);
  if(!blocks.length)throw new HttpError(422,'OCR 未提取到可翻译正文，请检查解析结果。');
  const translations=await store.readTranslations(job.resourceId);
  const keyIndex=translationKeyIndex(translations);
  const blockFingerprints=blocks.map(block=>textFingerprint('zh-CN',block.text));
  const countDone=()=>blockFingerprints.reduce((total,fp)=>total+(keyIndex.has(fp)?1:0),0);
  job.pageCount=layout.pageCount;job.total=blocks.length;
  job.done=countDone();
  const translationStarted=Date.now();
  job.translationStartedAt=new Date(translationStarted).toISOString();
  job.stage='translating';touch(job);await save();emitProcessing();
  const pending=new Map<string,{block:(typeof blocks)[number];fp:string}>();
  blocks.forEach((block,index)=>{
   const fp=blockFingerprints[index];
   if(!keyIndex.has(fp))pending.set(translationCacheKey(source,'zh-CN',block.text),{block,fp});
  });
  const queueItems=[...pending.values()];
  let next=0,failure:unknown;
  let pendingBatch:Record<string,string>={};
  let pendingCount=0;
  let lastFlushedAt=Date.now();
  let flushing:Promise<void>=Promise.resolve();

  const flushBatch=async(force=false)=>{
   if(!pendingCount)return;
   if(!force&&pendingCount<5&&Date.now()-lastFlushedAt<2000)return;
   const batch=pendingBatch;
   pendingBatch={};
   pendingCount=0;
   lastFlushedAt=Date.now();
   const detail=await workspace.resourceFile(job.resourceId);
   if(detail.hash!==job.hash)throw new HttpError(409,'原文已更新，等待处理新版本。');
   await store.mergeTranslations(job.resourceId,batch,job.hash);
   job.done=countDone();
   job.translationMs=Date.now()-translationStarted;
   touch(job);await save();emitProcessing();
  };
  const enqueueFlush=(force=false)=>{
   flushing=flushing.then(()=>flushBatch(force));
   return flushing;
  };

  const worker=async()=>{
   while(!failure&&!signal.aborted&&next<queueItems.length){
    const {block,fp}=queueItems[next++];
    try{
     signal.throwIfAborted();
     const pieces=block.text.match(/[\s\S]{1,5500}/g)??[];
     const translated:string[]=[];
     for(const piece of pieces)translated.push(await translate(job.resourceId,source.id,piece,signal));
     signal.throwIfAborted();
     const key=translationCacheKey(source,'zh-CN',block.text),text=translated.join('\n');
     translations[key]=text;
     keyIndex.set(fp,key);
     pendingBatch[key]=text;
     pendingCount++;
     if(pendingCount>=5||Date.now()-lastFlushedAt>=2000)await enqueueFlush(false);
    }catch(error){failure??=error;}
   }
  };
  // Drain already-started blocks before a retry can claim this document again.
  await Promise.all(Array.from({length:Math.min(2,queueItems.length)},worker));
  try{
   if(pendingCount&&!signal.aborted)await enqueueFlush(true);
   else await flushing;
  }catch(error){failure??=error;}
  if(failure)throw failure;
  job.translationMs=Date.now()-translationStarted;
  signal.throwIfAborted();
  const detail=await workspace.resourceFile(job.resourceId);
  if(detail.hash!==job.hash)throw new HttpError(409,'原文已更新，等待处理新版本。');
  // Source anchors and translation keys make the cache reusable by later analysis tools.
  const usedKeys=blockFingerprints.map(fp=>keyIndex.get(fp)).filter((key):key is string=>!!key);
  const cachedSources=[...new Set(usedKeys.map(key=>key.split('|').slice(0,2).join('|')))].map(key=>{
   const [id,modelLabel]=key.split('|');return {id,modelLabel};
  });
  const analysis={version:1,resourceId:job.resourceId,sourceHash:job.hash,sourcePath:detail.resource.path,
   cachedAt:new Date().toISOString(),target:'zh-CN',translateAppendix:job.appendix,
   layoutFile:`${job.resourceId}.json`,translationsFile:`${job.resourceId}.translations.json`,
   engine:layout.engine??null,configuredTranslationSource:source,cachedTranslationSources:cachedSources,
   blocks:document.blocks.map(({imageUrl,...block})=>({...block,hasImage:!!imageUrl,
    translationKey:keyIndex.get(textFingerprint('zh-CN',block.text))??null}))};
  await withLock(`bilingual:${root}:${job.resourceId}`,async()=>{
   const current=await store.readLayout(job.resourceId);
   if(current?.sourceHash!==job.hash||current.parsedAt!==layout.parsedAt)throw new HttpError(409,'版面缓存已更新。');
   await store.writeAnalysis(job.resourceId,analysis);
  });
  job.done=countDone();
  job.stage='complete';touch(job);await save();
  statusCache.delete(job.resourceId);
  emitProcessing();
 }

 function start(job:ProcessingJob,hasLayout:boolean){
  const controller=new AbortController();
  const task=Promise.resolve().then(()=>process(job,controller.signal,hasLayout)).catch(async error=>{
   const cancelled=error instanceof Error&&(error.name==='AbortError'||(error as NodeJS.ErrnoException).code==='FST_ERR_REOPENED_CLOSE_SERVER');
   if(closing||controller.signal.aborted||(error instanceof HttpError&&error.statusCode===499)||cancelled){
    job.stage='queued';job.attempts=Math.max(0,job.attempts-1);delete job.error;delete job.retryAt;
   }else if(isPermanentAuthOrQuotaError(error)){
    job.error=error instanceof HttpError?error.message:'上游服务鉴权或额度受限，自动处理已暂停，请检查配置后恢复。';
    job.stage='failed';
    delete job.retryAt;
    if(state.settings.enabled){
     state.settings.enabled=false;
     state.revision++;
    }
   }else{
    job.error=error instanceof HttpError?error.message:'处理暂未完成，请重试。已完成的缓存已保留。';
    job.stage=!(error instanceof OcrResumeBlocked)&&job.attempts<3?'queued':'failed';
    job.retryAt=Date.now()+Math.min(60000,10000*job.attempts);
   }
   touch(job);await save();emitProcessing();
  }).finally(()=>{
   running.delete(job.resourceId);
   scheduleWake();
  });
  running.set(job.resourceId,{controller,promise:task});
  return task;
 }

 async function hasMatchingLayout(job:ProcessingJob):Promise<boolean>{
  const stamp=await fileStamp(job.resourceId,'');
  if(!stamp)return false;
  const cached=layoutHashCache.get(job.resourceId);
  if(cached&&cached.stamp===stamp)return cached.sourceHash===job.hash;
  const layout=await store.readLayout(job.resourceId).catch(()=>null);
  if(!layout)return false;
  layoutHashCache.set(job.resourceId,{stamp,sourceHash:layout.sourceHash});
  if(layoutHashCache.size>2000)layoutHashCache.delete(layoutHashCache.keys().next().value!);
  return layout.sourceHash===job.hash;
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
   if(changed){await save();emitProcessing();}
   const ocrCap=effectiveOcrLimit();
   const available=ocrCap+translationPool.limit()-running.size;
   if(!state.settings.enabled||available<=0||closing||settingsChanges)return;
   const now=Date.now();
   const candidates=Object.values(state.jobs).filter(job=>job.stage==='queued'&&!running.has(job.resourceId)&&(!job.retryAt||job.retryAt<=now));
   if(!candidates.length){scheduleWake();return;}
   const ready=await Promise.all(candidates.map(async job=>({job,cached:await hasMatchingLayout(job)})));
   // Cached documents can feed translation while the next PDF is still being OCRed.
   ready.sort((a,b)=>Number(b.cached)-Number(a.cached));
   const preparing=[...running.keys()].filter(id=>state.jobs[id].stage!=='translating').length;
   const reserved=ready.filter(candidate=>!candidate.cached).slice(0,Math.max(0,Math.min(available,ocrCap-preparing)));
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
  scheduleWake();
 }

 async function stopRunning(){
  await pumping?.catch(()=>{});
  const tasks=[...running.values()];
  for(const task of tasks)task.controller.abort();
  await Promise.allSettled(tasks.map(task=>task.promise));
 }

 async function statuses(ids:string[]):Promise<Record<string,ReadingStatus>> {
  const resources=new Map(allResources().map(resource=>[resource.id,resource]));
  const entries=await Promise.all(ids.map(async id=>{
   const resource=resources.get(id);
   if(!resource||resource.kind!=='file'||!/\.pdf$/i.test(resource.name))return null;
   const job=state.jobs[id];
   const base:ReadingStatus={resourceId:id,stage:'uncached',done:0,total:0,pageCount:0,appendix:state.settings.translateAppendix};
   if(job?.hash===resource.hash&&['queued','ocr','translating','failed'].includes(job.stage))return [id,{...job}] as const;
   const [layoutStamp,translationStamp]=await Promise.all([fileStamp(id,''),fileStamp(id,'.translations')]);
   if(job?.hash===resource.hash&&job.stage==='complete'&&job.appendix===base.appendix&&job.total>0&&layoutStamp){
    return [id,{...base,pageCount:job.pageCount,done:job.done,total:job.total,stage:'complete' as const}] as const;
   }
   const signature=`${layoutStamp}|${translationStamp}|${resource.hash??''}|${base.appendix}`;
   const cached=statusCache.get(id);
   if(cached&&cached.stamp===signature)return [id,cached.status] as const;
   const own=layoutStamp?await store.readLayout(id):null;
   const layout=own?.sourceHash===resource.hash?own:resource.hash?(await store.reuseLayout(id,resource.hash,[...resources.values()].filter(peer=>peer.hash===resource.hash).map(peer=>peer.id)))??own:own;
   if(!layout){rememberStatus(id,signature,base);return [id,base] as const;}
   if(layout.sourceHash!==resource.hash){const stale={...base,stage:'stale' as const};rememberStatus(id,signature,stale);return [id,stale] as const;}
   const blocks=buildBilingualDocument(layout,{translateAppendix:base.appendix}).blocks.filter(block=>block.translate);
   const translations=await store.readTranslations(id);
   const keyIndex=translationKeyIndex(translations);
   const done=blocks.reduce((count,block)=>count+(keyIndex.has(textFingerprint('zh-CN',block.text))?1:0),0);
   const computed:ReadingStatus={...base,pageCount:layout.pageCount,done,total:blocks.length,stage:blocks.length&&done===blocks.length?'complete' as const:'uncached' as const};
   const finalStamp=`${await fileStamp(id,'')}|${await fileStamp(id,'.translations')}|${resource.hash??''}|${base.appendix}`;
   rememberStatus(id,finalStamp,computed);
   return [id,computed] as const;
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
   parallelism:{ocr:effectiveOcrLimit(),translation:translationPool.limit(),activeDocuments:running.size,activeOcr:ocrPool.active(),activeTranslations:translationPool.active(),throttled:ocrPool.throttled()||translationPool.throttled(),ocrMax:effectiveOcrMax(),translationMax:translationPool.maximum()}};
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
     statusCache.clear();
     for(const resource of pdfs()){
      const stamp=await fileStamp(resource.id,'');
      if(!stamp)continue;
      const layout=await store.readLayout(resource.id);
      if(layout&&layout.sourceHash===resource.hash)queue(resource.id,resource.hash!);
     }
    }
    state.revision++;
    await atomicWrite(filename,JSON.stringify(state));
   });
   emitProcessing();
   if(state.settings.enabled)scheduleWake(50);
   else if(wakeTimer){clearTimeout(wakeTimer);wakeTimer=undefined;}
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
   const next=queue(resource.id,resource.hash!);
   if(previous?.hash===resource.hash&&previous.ocr){
    const parts=Object.fromEntries(Object.entries(previous.ocr.parts).filter(([,part])=>part.state!=='failed'));
    if(Object.keys(parts).length)next.ocr={engineId:previous.ocr.engineId,parts};
   }
  }
  await save();
  emitProcessing();
  scheduleWake(50);
  return {queued:accepted.length};
 });

 app.addHook('onReady',async()=>{
  if(autoSchedule){
   unsubscribeResources=workspace.onResourcesChanged?.(()=>scheduleWake(200));
   scheduleWake(250);
  }
 });
 async function close(persist=true) {
  if(closed)return closed;
  closing=true;
  if(wakeTimer){clearTimeout(wakeTimer);wakeTimer=undefined;}
  unsubscribeResources?.();unsubscribeResources=undefined;
  closed=(async()=>{await stopRunning();if(persist)await save();})();
  return closed;
 }
 app.addHook('preClose',()=>close());
 return {busy:()=>running.size>0||!!pumping,checkpoint:save,close,tick};
}
