import type {ResearchEntry} from './research-entries';
import type {ResearchWorkTarget} from './research-targets';
import type {ResourceGroup} from './resource-kind';
export type HubSection = 'home' | 'topics' | 'experiments' | 'results' | 'progress' | 'library' | 'papers' | 'presentations';
export const RESEARCH_STAGES = { ideation:'问题与选题', experiments:'方案与实验', results:'结果与证据', writing:'论文写作' } as const;
export type ResearchStage = keyof typeof RESEARCH_STAGES;
export interface ResearchProgress { id:string; content:string; nextStep:string; createdAt:string; day?:string; kind?:'progress'|'task'; amendsId?:string; supersededBy?:string }
export interface ResearchTopic { id:string; title:string; description:string; researchBasis?:string; paperIds:string[]; presentationIds:string[]; resourceIds:string[]; archived:boolean; revision:number; createdAt:string; updatedAt:string; stage?:ResearchStage; experimentPlan?:string; resultSummary?:string; workEntries?:ResearchEntry[];progressEntries?:ResearchProgress[]; dailyTaskStates?:Record<string,{done:boolean;updatedAt:string;target?:ResearchWorkTarget}> }
export interface SourceRoot { id:string; label:string; path:string; permission:'read'|'write'; status:'scanning'|'ready'|'offline'|'error'; error?:string; scannedFiles:number; indexedAt?:string; revision:number; createdAt:string }
export interface ResourceSearchMatch {source:'metadata'|'text'|'ocr'|'translation';snippet:string;page?:number;terms:string[]}
export interface Resource { title?:string; titleZh?:string; venue?:string; year?:string; keywords?:string[]; id:string; rootId:string; path:string; name:string; kind:'file'|'directory'; size:number; modifiedAt:string; tags:string[]; missing:boolean; revision:number; hash?:string; snippet?:string; searchMatch?:ResourceSearchMatch }
export interface PdfImportTarget { topicId?:string; expectedRevision?:number; rootId?:string; directory?:string }
export interface PdfImportResult { topic?:ResearchTopic; resource:Resource; root:SourceRoot; reused:boolean; alreadyLinked:boolean }
export interface LiteratureImportResult extends PdfImportResult { topic:ResearchTopic }
export interface ResourcePage { resources:Resource[]; total:number; roots:SourceRoot[]; indexing:boolean; groupCounts?:Record<ResourceGroup,number>; priorityUnavailable?:boolean }
export type FileOperationKind='mkdir'|'create-file'|'move'|'trash';
export interface FileOperationInput { kind:FileOperationKind; rootId:string; path?:string; content?:string; resourceId?:string; destinationRootId?:string; destinationPath?:string; expectedRevision?:number; expectedHash?:string|null }
export interface FileOperation { label?:string; id:string; kind:FileOperationKind; status:'applied'|'undone'|'failed'|'interrupted'; source?:{rootId:string;path:string}; destination?:{rootId:string;path:string}; recovery?:{rootId:string;path:string}; resourceId?:string; createdAt:string; error?:string; undoable:boolean }
export interface WorkspaceOverview { topics:ResearchTopic[]; roots:SourceRoot[]; resources:Resource[]; operations:FileOperation[]; externalOriginalsIncludedInBackup:false }
