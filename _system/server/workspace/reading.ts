import fs from 'node:fs/promises';
import type {FastifyInstance} from 'fastify';
import {assertNoSymlinks,HttpError} from '../security';
import {atomicWrite,hash,withLock} from '../storage';
import {workspaceMaintenance} from '../agents/maintenance';
import type {WorkspaceService} from './index';
import {validReadingLocation,type ReadingDocument} from '../../shared/reading';
export function registerReadingRoutes(app:FastifyInstance,root:string,workspace:Pick<WorkspaceService,'resourceFile'>){
 const filename=async(id:string)=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new HttpError(400,'资料ID无效');return assertNoSymlinks(root,`workspace/reading/${id}.json`,true);};
 async function read(id:string){const file=await filename(id);try{const raw=await fs.readFile(file,'utf8');return {document:JSON.parse(raw) as ReadingDocument,hash:hash(raw)};}catch(e:any){if(e.code!=='ENOENT')throw e;return {document:{version:1,resourceId:id,content:'',notes:[]} as ReadingDocument,hash:null};}}
 // All reading documents at once, so excerpts and notes can be browsed across papers and reused in writing.
 app.get('/api/workspace/reading',async()=>{let dir:string;try{dir=await assertNoSymlinks(root,'workspace/reading');}catch(e:any){if(e.statusCode===404||e.code==='ENOENT')return {documents:[]};throw e;}
  const names=(await fs.readdir(dir).catch(()=>[] as string[])).filter(n=>/^[a-zA-Z0-9_-]{1,100}\.json$/.test(n)).slice(0,2000);const documents=[];
  for(const name of names){try{const file=await filename(name.slice(0,-5));const stat=await fs.stat(file);if(stat.size>5*1024*1024)continue;const document=JSON.parse(await fs.readFile(file,'utf8')) as ReadingDocument;if(document?.version!==1||!Array.isArray(document.notes))continue;if(!document.content.trim()&&!document.notes.length)continue;documents.push({resourceId:document.resourceId,updatedAt:stat.mtime.toISOString(),document});}catch{/* A damaged note file never hides the others. */}}
  documents.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));return {documents};});
 app.get<{Params:{id:string}}>('/api/workspace/resources/:id/reading',async req=>{const current=await read(req.params.id);if(current.hash===null)await workspace.resourceFile(req.params.id);return current;});
 app.put<{Params:{id:string};Body:{document:ReadingDocument;expectedHash:string|null}}>('/api/workspace/resources/:id/reading',{bodyLimit:2*1024*1024},async req=>{const id=req.params.id;return withLock(`reading:${root}:${id}`,async()=>{workspaceMaintenance(root).assertAvailable();const current=await read(id),b=req.body,d=b?.document;if(current.hash===null)await workspace.resourceFile(id);if(b?.expectedHash!==current.hash)throw new HttpError(409,'笔记已有其他修改，本地草稿已保留；请比较后保存。');if(!d||d.version!==1||d.resourceId!==id||typeof d.content!=='string'||d.content.length>200000||!Array.isArray(d.notes)||d.notes.length>1000||d.notes.some(n=>!n||['id','quote','translation','comment','sourceHash','sourcePath','createdAt'].some(k=>typeof (n as any)[k]!=='string')||!validReadingLocation(n)))throw new HttpError(400,'笔记格式无效');const raw=JSON.stringify(d);await atomicWrite(await filename(id),raw);return {document:d,hash:hash(raw)};});});
}
