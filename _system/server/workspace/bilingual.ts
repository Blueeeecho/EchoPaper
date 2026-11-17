/**
 * 全文对照的服务端接口：解析版面、读取缓存、保存译文、配置解析密钥。
 *
 * 翻译本身仍走 /api/ai/translate 和读者已配置的翻译来源，这里不持有任何模型密钥。
 */
import fs from 'node:fs/promises';
import type {FastifyInstance} from 'fastify';
import {HttpError} from '../security';
import {workspaceMaintenance} from '../agents/maintenance';
import {withLock} from '../storage';
import {layoutTitle} from './pdf-title';
import type {WorkspaceService} from './index';
import {inlineImages,layoutStore,parseDocument,parseEngine,parsingKeychain,probeCredential,readCredential,usageStore,usageDay,usageMonth,AISTUDIO_BASE_URL,AISTUDIO_PROVIDER,PARSE_ENGINES,MAX_PARSE_PAGES,type ParseDeps,type UsageSettings} from './document-layout';
import type {DocumentLayout} from '../../shared/bilingual';
import type {ReadingEngineChoice} from '../../shared/reading-processing';

export interface EnsureLayoutOptions {force?:boolean;engine?:string;allowSwitch?:boolean;signal?:AbortSignal;onSwitch?:(message:string)=>void;onProgress?:(completedPages:number)=>void;onBackpressure?:()=>void}

export function registerBilingualRoutes(app:FastifyInstance,root:string,workspace:Pick<WorkspaceService,'resourceFile'>&Partial<Pick<WorkspaceService,'resources'>>, deps:ParseDeps={}){
 const store=layoutStore(root),usage=usageStore(root),upstream=deps.fetch??fetch;
 const parseDeps:ParseDeps={...deps,onSample:deps.onSample??((engineId,text)=>{
  // 诊断样本：只留第一行、最多 1MB，核对上游字段时用，失败也不影响解析。
  void fs.writeFile(`${root}/workspace/reading-layout/_sample-${engineId}.json`,text.slice(0,1024*1024),'utf8').catch(()=>{});
 })};
 const active=new Set<AbortController>();
 const running=new Map<string,Promise<DocumentLayout>>();
 app.addHook('preClose',async()=>{for(const controller of active)controller.abort();});

 /** 两套凭据各自独立：智能云的密钥与星河社区的访问令牌。 */
 const credentialFor=(engineId?:string)=>{
  const engine=parseEngine(engineId),aistudio=engine.kind==='aistudio';
  return {provider:aistudio?'AI Studio 星河社区 · PaddleOCR':'百度智能云 · 文档解析',
   read:()=>readCredential(engine,deps),
   write:(key:string)=>aistudio?parsingKeychain(key,AISTUDIO_PROVIDER,AISTUDIO_BASE_URL):parsingKeychain(key)};
 };
 let cachedEngines:Promise<ReadingEngineChoice[]>|undefined,enginesCheckedAt=0;
 function engineOptions(){
  if(!cachedEngines||Date.now()-enginesCheckedAt>5000){
   enginesCheckedAt=Date.now();
   cachedEngines=Promise.all(PARSE_ENGINES.map(async engine=>({id:engine.id,label:engine.label,
    configured:!!(await credentialFor(engine.id).read().catch(()=>'')).trim()})));
  }
  return cachedEngines;
 }
 app.get<{Querystring:{engine?:string}}>('/api/workspace/bilingual/credential',async request=>{
  const engine=parseEngine(request.query?.engine),credential=credentialFor(engine.id);
  const configured=await engineOptions();
  return {configured:!!configured.find(candidate=>candidate.id===engine.id)?.configured,engine:engine.id,provider:credential.provider,
   engines:Object.fromEntries(configured.map(candidate=>[candidate.id,candidate.configured])),freeQuota:'免费额度由账户决定，这里不查询余额。'};
 });
 /** 本月用量与额度设置。接口不返回账户余额，这里给的是 EchoPaper 自己解析掉的页数。 */
 app.get('/api/workspace/bilingual/usage',async()=>{
  const current=await usage.read();
  return {month:usageMonth(),day:usageDay(),engines:PARSE_ENGINES.map(engine=>({id:engine.id,label:engine.label,note:engine.note,kind:engine.kind,
   period:engine.period,used:usage.used(current,engine.id),quota:current.settings.quota[engine.id]??null,
   remaining:usage.remaining(current,engine.id)})),settings:current.settings};
 });
 app.put<{Body:Partial<UsageSettings>}>('/api/workspace/bilingual/usage',async request=>{
  const body=request.body||{},quota:Record<string,number>={};
  for(const engine of PARSE_ENGINES){
   const value=(body.quota as Record<string,unknown>|undefined)?.[engine.id];
   if(value===null||value===undefined)continue;
   // 清空等于显式「不设额度」，记成 0 才不会在下次读取时被默认额度顶回来。
   const pages=value===''?0:Number(value);
   if(!Number.isFinite(pages)||pages<0||pages>10_000_000)throw new HttpError(400,'额度需要是 0 到 1000 万之间的页数。');
   quota[engine.id]=Math.floor(pages);
  }
  const threshold=Number(body.threshold??100);
  if(!Number.isFinite(threshold)||threshold<0||threshold>100000)throw new HttpError(400,'提醒阈值需要是 0 到 100000 之间的页数。');
  return usage.saveSettings({quota,threshold:Math.floor(threshold),autoSwitch:body.autoSwitch!==false});
 });

 /** 只验证凭据，不解析文档，因此不消耗页数额度。 */
 app.post<{Body:{engine?:unknown}}>('/api/workspace/bilingual/credential/test',async request=>{
  const controller=new AbortController();active.add(controller);
  const engine=typeof request.body?.engine==='string'?request.body.engine:undefined;
  try{return {engine:parseEngine(engine).id,...await probeCredential(deps,controller.signal,engine)};}
  finally{active.delete(controller);}
 });
 app.put<{Body:{key?:unknown;engine?:unknown}}>('/api/workspace/bilingual/credential',async request=>{
  const key=request.body?.key;
  if(typeof key!=='string'||!key.trim()||key.length>8192||/[\x00-\x1f]/.test(key))throw new HttpError(400,'密钥格式无效。');
  if(deps.readKey)throw new HttpError(400,'测试环境不写入钥匙串。');
  const engine=parseEngine(typeof request.body?.engine==='string'?request.body.engine:undefined);
  await credentialFor(engine.id).write(key.trim());
  cachedEngines=undefined;
  return {configured:true,engine:engine.id};
 });

 app.get<{Params:{id:string}}>('/api/workspace/resources/:id/bilingual',async request=>{
  const id=request.params.id,detail=await workspace.resourceFile(id);
  const own=await store.readLayout(id);
  const layout=own?.sourceHash===detail.hash?own:(await store.reuseLayout(id,detail.hash,(workspace.resources?.()||[]).filter(resource=>resource.hash===detail.hash).map(resource=>resource.id)))??own;
  if(!layout)return {parsed:false,sourceHash:detail.hash,stale:false,layout:null,translations:{}};
  return {parsed:true,sourceHash:detail.hash,stale:layout.sourceHash!==detail.hash,layout,translations:await store.readTranslations(id)};
 });

 async function ensureLayout(id:string,options:EnsureLayoutOptions={}) {
  workspaceMaintenance(root).assertAvailable();
  const detail=await workspace.resourceFile(id);
  if(!/\.pdf$/i.test(detail.resource.name))throw new HttpError(415,'全文对照目前只支持 PDF 资料。');
  const original=await store.readLayout(id);
  const existing=options.force?original:(await store.reuseLayout(id,detail.hash,(workspace.resources?.()||[]).filter(resource=>resource.hash===detail.hash).map(resource=>resource.id)))??original;
  if(existing&&existing.sourceHash===detail.hash&&!options.force)return existing;
  const pending=running.get(detail.hash);
  if(pending){const shared=await pending;return (await store.reuseLayout(id,detail.hash,[shared.resourceId]))!;}
  const current=await usage.read();
  const asked=parseEngine(options.engine);
  let engine=asked;
  const left=usage.remaining(current,asked.id);
  if(options.allowSwitch!==false&&current.settings.autoSwitch&&left!==null&&left<=current.settings.threshold){
   engine=PARSE_ENGINES.find(candidate=>{
    const remaining=usage.remaining(current,candidate.id);
    return candidate.id!==asked.id&&(remaining===null||remaining>current.settings.threshold);
   })??asked;
  }
  if(engine.id!==asked.id)options.onSwitch?.(`${asked.label}${asked.period==='day'?'今日':'本月'}只剩 ${left} 页，已自动改用${engine.label}。`);
  const concurrent=running.get(detail.hash);
  if(concurrent){const shared=await concurrent;return (await store.reuseLayout(id,detail.hash,[shared.resourceId]))!;}
  const controller=new AbortController();
  const cancel=()=>controller.abort();
  options.signal?.addEventListener('abort',cancel,{once:true});
  if(options.signal?.aborted)controller.abort();
  active.add(controller);
  const task=(async()=>{
   const file=await fs.readFile(detail.filename);
   const {pages,costPages}=await parseDocument(file,detail.resource.name,{...parseDeps,onProgress:options.onProgress??deps.onProgress,onBackpressure:options.onBackpressure??deps.onBackpressure,log:message=>{
    app.log.info({resourceId:id,engine:engine.id},message);
   }},controller.signal,engine.id);
   await usage.record(engine.id,costPages).catch(()=>{});
   if(pages.length>MAX_PARSE_PAGES)throw new HttpError(413,'PDF 超过解析页数上限。');
   await inlineImages(pages,upstream,controller.signal,message=>app.log.warn({resourceId:id},message));
   const layout:DocumentLayout={version:1,resourceId:id,sourceHash:detail.hash,parsedAt:new Date().toISOString(),pageCount:pages.length,costPages,pages,engine:engine.id};
   const latest=await workspace.resourceFile(id);
   if(latest.hash!==detail.hash)throw new HttpError(409,'原文已更新，等待处理新版本。');
   controller.signal.throwIfAborted();
   await withLock(`bilingual:${root}:${id}`,async()=>{
    if(existing&&existing.sourceHash!==detail.hash)await store.archiveLayout(id,existing.sourceHash);
    await store.writeLayout(layout);
   });
   const title=layoutTitle(layout);
   if(title&&!latest.resource.title&&workspace.resources){
    const saved=await app.inject({method:'PATCH',url:`/api/workspace/resources/${id}`,payload:{title,expectedRevision:latest.resource.revision}});
    if(saved.statusCode>=500)app.log.warn({resourceId:id},'OCR title metadata could not be saved.');
   }
   return layout;
  })().finally(()=>{
   running.delete(detail.hash);active.delete(controller);
   options.signal?.removeEventListener('abort',cancel);
  });
  running.set(detail.hash,task);
  return task;
 }

 app.post<{Params:{id:string};Body:{force?:unknown;engine?:unknown}}>('/api/workspace/resources/:id/bilingual',async request=>{
  const id=request.params.id;
  const detail=await workspace.resourceFile(id);
  const existing=await store.readLayout(id);
  const reused=!!existing&&existing.sourceHash===detail.hash&&request.body?.force!==true;
  let switched='';
  const layout=await ensureLayout(id,{onSwitch:message=>{switched=message;},force:request.body?.force===true,engine:typeof request.body?.engine==='string'?request.body.engine:undefined});
  return {layout,reused,translations:await store.readTranslations(id),engine:layout.engine,engineLabel:parseEngine(layout.engine).label,...(switched?{switched}:{})};
 });

 app.delete<{Params:{id:string}}>('/api/workspace/resources/:id/bilingual',async request=>{
  await workspace.resourceFile(request.params.id);
  await withLock(`bilingual:${root}:${request.params.id}`,()=>store.removeLayout(request.params.id));
  return {parsed:false};
 });

 app.post<{Params:{id:string};Body:{entries?:unknown;sourceHash?:string}}>('/api/workspace/resources/:id/bilingual/translations',{bodyLimit:2*1024*1024},async request=>{
  const id=request.params.id,entries=request.body?.entries;
  const detail=await workspace.resourceFile(id);
  if(request.body.sourceHash&&request.body.sourceHash!==detail.hash)throw new HttpError(409,'原文已更新，译文尚未写入。');
  if(!entries||typeof entries!=='object'||Array.isArray(entries))throw new HttpError(400,'译文格式无效。');
  const values=Object.entries(entries as Record<string,unknown>);
  if(values.length>500)throw new HttpError(400,'一次最多保存 500 条译文。');
  if(values.some(([key,value])=>typeof key!=='string'||key.length>200||typeof value!=='string'||value.length>20000))throw new HttpError(400,'译文格式无效。');
  return {stored:await store.mergeTranslations(id,Object.fromEntries(values) as Record<string,string>,request.body.sourceHash??detail.hash)};
 });
 return {ensureLayout,engineOptions};
}
