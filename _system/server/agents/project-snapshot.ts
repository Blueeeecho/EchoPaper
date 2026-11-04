import fs from 'node:fs/promises';
import { listFiles } from '../files';
import { assertNoSymlinks, editablePath, HttpError } from '../security';
import { hash } from '../storage';
import type { FileEntry } from '../../shared/types';
import type { ReferenceIndex } from '../../shared/reference-types';
import { parseBibTeX } from '../references';

export interface SnapshotFile {path:string;hash:string;size:number;text?:string;binary:boolean}
export interface ProjectSnapshot {files:Record<string,SnapshotFile>;entries:FileEntry[];capturedAt:string}
export function agentPath(path:unknown):string {const value=editablePath(path);if(/^notes\/(?:(?:ai-conversations|pdf-annotations)\.json$|agent-runs(?:\/|$))/i.test(value))throw new HttpError(403,'内部对话、任务记录与批注状态不作为助手自动读取材料。');if(value==='AGENTS.md'||value==='README.md'||/^(?:manuscript|notes|reviews|literature)\//.test(value))return value;throw new HttpError(403,'助手仅可访问当前项目的正文、笔记、审稿材料与文献目录。');}
export async function captureProjectSnapshot(root:string):Promise<ProjectSnapshot> {
 const files:ProjectSnapshot['files']={};const entries=(await listFiles(root)).filter(entry=>{try{agentPath(entry.path);return true;}catch{return false;}});let total=0;
 for(const entry of entries){if(entry.type!=='file')continue;const filename=await assertNoSymlinks(root,entry.path),stat=await fs.stat(filename);if(stat.size>50*1024*1024)continue;total+=stat.size;if(total>150*1024*1024)throw new HttpError(413,'项目超过助手快照 150 MB 上限。');const bytes=await fs.readFile(filename);let text:string|undefined;
  if(bytes.length<=3*1024*1024&&!bytes.includes(0)&&/\.(?:tex|bib|md|txt|json|csv|sty|cls|bst)$/i.test(entry.path)){try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{}}
  files[entry.path]={path:entry.path,hash:hash(bytes),size:bytes.length,binary:text===undefined,...(text===undefined?{}:{text})};
 }
 return{files,entries,capturedAt:new Date().toISOString()};
}
export function snapshotReferences(snapshot:ProjectSnapshot):ReferenceIndex {
 const result:ReferenceIndex={entries:[],labels:[],warnings:[]};for(const file of Object.values(snapshot.files)){if(file.text===undefined||!(/^(?:manuscript|literature)\//.test(file.path)||/^reviews\/[^/]+\/response\//.test(file.path)))continue;
  if(file.path.endsWith('.bib')){const parsed=parseBibTeX(file.text,file.path);result.entries.push(...parsed.entries);result.warnings.push(...parsed.warnings);}
  else if(file.path.endsWith('.tex'))for(const [line,raw]of file.text.split('\n').entries()){const text=raw.replace(/(?<!\\)%.*/,'');for(const match of text.matchAll(/\\label\s*\{([^{}]+)\}/g))result.labels.push({key:match[1],file:file.path,line:line+1,context:text.trim().slice(0,180)});}
 }
 for(const entries of [result.entries,result.labels]){const keys=new Set<string>();for(const entry of entries){if(keys.has(entry.key))result.warnings.push(`键 ${entry.key} 重复。`);keys.add(entry.key);}}
 return result;
}
