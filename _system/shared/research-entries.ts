import type {ResearchWorkTarget} from './research-targets';
export type ResearchEntryKind='experiment'|'evidence';
export const EXPERIMENT_STATES={planned:'计划中',running:'进行中',completed:'运行已结束',blocked:'受阻'} as const;
export const EVIDENCE_STATES={unassessed:'待核查',supports:'支持该主张',mixed:'部分支持',refutes:'不支持该主张'} as const;
export type ResearchEntryState=keyof typeof EXPERIMENT_STATES|keyof typeof EVIDENCE_STATES;
export interface ResearchEntrySource {target:ResearchWorkTarget;label:string;fingerprint:string;capturedAt:string;version?:number}
export const USAGE_PURPOSES={claim:'正文论述',figure:'图',table:'表'} as const;
export interface ResearchUsageInput {paperId:string;path:string;purpose:keyof typeof USAGE_PURPOSES;location:string}
export interface ResearchUsage extends ResearchUsageInput {label:string;fingerprint:string;capturedAt:string}
export const usageKey=(u:ResearchUsageInput)=>JSON.stringify([u.paperId,u.path,u.purpose,u.location]);
export interface ResearchEntryFields {title:string;state:ResearchEntryState;question:string;protocol:string;observation:string;conclusion:string;limitations:string;sources:ResearchEntrySource[];usages?:ResearchUsage[];archived:boolean}
export interface ResearchEntryVersion extends ResearchEntryFields {revision:number;updatedAt:string}
export interface ResearchEntry extends ResearchEntryVersion {id:string;kind:ResearchEntryKind;createdAt:string;history:ResearchEntryVersion[]}
export interface ResearchSourceStatus {state:'current'|'changed'|'unavailable';message:string;current?:ResearchEntrySource;children?:{source:ResearchEntrySource;status:ResearchSourceStatus}[]}
export const entryStates=(kind:ResearchEntryKind)=>kind==='experiment'?EXPERIMENT_STATES:EVIDENCE_STATES;
export const entryPath=(topicId:string,entry:Pick<ResearchEntry,'id'|'kind'>,revision?:number)=>`/${entry.kind==='experiment'?'experiments':'results'}?${new URLSearchParams({topic:topicId,entry:entry.id,...(revision?{revision:String(revision)}:{})})}`;
