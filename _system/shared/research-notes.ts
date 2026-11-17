export type ResearchNoteSection='ideation'|'experiments'|'results';

export interface ResearchNoteSummary {
 id:string;
 name:string;
 filename:string|null;
 /** Path relative to the workspace root. Legacy overview records have no file. */
 path:string|null;
 updatedAt:string;
 legacy:boolean;
}

export interface ResearchNoteDocument extends ResearchNoteSummary {
 content:string;
 hash:string;
}

export interface ResearchNoteTrashEntry {
 id:string;
 noteId:string;
 name:string;
 hash:string;
 deletedAt:string;
 legacy:boolean;
 status:'applied'|'undone'|'failed'|'interrupted';
 undoable:boolean;
 error?:string;
}
