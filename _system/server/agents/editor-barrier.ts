import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {EditorBarrier,EmitEvent} from '../../shared/types';
import {HttpError,registeredRoot,relativePath} from '../security';
interface Session{id:string;root:string;projectId:string;path:string;dirty:boolean;bufferVersion:number;seen:number}
interface Pending{root:string;barrier:EditorBarrier;required:Set<string>;acks:Map<string,boolean>;progress:Map<string,{stage:string;at:number}>;resolve:()=>void}
const sessions=new Map<string,Session>(),pending=new Map<string,Pending>();
const publishers=new Map<string,EmitEvent>();
// Document IDs are never reused. Keep revocations until server shutdown so even
// an arbitrarily delayed registration cannot recreate a closed clean document.
const closedSessions=new Map<string,Set<string>>();
interface Snapshot{path:string;dirty:boolean;bufferVersion:number}
function snapshot(value:unknown):Snapshot{
 const b=value as Snapshot|undefined;
 if(!b||typeof b.path!=='string'||typeof b.dirty!=='boolean'||!Number.isSafeInteger(b.bufferVersion)||b.bufferVersion<0||(!b.path&&b.dirty))throw new HttpError(400,'编辑器状态无效。');
 return{path:b.path?relativePath(b.path):'',dirty:b.dirty,bufferVersion:b.bufferVersion};
}
function stale(previous:Session|undefined,next:Snapshot):boolean{
 // Every path/dirty transition advances the client protocol version. At the
 // same version a dirty observation wins over a conflicting clean one.
 return!!previous&&(next.bufferVersion<previous.bufferVersion||(next.bufferVersion===previous.bufferVersion&&previous.dirty&&!next.dirty));
}
function unregisterClean(root:string,id:string){
 let closed=closedSessions.get(root);if(!closed)closedSessions.set(root,closed=new Set());closed.add(id);
 const session=sessions.get(id);if(session?.root===root)sessions.delete(id);
 for(const entry of pending.values())if(entry.root===root&&entry.required.delete(id)){
  entry.acks.delete(id);
  if(entry.acks.size===entry.required.size)entry.resolve();
 }
}
function remember(session:Session){
 sessions.set(session.id,session);
 for(const entry of pending.values())if(entry.root===session.root){
  if(entry.required.has(session.id)){
   if(!entry.barrier.paths.includes(session.path)&&!session.dirty){entry.required.delete(session.id);entry.acks.delete(session.id);if(entry.acks.size===entry.required.size)entry.resolve();continue;}
   if(session.dirty)entry.acks.delete(session.id);
  }else if(entry.barrier.paths.includes(session.path)){
   // A replacement document or another tab can register during the handshake.
   // It must take the same lock before a commit is allowed to continue.
   entry.required.add(session.id);
   publishers.get(session.root)?.({type:'editor.barrier',projectId:session.projectId,barrier:entry.barrier});
  }
 }
}
export async function prepareEditorCommit(root:string,paths:string[],signal?:AbortSignal):Promise<(()=>void)&{assertActive:()=>void}>{
 const relevant=[...sessions.values()].filter(s=>s.root===root&&paths.includes(s.path)&&(Date.now()-s.seen<20000||s.dirty));
 if(!relevant.length)return Object.assign(()=>{},{assertActive:()=>{if(signal?.aborted)throw new HttpError(409,'任务已停止。');}});
 if(signal?.aborted)throw new HttpError(409,'任务已停止，尚未写入。');
 const publish=publishers.get(root)||(()=>{}),id=randomUUID(),barrier:EditorBarrier={id,paths,expiresAt:Date.now()+15000};let wake!:()=>void;
 const wait=new Promise<void>(r=>wake=r),entry:Pending={root,barrier,required:new Set(relevant.map(s=>s.id)),acks:new Map(),progress:new Map(),resolve:wake};pending.set(id,entry);
 let renewal:ReturnType<typeof setInterval>|undefined;
 const assertActive=()=>{if(signal?.aborted||Date.now()>=barrier.expiresAt||!pending.has(id))throw new HttpError(409,'编辑器提交租约已过期，停止写入并保留修改。');if(entry.acks.size!==entry.required.size||[...entry.acks.values()].some(v=>!v))throw new HttpError(409,'编辑器状态已变化，停止写入并保留修改。');};
 const release=Object.assign(()=>{clearInterval(renewal);pending.delete(id);publish({type:'editor.release',projectId:relevant[0].projectId,barrier});},{assertActive});
 publish({type:'editor.barrier',projectId:relevant[0].projectId,barrier});
 let timer:ReturnType<typeof setTimeout>|undefined;const abort=()=>wake();signal?.addEventListener('abort',abort,{once:true});
 // Pages that last reported a clean buffer get a short window; a dirty buffer keeps the full wait.
 const anyDirty=relevant.some(s=>s.dirty);
 try{await Promise.race([wait,new Promise<void>(r=>timer=setTimeout(r,anyDirty?15000:5000))]);
  if(signal?.aborted)throw new HttpError(409,'任务已停止，尚未写入。');
  const unsaved=[...entry.acks].filter(([,clean])=>!clean).map(([id])=>sessions.get(id)?.path).filter(Boolean);
  // A page that never answered but whose last report was clean (e.g. a background tab or a second window)
  // holds nothing that could be lost; it reloads the file when it reconnects. Only dirty silence blocks writing.
  const silent=[...entry.required].filter(id=>!entry.acks.has(id)),unconfirmed=silent.filter(id=>{const s=sessions.get(id);return !s||s.dirty;}).map(id=>sessions.get(id)?.path||'未知页面');
  if(!unconfirmed.length&&!unsaved.length)for(const id of silent)entry.required.delete(id);
  if(unsaved.length||unconfirmed.length)throw new HttpError(409,unsaved.length?`编辑器未能保存或存在内容冲突：${[...new Set(unsaved)].join('、')}。建议已保留，请处理该文件后恢复任务。`:`等待编辑器确认超时：${[...new Set(unconfirmed)].join('、')}。尚未写入，不代表文件内容冲突；请检查仍打开的写作页面连接后恢复任务。`,{editorCommit:{reason:unsaved.length?'unsaved':'unconfirmed',barrierId:id,unsaved,unconfirmed,sessions:[...entry.required].map(id=>{const s=sessions.get(id);return{id,path:s?.path,dirty:s?.dirty,lastSeen:s?.seen,confirmed:entry.acks.has(id),progress:entry.progress.get(id)};})}});
  assertActive();barrier.expiresAt=Date.now()+5000;publish({type:'editor.barrier',projectId:relevant[0].projectId,barrier});renewal=setInterval(()=>{barrier.expiresAt=Date.now()+5000;publish({type:'editor.barrier',projectId:relevant[0].projectId,barrier});},2000);renewal.unref();return release;}
 catch(e){release();throw e;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export function registerEditorSessionRoutes(app:FastifyInstance,workspaceRoot:string,emit:EmitEvent){
 const roots=new Set<string>();
 app.post<{Params:{id:string};Body:{id:string;path:string;dirty:boolean;bufferVersion:number}}>('/api/projects/:id/editor-sessions',async req=>{
  const root=await registeredRoot(workspaceRoot,req.params.id),b=req.body;
  if(!b||typeof b.id!=='string'||!/^[\w-]{1,100}$/.test(b.id))throw new HttpError(400,'编辑器状态无效。');
  const next=snapshot(b),previous=sessions.get(b.id);if(previous&&previous.root!==root)throw new HttpError(409,'编辑器会话已绑定另一论文。');
  roots.add(root);publishers.set(root,emit);
  if(closedSessions.get(root)?.has(b.id))return{ok:true,closed:true};
  if(stale(previous,next))return{ok:true,ignored:true};
  if(previous&&next.bufferVersion===previous.bufferVersion&&next.path!==previous.path)throw new HttpError(409,'编辑器状态版本已变化，请同步最新状态。');
  remember({id:b.id,root,projectId:req.params.id,...next,seen:Date.now()});return{ok:true,barriers:[...pending.values()].filter(entry=>entry.root===root&&entry.required.has(b.id)&&entry.barrier.paths.includes(next.path)).map(entry=>entry.barrier)};
 });
 app.delete<{Params:{id:string;sessionId:string};Body?:Snapshot}>('/api/projects/:id/editor-sessions/:sessionId',async req=>{
  const root=await registeredRoot(workspaceRoot,req.params.id),id=req.params.sessionId;
  if(!/^[\w-]{1,100}$/.test(id))throw new HttpError(400,'编辑器状态无效。');
  const previous=sessions.get(id);if(previous&&previous.root!==root)throw new HttpError(409,'编辑器会话已绑定另一论文。');
  roots.add(root);publishers.set(root,emit);
  if(closedSessions.get(root)?.has(id))return{ok:true,closed:true};
  // Old callers may omit a body. They can revoke a known clean session, but
  // must never make an existing dirty buffer disappear.
  const next=req.body===undefined?previous:snapshot(req.body);
  if(next&&stale(previous,next))return{ok:true,ignored:true};
  if(next?.dirty){
   if(previous&&next.bufferVersion===previous.bufferVersion&&next.path!==previous.path)throw new HttpError(409,'编辑器状态版本已变化，请同步最新状态。');
   remember({id,root,projectId:req.params.id,path:next.path,dirty:true,bufferVersion:next.bufferVersion,seen:Date.now()});
   return{ok:true,preserved:true};
  }
  unregisterClean(root,id);return{ok:true,closed:true};
 });
 app.post<{Params:{id:string;sessionId:string};Body:{barrierId:string;stage:string}}>('/api/projects/:id/editor-sessions/:sessionId/progress',async req=>{
  const root=await registeredRoot(workspaceRoot,req.params.id),b=req.body,p=pending.get(b?.barrierId),s=sessions.get(req.params.sessionId);
  if(!p||p.root!==root||!s||s.root!==root||!p.required.has(s.id)||!['保存','同步','确认','保存失败','同步失败','确认失败'].includes(b.stage))throw new HttpError(409,'编辑器提交屏障已失效。');
  p.progress.set(s.id,{stage:b.stage,at:Date.now()});return{ok:true};
 });
 app.post<{Params:{id:string;sessionId:string};Body:{barrierId:string;bufferVersion:number;clean:boolean}}>('/api/projects/:id/editor-sessions/:sessionId/ack',async req=>{
  const root=await registeredRoot(workspaceRoot,req.params.id),s=sessions.get(req.params.sessionId),b=req.body,p=pending.get(b?.barrierId);
  if(!s||s.root!==root||!p||p.root!==root||!p.required.has(s.id)||typeof b.clean!=='boolean'||!Number.isSafeInteger(b.bufferVersion)||b.bufferVersion<s.bufferVersion)throw new HttpError(409,'编辑器提交屏障已失效。');
  s.dirty=!b.clean;s.bufferVersion=b.bufferVersion;s.seen=Date.now();p.acks.set(s.id,b.clean);if(p.acks.size===p.required.size)p.resolve();return{ok:true};
 });
 app.addHook('onClose',async()=>{for(const root of roots){for(const [id,s] of sessions)if(s.root===root)sessions.delete(id);for(const [id,p] of pending)if(p.root===root){pending.delete(id);p.resolve();}publishers.delete(root);closedSessions.delete(root);}});
}
