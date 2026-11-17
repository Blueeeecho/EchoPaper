import type {ResearchTopic} from './workspace-types';
export type ResearchWorkTarget =
 | {kind:'paper-file';paperId:string;path:string}
 | {kind:'review';paperId:string;reviewId:string}
 | {kind:'resource';resourceId:string}
 | {kind:'research-entry';entryId:string;entryKind:'experiment'|'evidence'}
 | {kind:'topic-note';field:'experimentPlan'|'resultSummary'};
export interface WorkTargetOption {target:ResearchWorkTarget;label:string;group:string}
export interface TaskTargetOptions {revision:number;target?:ResearchWorkTarget;options:WorkTargetOption[];taskText:string}
export const safeWorkId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
export const safeWorkFile=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=2000&&!/[\\\x00-\x1f]/.test(value)&&!/^([A-Za-z]:|\/)/.test(value)&&value.split('/').every(p=>!!p&&!p.startsWith('.'))&&!['build','submissions','project.json'].includes(value.split('/')[0]);
export function normalizeWorkTarget(raw:unknown):ResearchWorkTarget|undefined{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
 const t=raw as Record<string,unknown>;
 if(t.kind==='paper-file'&&safeWorkId(t.paperId)&&safeWorkFile(t.path))return{kind:t.kind,paperId:t.paperId,path:t.path};
 if(t.kind==='review'&&safeWorkId(t.paperId)&&safeWorkId(t.reviewId))return{kind:t.kind,paperId:t.paperId,reviewId:t.reviewId};
 if(t.kind==='research-entry'&&safeWorkId(t.entryId)&&['experiment','evidence'].includes(t.entryKind as string))return{kind:t.kind,entryId:t.entryId,entryKind:t.entryKind as 'experiment'|'evidence'};
 if(t.kind==='resource'&&safeWorkId(t.resourceId))return{kind:t.kind,resourceId:t.resourceId};
 if(t.kind==='topic-note'&&['experimentPlan','resultSummary'].includes(t.field as string))return{kind:t.kind,field:t.field as 'experimentPlan'|'resultSummary'};
}
export function workTargetPath(topicId:string,raw:ResearchWorkTarget):string|undefined{
 const t=normalizeWorkTarget(raw);if(!t||!safeWorkId(topicId))return;
 if(t.kind==='paper-file')return `/papers/${encodeURIComponent(t.paperId)}/writing?${new URLSearchParams({file:t.path})}`;
 if(t.kind==='review')return `/papers/${encodeURIComponent(t.paperId)}/reviews?${new URLSearchParams({review:t.reviewId})}`;
 if(t.kind==='research-entry')return `/${t.entryKind==='experiment'?'experiments':'results'}?${new URLSearchParams({topic:topicId,entry:t.entryId})}`;
 if(t.kind==='resource')return `/library?${new URLSearchParams({topic:topicId,resource:t.resourceId})}`;
 return `/${t.field==='experimentPlan'?'experiments':'results'}?${new URLSearchParams({topic:topicId})}`;
}
/** Carry states by task identity when lists reorder; positional transfer only for an unambiguous text edit. */
export function previousTaskIndex(previous:string[],updated:string[],index:number){
 const text=updated[index],matches=previous.flatMap((p,i)=>p===text?[i]:[]);
 if(matches.length===1&&updated.filter(t=>t===text).length===1)return matches[0];
 if(previous[index]===text)return index;
 if(previous.length===updated.length&&!previous.includes(text)&&!updated.includes(previous[index]))return index;
 return -1;
}
export function taskTarget(topic:ResearchTopic,entryId:string,index:number){return topic.dailyTaskStates?.[`${entryId}:${index}`]?.target;}
