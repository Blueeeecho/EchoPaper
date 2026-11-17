import fs from 'node:fs/promises';
import {getProject} from '../projects';
import {registeredRoot,assertNoSymlinks} from '../security';
import {fingerprintFile} from './source-fingerprint';
import {checkSourceChain,chainSummary} from './source-chain';
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import type {CatalogState} from './catalog';
import type {ResearchTopic} from '../../shared/workspace-types';
import {USAGE_PURPOSES,usageKey,entryStates,type ResearchUsage,type ResearchEntry,type ResearchEntryKind,type ResearchEntryVersion,type ResearchEntryFields,type ResearchEntrySource} from '../../shared/research-entries';
import {normalizeWorkTarget,safeWorkId,safeWorkFile,workTargetPath} from '../../shared/research-targets';
import {captureWorkTarget,resolveWorkTarget,resolvedTargetPath,workTargetOptions} from './research-targets';
import {HttpError} from '../security';
const object=(input:unknown):Record<string,unknown>=>{if(!input||typeof input!=='object'||Array.isArray(input))throw new HttpError(400,'记录内容必须为对象。');return input as Record<string,unknown>;};
const string=(value:unknown,label:string,max:number,required=false)=>{if(typeof value!=='string'||value.length>max||required&&!value.trim())throw new HttpError(400,`${label}无效。`);return value;};
export function registerResearchEntryRoutes(app:FastifyInstance,{root,state,mutate,save}:{root:string;state:CatalogState;mutate:<T>(fn:()=>Promise<T>)=>Promise<T>;save:()=>Promise<void>}){
 const topic=(id:string)=>{const t=state.topics.find(t=>t.id===id);if(!t)throw new HttpError(404,'研究课题不存在。');return t;};
 const context=(t:ResearchTopic)=>({root,topic:t,resources:state.resources,roots:state.roots});
 const entry=(t:ResearchTopic,id:string)=>{const e=t.workEntries?.find(e=>e.id===id);if(!e)throw new HttpError(404,'研究条目不存在，未打开其他条目。');return e;};
 function version(e:ResearchEntry,raw?:string):ResearchEntryVersion {if(raw===undefined)return e;if(!/^[1-9]\d{0,5}$/.test(raw))throw new HttpError(400,'条目版本无效。');const n=Number(raw),v=n===e.revision?e:e.history.find(v=>v.revision===n);if(!v)throw new HttpError(404,'指定历史版本不存在。');return v;}
 const cas=(input:Record<string,unknown>,t:ResearchTopic,e?:ResearchEntry)=>{if(t.archived)throw new HttpError(409,'课题已归档，请先恢复。');if(input.expectedRevision!==t.revision||e&&input.expectedEntryRevision!==e.revision)throw new HttpError(409,'记录已变化，请重读并比较；本次内容不会覆盖。');};
 async function fields(input:Record<string,unknown>,t:ResearchTopic,id:string,kind:ResearchEntryKind,old?:ResearchEntry):Promise<ResearchEntryFields>{
  const result={} as ResearchEntryFields;
  for(const [key,max]of [['title',200],['question',10000],['protocol',50000],['observation',50000],['conclusion',20000],['limitations',20000]] as const)result[key]=string(input[key]===undefined?old?.[key]||'':input[key],key,max,key==='title');
  const status=input.state===undefined?old?.state||(kind==='experiment'?'planned':'unassessed'):input.state;
  if(typeof status!=='string'||!Object.hasOwn(entryStates(kind),status))throw new HttpError(400,'请选择适用于该条目类型的状态。');result.state=status as ResearchEntryFields['state'];
  if(input.archived!==undefined&&typeof input.archived!=='boolean')throw new HttpError(400,'归档状态无效。');result.archived=input.archived===undefined?old?.archived||false:input.archived as boolean;
  if(input.refreshSources!==undefined&&typeof input.refreshSources!=='boolean')throw new HttpError(400,'来源更新选项无效。');
  const sources=input.sources===undefined?old?.sources.map(s=>s.target)||[]:input.sources;
  if(!Array.isArray(sources)||sources.length>20)throw new HttpError(400,'每条记录最多关联20个来源。');
  const seen=new Set<string>();result.sources=[];
  for(const raw of sources){const target=normalizeWorkTarget(raw);if(!target)throw new HttpError(400,'来源对象无效。');if(target.kind==='research-entry'&&target.entryId===id)throw new HttpError(400,'条目不能以自身作为来源。');const key=JSON.stringify(target);if(seen.has(key))throw new HttpError(400,'来源对象重复。');seen.add(key);
   const previous=old?.sources.find(s=>JSON.stringify(s.target)===key);result.sources.push(previous&&!input.refreshSources?structuredClone(previous):await captureWorkTarget(context(t),target));
  }
  const usages=input.usages===undefined?old?.usages||[]:input.usages;
  if(!Array.isArray(usages)||usages.length>100)throw new HttpError(400,'使用位置无效或超过100项。');
  if(kind!=='evidence'&&usages.length)throw new HttpError(400,'请将论文使用位置关联到证据条目。');
  const refresh=input.refreshUsageKeys===undefined?[]:input.refreshUsageKeys;if(!Array.isArray(refresh)||refresh.length>100||refresh.some(k=>typeof k!=='string'||k.length>5000))throw new HttpError(400,'使用位置更新选项无效。');
  const keys=new Set<string>();result.usages=[];
  for(const raw of usages){const u=object(raw);if(!safeWorkId(u.paperId)||!safeWorkFile(u.path)||typeof u.purpose!=='string'||!Object.hasOwn(USAGE_PURPOSES,u.purpose))throw new HttpError(400,'论文使用位置无效。');
   const value={paperId:u.paperId,path:u.path,purpose:u.purpose as ResearchUsage['purpose'],location:u.location===undefined?'':string(u.location,'位置说明',500).trim()},key=usageKey(value);if(keys.has(key))throw new HttpError(400,'论文使用位置重复。');keys.add(key);
   const prior=old?.usages?.find(p=>usageKey(p)===key);if(prior&&!refresh.includes(key))result.usages.push(structuredClone(prior));
   else{const captured=await captureWorkTarget(context(t),{kind:'paper-file',paperId:value.paperId,path:value.path});result.usages.push({...value,label:captured.label,fingerprint:captured.fingerprint,capturedAt:captured.capturedAt});}
  }
  if(refresh.some(key=>!keys.has(key)))throw new HttpError(400,'使用位置已改变，请重新读取。');
  if(kind==='experiment'&&result.state==='completed'&&!result.observation.trim())throw new HttpError(400,'请填写运行与观察后再标记运行已结束。');
  if(kind==='evidence'&&result.state!=='unassessed'&&(!result.observation.trim()||!result.conclusion.trim()||!result.sources.length))throw new HttpError(400,'作出证据判断前，请填写观察、结论并关联来源。');
  return result;
 }
 type Params={id:string;entryId:string};
 app.get<{Params:{id:string}}>('/api/workspace/topics/:id/work-targets',async r=>mutate(async()=>{const t=topic(r.params.id);if(t.archived)throw new HttpError(409,'课题已归档。');return{revision:t.revision,options:await workTargetOptions(context(t))};}));
 app.post<{Params:{id:string}}>('/api/workspace/topics/:id/entries',async(r,reply)=>mutate(async()=>{const input=object(r.body),t=topic(r.params.id);cas(input,t);if(input.kind!=='experiment'&&input.kind!=='evidence')throw new HttpError(400,'条目类型无效。');if((t.workEntries?.length||0)>=500)throw new HttpError(413,'该课题的研究条目已达到500条上限。');
  const id=randomUUID(),data=await fields(input,t,id,input.kind),now=new Date().toISOString(),e:ResearchEntry={id,kind:input.kind,revision:1,createdAt:now,updatedAt:now,history:[],...data},before=structuredClone(t);
  t.workEntries=[...(t.workEntries||[]),e];t.revision++;t.updatedAt=now;try{await save();}catch(error){Object.assign(t,before);if(!before.workEntries)delete t.workEntries;throw error;}return reply.code(201).send({topic:structuredClone(t),entry:structuredClone(e)});
 }));
 app.patch<{Params:Params}>('/api/workspace/topics/:id/entries/:entryId',async r=>mutate(async()=>{const input=object(r.body),t=topic(r.params.id),e=entry(t,r.params.entryId);cas(input,t,e);if(input.kind!==undefined&&input.kind!==e.kind)throw new HttpError(400,'条目类型不能改变。');if(e.history.length>=99)throw new HttpError(413,'该条目已保留100个版本，请保留历史后另建后续条目。');
  const data=await fields(input,t,e.id,e.kind,e),now=new Date().toISOString(),{history,id,kind,createdAt,...prior}=e,before=structuredClone(t);
  const updated:ResearchEntry={id,kind,createdAt,...data,revision:e.revision+1,updatedAt:now,history:[...history,structuredClone(prior)]};t.workEntries=t.workEntries!.map(v=>v.id===id?updated:v);t.revision++;t.updatedAt=now;
  try{await save();}catch(error){Object.assign(t,before);throw error;}return{topic:structuredClone(t),entry:structuredClone(updated)};
 }));
 app.get<{Params:Params}>('/api/workspace/topics/:id/entries/:entryId/edit-context',async r=>mutate(async()=>{const t=topic(r.params.id),e=entry(t,r.params.entryId);if(t.archived||e.archived)throw new HttpError(409,'请先恢复课题或条目，再编辑。');return{revision:t.revision,entry:structuredClone(e),options:(await workTargetOptions(context(t))).filter(o=>o.target.kind!=='research-entry'||o.target.entryId!==e.id)};}));
 app.get<{Params:Params}>('/api/workspace/topics/:id/entries/:entryId',async r=>mutate(async()=>structuredClone(entry(topic(r.params.id),r.params.entryId))));
 app.get<{Params:Params;Querystring:{revision?:string}}>('/api/workspace/topics/:id/entries/:entryId/source-status',async r=>mutate(async()=>{const t=topic(r.params.id),e=version(entry(t,r.params.entryId),r.query.revision);return{statuses:await checkSourceChain(context(t),e,r.params.entryId)};
 }));
 app.get<{Params:Params&{index:string};Querystring:{revision?:string}}>('/api/workspace/topics/:id/entries/:entryId/sources/:index/open',async r=>mutate(async()=>{const t=topic(r.params.id),e=version(entry(t,r.params.entryId),r.query.revision);if(!/^\d{1,2}$/.test(r.params.index))throw new HttpError(400,'来源编号无效。');const source=e.sources[Number(r.params.index)];if(!source)throw new HttpError(404,'来源不存在。');const resolved=await resolveWorkTarget(context(t),source.target);return{path:resolvedTargetPath(context(t),resolved.target)};}));
 app.get<{Params:Params&{index:string};Querystring:{revision?:string}}>('/api/workspace/topics/:id/entries/:entryId/usages/:index/open',async r=>mutate(async()=>{const t=topic(r.params.id),e=version(entry(t,r.params.entryId),r.query.revision);if(!/^(0|[1-9]\d?)$/.test(r.params.index))throw new HttpError(400,'使用位置编号无效。');const u=e.usages?.[Number(r.params.index)];if(!u)throw new HttpError(404,'论文使用位置不存在。');await resolveWorkTarget(context(t),{kind:'paper-file',paperId:u.paperId,path:u.path});return{path:workTargetPath(t.id,{kind:'paper-file',paperId:u.paperId,path:u.path})};}));
 app.get<{Params:{id:string};Querystring:{path?:string}}>('/api/projects/:id/research-evidence',async r=>mutate(async()=>{
  const project=await getProject(root,r.params.id);if(project.archived||project.trashed)throw new HttpError(409,'论文已归档或移入回收站。');if(!safeWorkFile(r.query.path))throw new HttpError(400,'请选择当前论文中的有效文件。');
  const paperRoot=await registeredRoot(root,r.params.id),file=r.query.path,filename=await assertNoSymlinks(paperRoot,file);const fingerprint=await fingerprintFile(filename,()=>assertNoSymlinks(paperRoot,file));
  const contexts=[];
  for(const t of state.topics.filter(t=>!t.archived&&t.paperIds.includes(project.id))){const entries=[];
   for(const e of (t.workEntries||[]).filter(e=>!e.archived&&e.kind==='evidence')){const summary=chainSummary(await checkSourceChain(context(t),e,e.id));entries.push({id:e.id,title:e.title,state:e.state,revision:e.revision,usages:e.usages||[],sourceState:summary.state,sourceMessage:summary.message,links:(e.usages||[]).filter(u=>u.paperId===project.id&&u.path===file).map(u=>({usage:u,state:u.fingerprint===fingerprint?'current':'changed'}))});}
   contexts.push({topicId:t.id,title:t.title,revision:t.revision,entries});
  }
  const basis=await assertNoSymlinks(paperRoot,'notes/research-basis.md').then(f=>fs.stat(f).then(s=>s.isFile())).catch(()=>false);
  return{projectId:project.id,file,contexts,basisPath:basis?`/papers/${encodeURIComponent(project.id)}/writing?file=notes%2Fresearch-basis.md`:undefined,reviewPath:`/papers/${encodeURIComponent(project.id)}/reviews`,presentationPath:`/presentations?paper=${encodeURIComponent(project.id)}`};
 }));

}
