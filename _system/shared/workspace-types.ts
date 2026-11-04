export type HubSection = 'home' | 'topics' | 'library' | 'papers' | 'presentations';
export interface ResearchTopic { id:string; title:string; description:string; paperIds:string[]; presentationIds:string[]; resourceIds:string[]; archived:boolean; revision:number; createdAt:string; updatedAt:string }
export interface SourceRoot { id:string; label:string; path:string; permission:'read'|'write'; status:'scanning'|'ready'|'offline'|'error'; error?:string; scannedFiles:number; indexedAt?:string; revision:number; createdAt:string }
export interface Resource { id:string; rootId:string; path:string; name:string; kind:'file'|'directory'; size:number; modifiedAt:string; tags:string[]; missing:boolean; revision:number; hash?:string; snippet?:string }
export interface ResourcePage { resources:Resource[]; total:number; roots:SourceRoot[]; indexing:boolean }
export type FileOperationKind='mkdir'|'create-file'|'move'|'trash';
export interface FileOperationInput { kind:FileOperationKind; rootId:string; path?:string; content?:string; resourceId?:string; destinationRootId?:string; destinationPath?:string; expectedRevision?:number; expectedHash?:string|null }
export interface FileOperation { id:string; kind:FileOperationKind; status:'applied'|'undone'|'failed'|'interrupted'; source?:{rootId:string;path:string}; destination?:{rootId:string;path:string}; recovery?:{rootId:string;path:string}; resourceId?:string; createdAt:string; error?:string; undoable:boolean }
export interface WorkspaceOverview { topics:ResearchTopic[]; roots:SourceRoot[]; resources:Resource[]; operations:FileOperation[]; externalOriginalsIncludedInBackup:false }
