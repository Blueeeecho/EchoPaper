import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {EditorBarrier,EmitEvent} from '../../shared/types';
import {HttpError,registeredRoot,relativePath} from '../security';
interface Session{id:string;root:string;projectId:string;path:string;dirty:boolean;bufferVersion:number;seen:number}
interface Pending{root:string;barrier:EditorBarrier;required:Set<string>;acks:Map<string,boolean>;resolve:()=>void}
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
 const publish=publishers.get(root)||(()=>{}),id=randomUUID(),barrier:EditorBarrier={id,paths,expiresAt:Date.now()+5000};let wake!:()=>void;
 const wait=new Promise<void>(r=>wake=r),entry:Pending={root,barrier,required:new Set(relevant.map(s=>s.id)),acks:new Map(),resolve:wake};pending.set(id,entry);
 let renewal:ReturnType<typeof setInterval>|undefined;
 const assertActive=()=>{if(signal?.aborted||Date.now()>=barrier.expiresAt||!pending.has(id))throw new HttpError(409,'编辑器提交租约已过期，停止写入并保留修改。');if(entry.acks.size!==entry.required.size||[...entry.acks.values()].some(v=>!v))throw new HttpError(409,'编辑器状态已变化，停止写入并保留修改。');};
 const release=Object.assign(()=>{clearInterval(renewal);pending.delete(id);publish({type:'editor.release',projectId:relevant[0].projectId,barrier});},{assertActive});
 publish({type:'editor.barrier',projectId:relevant[0].projectId,barrier});
 let timer:ReturnType<typeof setTimeout>|undefined;const abort=()=>wake();signal?.addEventListener('abort',abort,{once:true});
 try{await Promise.race([wait,new Promise<void>(r=>timer=setTimeout(r,5000))]);if(signal?.aborted||entry.acks.size!==entry.required.size||[...entry.acks.values()].some(v=>!v))throw new HttpError(409,'编辑器仍有未同步内容或未确认提交，已保留双方修改。请回到编辑器处理后恢复任务。');assertActive();renewal=setInterval(()=>{barrier.expiresAt=Date.now()+5000;publish({type:'editor.barrier',projectId:relevant[0].projectId,barrier});},2000);renewal.unref();return release;}
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
  remember({id:b.id,root,projectId:req.params.id,...next,seen:Date.now()});return{ok:true};
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
 app.post<{Params:{id:string;sessionId:string};Body:{barrierId:string;bufferVersion:number;clean:boolean}}>('/api/projects/:id/editor-sessions/:sessionId/ack',async req=>{
  const root=await registeredRoot(workspaceRoot,req.params.id),s=sessions.get(req.params.sessionId),b=req.body,p=pending.get(b?.barrierId);
  if(!s||s.root!==root||!p||p.root!==root||!p.required.has(s.id)||typeof b.clean!=='boolean'||!Number.isSafeInteger(b.bufferVersion)||b.bufferVersion<s.bufferVersion)throw new HttpError(409,'编辑器提交屏障已失效。');
  s.dirty=!b.clean;s.bufferVersion=b.bufferVersion;s.seen=Date.now();p.acks.set(s.id,b.clean);if(p.acks.size===p.required.size)p.resolve();return{ok:true};
 });
 app.addHook('onClose',async()=>{for(const root of roots){for(const [id,s] of sessions)if(s.root===root)sessions.delete(id);for(const [id,p] of pending)if(p.root===root){pending.delete(id);p.resolve();}publishers.delete(root);closedSessions.delete(root);}});
}
