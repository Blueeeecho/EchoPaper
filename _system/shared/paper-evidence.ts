import type {ResearchUsage,ResearchEntryState} from './research-entries';
export interface PaperEvidenceEntry {id:string;title:string;state:ResearchEntryState;revision:number;usages:ResearchUsage[];sourceState:string;sourceMessage:string;links:{usage:ResearchUsage;state:'current'|'changed'}[]}
export interface PaperEvidenceContext {topicId:string;title:string;revision:number;entries:PaperEvidenceEntry[]}
export interface PaperEvidenceData {projectId:string;file:string;contexts:PaperEvidenceContext[];basisPath?:string;reviewPath:string;presentationPath:string}
