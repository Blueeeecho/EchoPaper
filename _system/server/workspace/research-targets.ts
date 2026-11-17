import {fingerprintFile} from './source-fingerprint';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import type {ResearchEntrySource} from '../../shared/research-entries';
import fs from 'node:fs/promises';
import path from 'node:path';
import {workTargetPath,normalizeWorkTarget,safeWorkFile,safeWorkId,type ResearchWorkTarget,type WorkTargetOption} from '../../shared/research-targets.ts';
import type {ResearchTopic,Resource,SourceRoot} from '../../shared/workspace-types.ts';
import {getProject} from '../projects.ts';
import {listFiles} from '../files.ts';
import {assertNoSymlinks,HttpError,registeredRoot} from '../security.ts';
import {rootFile} from './paths.ts';
export type TargetContext={root:string;topic:ResearchTopic;resources:Resource[];roots:SourceRoot[]};
export async function resolveWorkTarget(context:TargetContext,raw:unknown):Promise<WorkTargetOption>{
 const t=normalizeWorkTarget(raw);if(!t)throw new HttpError(400,'工作对象格式或路径无效。');
 const {root,topic}=context;if(topic.archived)throw new HttpError(409,'课题已归档，请先恢复。');
 if(t.kind==='research-entry'){const entry=topic.workEntries?.find(e=>e.id===t.entryId);if(!entry||entry.archived||entry.kind!==t.entryKind)throw new HttpError(404,'关联研究条目已不可用，原引用仍保留。');return{target:t,label:entry.title,group:entry.kind==='experiment'?'实验条目':'证据条目'};}
 if(t.kind==='topic-note'){
  if(!topic[t.field]?.trim())throw new HttpError(404,'关联记录已不存在。请重新选择工作对象。');
  return{target:t,label:t.field==='experimentPlan'?'当前方案与实验记录':'当前结果与证据记录',group:'研究记录'};
 }
 if(t.kind==='resource'){
  if(!topic.resourceIds.includes(t.resourceId))throw new HttpError(409,'该资料已不属于当前课题，请重新关联。');
  const item=context.resources.find(r=>r.id===t.resourceId),source=context.roots.find(r=>r.id===item?.rootId);
  if(!item||!source||item.missing||item.kind!=='file')throw new HttpError(404,'关联资料不可用，原关联仍保留。');
  const filename=await rootFile(root,source,item.path);if(!(await fs.stat(filename)).isFile())throw new HttpError(404,'关联资料已不存在。');
  return{target:t,label:item.name,group:'课题资料'};
 }
 if(!topic.paperIds.includes(t.paperId))throw new HttpError(409,'该论文已不属于当前课题，请重新关联。');
 const project=await getProject(root,t.paperId);if(project.archived||project.trashed)throw new HttpError(409,'关联论文已归档或移入回收站。');
 const paperRoot=await registeredRoot(root,t.paperId);
 if(t.kind==='paper-file'){
  const filename=await assertNoSymlinks(paperRoot,t.path);if(!(await fs.stat(filename)).isFile())throw new HttpError(404,'关联文件已不存在。');
  return{target:t,label:`${project.title} · ${t.path}`,group:'论文文件'};
 }
 const filename=await assertNoSymlinks(paperRoot,`reviews/${t.reviewId}/round.json`),round=JSON.parse(await fs.readFile(filename,'utf8'));
 if(round.id!==t.reviewId)throw new HttpError(409,'审稿轮次信息不一致。');
 return{target:t,label:`${project.title} · ${round.label||t.reviewId}`,group:'审稿轮次'};
}
export async function workTargetOptions(context:TargetContext):Promise<WorkTargetOption[]>{
 const candidates:ResearchWorkTarget[]=[...(context.topic.workEntries||[]).filter(e=>!e.archived).map(e=>({kind:'research-entry' as const,entryId:e.id,entryKind:e.kind})),{kind:'topic-note',field:'experimentPlan'},{kind:'topic-note',field:'resultSummary'},...context.topic.resourceIds.map(resourceId=>({kind:'resource' as const,resourceId}))];
 for(const paperId of context.topic.paperIds){
  try{const project=await getProject(context.root,paperId);if(project.archived||project.trashed)continue;
   const files=await listFiles(await registeredRoot(context.root,paperId));
   for(const file of files){if(file.type!=='file'||!safeWorkFile(file.path))continue;
    const review=/^reviews\/([^/]+)\/round\.json$/.exec(file.path);
    if(review&&safeWorkId(review[1]))candidates.push({kind:'review',paperId,reviewId:review[1]});
    else if(!file.path.startsWith('reviews/'))candidates.push({kind:'paper-file',paperId,path:file.path});
   }
  }catch{/* A stale association remains in the topic, but is not offered as an available target. */}
 }
 const options:WorkTargetOption[]=[];for(const target of candidates){try{options.push(await resolveWorkTarget(context,target));}catch{/* Unavailable options are omitted; existing links are retained. */}}
 return options;
}

/** Capture current content, never a claim of scientific validity or a full source backup. */
export async function captureWorkTarget(context:TargetContext,raw:unknown):Promise<ResearchEntrySource>{
 const option=await resolveWorkTarget(context,raw),target=option.target;let fingerprint:string,version:number|undefined;
 const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
 if(target.kind==='topic-note'){fingerprint=digest(context.topic[target.field]||'');version=context.topic.revision;}
 else if(target.kind==='research-entry'){const entry=context.topic.workEntries!.find(e=>e.id===target.entryId)!;const {history,...current}=entry;fingerprint=digest(JSON.stringify(current));version=entry.revision;}
 else{
  let filename:string;
  if(target.kind==='resource'){const item=context.resources.find(r=>r.id===target.resourceId)!;filename=await rootFile(context.root,context.roots.find(r=>r.id===item.rootId)!,item.path);}
  else{const root=await registeredRoot(context.root,target.paperId);filename=await assertNoSymlinks(root,target.kind==='review'?`reviews/${target.reviewId}/round.json`:target.path);}
  fingerprint=await fingerprintFile(filename,async()=>{if(target.kind==='resource'){const item=context.resources.find(r=>r.id===target.resourceId)!;await rootFile(context.root,context.roots.find(r=>r.id===item.rootId)!,item.path);}else{const root=await registeredRoot(context.root,target.paperId);await assertNoSymlinks(root,target.kind==='review'?`reviews/${target.reviewId}/round.json`:target.path);}});
 }
 return{target,label:option.label,fingerprint,capturedAt:new Date().toISOString(),...(version?{version}:{})};
}
export function resolvedTargetPath(context:TargetContext,target:ResearchWorkTarget){
 if(target.kind==='research-entry'){const e=context.topic.workEntries?.find(e=>e.id===target.entryId);if(!e)return;return `/${e.kind==='experiment'?'experiments':'results'}?${new URLSearchParams({topic:context.topic.id,entry:e.id})}`;}
 return workTargetPath(context.topic.id,target);
}
