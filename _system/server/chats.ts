import {validCheckpoint} from '../shared/ai-context';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { EmitEvent } from '../shared/types.ts';
import { HttpError, assertNoSymlinks, registeredRoot } from './security.ts';
import { atomicWrite, hash, preserveRecovery, withLock } from './storage.ts';
import {conversationState,ensureActiveChat,type PersistedChat} from '../shared/chat-merge';
import {workspaceMaintenance} from './agents/maintenance';
import {validAgentAttachment,attachmentMetadata} from '../shared/attachment-types';

const relative = 'notes/ai-conversations.json';
const limit = 128 * 1024 * 1024;
type JsonObject = Record<string, any>;
type ChatLifecycle={state:'active'|'archived'|'deleted';revision:number;updatedAt:string};
const object = (value: unknown): JsonObject => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '对话数据无效。'); return value as JsonObject; };
function string(value: unknown, max: number, label: string): string { if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${label}无效或过长。`); return value; }
function date(value: unknown): string { const result = string(value, 80, '时间'); if (!Number.isFinite(Date.parse(result))) throw new HttpError(400, '对话时间无效。'); return result; }
function attachments(value:unknown){if(!Array.isArray(value)||value.length>20||value.some(item=>!validAgentAttachment(item))||new Set(value.map(item=>item.id)).size!==value.length)throw new HttpError(400,'对话附件列表无效。');return value.map(attachmentMetadata);}
function lifecycle(value:unknown):ChatLifecycle {
  const source=object(value);
  if(!['active','archived','deleted'].includes(source.state)||!Number.isSafeInteger(source.revision)||source.revision<1)throw new HttpError(400,'对话生命周期无效。');
  return{state:source.state,revision:source.revision,updatedAt:date(source.updatedAt)};
}
/** Admission uses only lifecycle metadata, including minimal legacy chat records. */
export async function assertConversationActive(root:string,conversationId?:string):Promise<void>{
  if(!conversationId)return;
  const filename=await assertNoSymlinks(root,relative,true);let data:JsonObject;
  try{
    const stat=await fs.stat(filename);if(!stat.isFile()||stat.size>limit)throw new HttpError(413,'对话文件无效或超过 128 MB。');
    data=JSON.parse(await fs.readFile(filename,'utf8'));
    if(data?.version!==1||!Array.isArray(data.conversations))throw new Error('Invalid chat header');
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;if(error instanceof HttpError)throw error;throw new HttpError(409,'无法核对对话状态，原记录已保留；请先修复对话文件。');}
  const matches=data.conversations.filter((conversation:any)=>conversation?.id===conversationId);
  if(matches.length>1)throw new HttpError(409,'对话编号重复，不能继续执行。');
  const conversation=matches[0];if(!conversation||conversation.lifecycle===undefined)return;
  let state:ChatLifecycle;try{state=lifecycle(conversation.lifecycle);}catch{throw new HttpError(409,'对话生命周期无效，原记录已保留。');}
  if(state.state!=='active')throw new HttpError(409,state.state==='deleted'?'此对话已在回收站，请恢复后继续。':'此对话已归档，请恢复后继续。',{conversationId,lifecycle:state});
}
export function validateChatData(value: unknown): JsonObject {
  const data = object(value);
  if (data.version !== 1 || !Array.isArray(data.conversations) || !data.conversations.length) throw new HttpError(400, '对话列表无效。');
  const ids = new Set<string>();
  const conversations = data.conversations.map((raw: unknown) => {
    const c = object(raw), id = string(c.id, 100, '对话编号');
    if (!id || ids.has(id) || !Array.isArray(c.messages) || c.messages.length > 20000) throw new HttpError(400, '对话编号或消息列表无效。'); ids.add(id);
    if (!['low','medium','high','xhigh','max'].includes(c.effort)) throw new HttpError(400, '思考强度无效。');
    const messageIds = new Set<string>();
    const messages = c.messages.map((rawMessage: unknown) => {
      const m = object(rawMessage), messageId = string(m.id,100,'消息编号');
      if (!messageId || messageIds.has(messageId) || !['user','assistant'].includes(m.role) || !['complete','streaming','stopped','error'].includes(m.status)) throw new HttpError(400,'消息格式无效。'); messageIds.add(messageId);
      const result: JsonObject = {id:messageId, role:m.role, content:string(m.content,16_000_000,'消息'), createdAt:date(m.createdAt), status:m.status};
      for (const [key,max] of [['reasoning_content',16_000_000],['model',100],['providerLabel',100],['finishReason',100],['error',10000],['contextPath',1000],['taskId',100]] as const) if (m[key] !== undefined) result[key] = string(m[key],max,'消息字段');
      if (m.attachment !== undefined) { const a=object(m.attachment); result.attachment={path:string(a.path,1000,'附件路径'),content:string(a.content,4_000_000,'附件内容')}; }
      if (m.attachments !== undefined) result.attachments=attachments(m.attachments);
      if (m.usage !== undefined) { const usage=object(m.usage); result.usage={}; for(const key of ['prompt_tokens','completion_tokens','total_tokens']) { const n=usage[key]; if (!Number.isSafeInteger(n)||n<0||n>1_000_000_000) throw new HttpError(400,'用量数据无效。');result.usage[key]=n; } }
      return result;
    });
    if(c.contextState!==undefined&&!validCheckpoint(c.contextState))throw new HttpError(400,'上下文摘要格式无效。');
    if(c.contextUsage!==undefined){const u=object(c.contextUsage);if(typeof u.throughMessageId!=='string'||u.throughMessageId.length>100||typeof u.fingerprint!=='string'||!/^[a-f0-9]{16}$/.test(u.fingerprint)||typeof u.model!=='string'||u.model.length>100||typeof u.checkpointId!=='string'||u.checkpointId.length>100||!Number.isSafeInteger(u.tokens)||u.tokens<0||u.tokens>1e9)throw new HttpError(400,'上下文用量无效。');}
    return {...(c.lifecycle===undefined?{}:{lifecycle:lifecycle(c.lifecycle)}),...(c.pendingAttachments!==undefined?{pendingAttachments:attachments(c.pendingAttachments)}:{}),...(c.contextState?{contextState:Object.fromEntries(['id','summary','throughMessageId','sourceFingerprint','messageCount','createdAt','model','beforeTokens','afterTokens','round'].map(key=>[key,c.contextState[key]]))}:{}),...(c.contextUsage?{contextUsage:{throughMessageId:c.contextUsage.throughMessageId,fingerprint:c.contextUsage.fingerprint,model:c.contextUsage.model,checkpointId:c.contextUsage.checkpointId,tokens:c.contextUsage.tokens}}:{}),id,title:string(c.title,2000,'对话标题'),createdAt:date(c.createdAt),updatedAt:date(c.updatedAt),messages,input:string(c.input ?? '',200000,'输入草稿'),model:string(c.model,100,'模型'),effort:c.effort};
  });
  if(conversations.filter(conversation=>conversationState(conversation)==='active').length>500)throw new HttpError(400,'未归档对话最多 500 条。');
  const selectedId = string(data.selectedId,100,'当前对话');
  if (!ids.has(selectedId)) throw new HttpError(400,'当前对话不存在。');
  const result={version:1,selectedId,conversations};
  if (Buffer.byteLength(JSON.stringify(result)) > limit) throw new HttpError(413,'对话数据超过 128 MB，请导出并整理较早对话。');
  return result;
}
async function readChats(root: string): Promise<{data: JsonObject | null; hash: string | null}> {
  const file=await assertNoSymlinks(root,relative,true);
  try { const stat=await fs.stat(file);if(!stat.isFile()||stat.size>limit) throw new HttpError(413,'对话文件无效或超过 128 MB。');const content=await fs.readFile(file,'utf8');let data;try{data=validateChatData(JSON.parse(content));}catch{throw new HttpError(409,'本地对话文件格式无效，原文件已保留。');}return {data,hash:hash(content)}; }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return {data:null,hash:null};throw error; }
}
function expectedHash(value:unknown):string|null {
  if(value!==null&&(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)))throw new HttpError(400,'保存对话需要版本校验值。');
  return value;
}
export async function registerChatRoutes(app: FastifyInstance,workspaceRoot:string,emit:EmitEvent,options:{conversationBusy:(projectId:string,conversationId:string)=>Promise<boolean>}) {
  const maintenance=workspaceMaintenance(workspaceRoot);
  async function changeChats(root:string,expected:string|null,update:(data:JsonObject|null)=>Promise<JsonObject>|JsonObject){
    return withLock(`agent-lifecycle:${root}`,()=>withLock(`file:${root}:${relative}`,async()=>{
      maintenance.assertAvailable();const current=await readChats(root);
      if(current.hash!==expected)throw new HttpError(409,'对话已被其他窗口修改，已保留当前窗口内容。',{current});
      const data=validateChatData(ensureActiveChat(await update(current.data) as unknown as PersistedChat)),content=JSON.stringify(data)+'\n';
      if(Buffer.byteLength(content)>limit)throw new HttpError(413,'对话文件超过 128 MB。');
      const filename=await assertNoSymlinks(root,relative,true);await fs.mkdir(path.dirname(filename),{recursive:true});await assertNoSymlinks(root,relative,true);
      maintenance.assertAvailable();if(current.data)await preserveRecovery(root,relative,JSON.stringify(current.data,null,2)+'\n');
      const latest=await readChats(root);if(latest.hash!==expected)throw new HttpError(409,'对话在保存期间变化，请比较后再保存。',{current:latest});
      maintenance.assertAvailable();await atomicWrite(filename,content);return{data,hash:hash(content)};
    }));
  }
  app.get<{Params:{id:string}}>('/api/projects/:id/chats', async request => readChats(await registeredRoot(workspaceRoot,request.params.id)));
  app.put<{Params:{id:string};Body:{data:unknown;expectedHash:unknown}}>('/api/projects/:id/chats',{bodyLimit:limit+65536},async request=>{
    maintenance.assertAvailable();
    const root=await registeredRoot(workspaceRoot,request.params.id), body=object(request.body);
    const data=validateChatData(body.data),expected=expectedHash(body.expectedHash);
    const result=await changeChats(root,expected,current=>{
      const prior=new Map((current?.conversations||[]).map((conversation:JsonObject)=>[conversation.id,conversation])),seen=new Set<string>();
      const conversations=data.conversations.map((conversation:JsonObject)=>{
        seen.add(conversation.id);const {lifecycle:requestedLifecycle,...fields}=conversation,previous=prior.get(conversation.id) as JsonObject|undefined;
        // Existing ids change state only through PATCH. New imported histories may
        // start hidden, including conflict drafts copied from a hidden conversation.
        const initialLifecycle=previous?previous.lifecycle:requestedLifecycle&&requestedLifecycle.state!=='active'?{state:requestedLifecycle.state,revision:1,updatedAt:new Date().toISOString()}:undefined;
        return{...fields,...(initialLifecycle?{lifecycle:initialLifecycle}:{})};
      });
      for(const conversation of prior.values())if(!seen.has((conversation as JsonObject).id))conversations.push(conversation);
      return{...data,conversations};
    });emit({type:'file.changed',projectId:request.params.id,path:relative});return result;
  });
  app.patch<{Params:{id:string;conversationId:string};Body:{action:unknown;expectedHash:unknown}}>('/api/projects/:id/chats/:conversationId',async request=>{
    maintenance.assertAvailable();const root=await registeredRoot(workspaceRoot,request.params.id),body=object(request.body),expected=expectedHash(body.expectedHash);
    if(Object.keys(body).some(key=>key!=='action'&&key!=='expectedHash')||!['archive','delete','restore'].includes(body.action))throw new HttpError(400,'对话操作必须为归档、删除或恢复。');
    const result=await changeChats(root,expected,async current=>{
      const conversation=current?.conversations.find((item:JsonObject)=>item.id===request.params.conversationId);if(!conversation)throw new HttpError(404,'对话不存在。');
      const state=conversationState(conversation),next=body.action==='restore'?'active':body.action==='archive'?'archived':'deleted';
      if(body.action==='archive'&&state==='deleted')throw new HttpError(409,'请先恢复回收站中的对话，再归档。');
      if(next!=='active'&&await options.conversationBusy(request.params.id,conversation.id))throw new HttpError(409,'此对话仍有运行或等待确认的任务，请先停止或完成它。');
      if(next===state)return current!;
      const revision=(conversation.lifecycle?.revision||0)+1;if(!Number.isSafeInteger(revision))throw new HttpError(409,'对话生命周期版本已超出范围。');
      const updatedAt=new Date(Math.max(Date.now(),conversation.lifecycle?Date.parse(conversation.lifecycle.updatedAt)+1:0)).toISOString();
      return{...current,conversations:current!.conversations.map((item:JsonObject)=>item.id===conversation.id?{...item,updatedAt,lifecycle:{state:next,revision,updatedAt}}:item)};
    });emit({type:'file.changed',projectId:request.params.id,path:relative});return result;
  });
}
