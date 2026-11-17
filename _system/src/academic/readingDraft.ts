import {validReadingLocation,type ReadingDocument} from '../../shared/reading';
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
function parseDraft(raw:string){
 const value=JSON.parse(raw);
 if(value===null)throw Error('草稿结构无效');
 return value;
}
// New drafts belong to this tab. Legacy shared drafts remain untouched for recovery.
export function readReadingDraft(tab:Store,legacy:Store,key:string){
 const current=tab.getItem(key);
 if(current!==null)return parseDraft(current);
 if(tab.getItem(key+':legacy-read'))return null;
 const old=legacy.getItem(key);
 if(old!==null){parseDraft(old);tab.setItem(key,old);}
 tab.setItem(key+':legacy-read','1');
 return old===null?null:parseDraft(old);
}
export function writeReadingDraft(tab:Store,key:string,value:unknown){tab.setItem(key,JSON.stringify(value));}
export function clearReadingDraft(tab:Store,key:string){tab.setItem(key+':legacy-read','1');tab.removeItem(key);}

// Reject a damaged draft before rendering or replacing the server document.
export function validateReadingDraft(value:unknown,resourceId:string): asserts value is {document:ReadingDocument;hash:string|null}{
 const v=value as any,d=v?.document;
 if(!v||!(v.hash===null||typeof v.hash==='string')||!d||d.version!==1||d.resourceId!==resourceId||typeof d.content!=='string'||!Array.isArray(d.notes))throw Error('草稿结构无效');
 const ids=new Set<string>();
 for(const n of d.notes){
  if(!n||typeof n.id!=='string'||!n.id||ids.has(n.id)||!['quote','translation','comment','sourceHash','sourcePath','createdAt'].every(k=>typeof n[k]==='string')||(n.translationSource!==undefined&&typeof n.translationSource!=='string')||!validReadingLocation(n))throw Error('草稿摘录结构无效');
  ids.add(n.id);
 }
}
