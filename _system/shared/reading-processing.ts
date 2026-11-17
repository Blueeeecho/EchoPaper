export interface ReadingSettings {
 enabled:boolean;
 translateAppendix:boolean;
 engineId:string;
 translationSourceId:string|null;
}
export interface ReadingEngineChoice {id:string;label:string;configured:boolean}
export interface ReadingTranslationChoice {id:string;label:string;model:string;configured:boolean}
export type ReadingStage='uncached'|'queued'|'ocr'|'translating'|'complete'|'failed'|'stale';
export interface ReadingStatus {
 resourceId:string;
 stage:ReadingStage;
 done:number;
 total:number;
 pageCount:number;
 appendix:boolean;
 error?:string;
 updatedAt?:string;
 ocrMs?:number;
 translationMs?:number;
}
export interface ReadingProcessingSnapshot {
 revision:number;
 settings:ReadingSettings;
 sources:{engine:string;translation:string};
 choices:{engines:ReadingEngineChoice[];translations:ReadingTranslationChoice[]};
 statuses:Record<string,ReadingStatus>;
 queue:{pending:number;active:number;failed:number};
 parallelism?:{ocr:number;translation:number;activeDocuments:number;activeOcr:number;activeTranslations:number;throttled?:boolean;ocrMax?:number;translationMax?:number};
}
