export interface ReadingNote {id:string;quote:string;translation:string;comment:string;page:number|null;locationKind?:'pdf-page'|'unlocated';sourceHash:string;sourcePath:string;createdAt:string;translationSource?:string}
export interface ReadingDocument {version:1;resourceId:string;content:string;notes:ReadingNote[]}

// Legacy records have no trustworthy location discriminator. Preserve their data,
// but never infer a PDF page from a filename or the old default page=1.
export function readingPage(note:ReadingNote):number|null {
 return note.locationKind==='pdf-page'&&Number.isSafeInteger(note.page)&&note.page!>0?note.page:null;
}
export function validReadingLocation(note:ReadingNote):boolean {
 if(note.locationKind===undefined)return Number.isSafeInteger(note.page)&&note.page!>0;
 if(note.locationKind==='unlocated')return note.page===null;
 return note.locationKind==='pdf-page'&&readingPage(note)!==null;
}
export interface ReadingIndexItem {resourceId:string;updatedAt:string;document:ReadingDocument}
