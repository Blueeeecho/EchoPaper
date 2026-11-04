import fs from 'node:fs/promises';
import path from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { AgentConversationMessage, AgentRun, AgentRunDetail, RunEvent, ToolCall } from '../../shared/agent-types';
import type {ModelMessage} from './model-gateway';
import { assertNoSymlinks, HttpError } from '../security';

export interface StoredRuntime { [key:string]:unknown }
export type ConversationSeedSource = 'empty' | 'chat' | 'runs';
export interface ConversationProjection {throughRunId:string;messages:ModelMessage[]}
export interface StoredConversation {id:string;seedHistory:AgentConversationMessage[];lastRunId:string|null;source:ConversationSeedSource;createdAt:string;contextProjection?:ConversationProjection}
export interface ConversationReservation {conversationId:string;expectedLastRunId:string|null;seedHistory:AgentConversationMessage[];source:ConversationSeedSource}
const activeConversationStatuses=new Set(['queued','running','cancelling','waiting_confirmation']);
function stableJson(value:unknown):string {
 return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
}
export const sameStoredInput=(a:unknown,b:unknown)=>stableJson(a)===stableJson(b);
function projectionMessages(value:unknown):ModelMessage[]{
 const invalid=()=>{throw new HttpError(409,'会话上下文投影无效或工具调用没有成对结束；原始历史仍保留。');};
 if(!Array.isArray(value)||!value.length)invalid();const messages=value as ModelMessage[],pending=new Set<string>();
 for(const message of messages){
  if(!message||typeof message!=='object'||!['user','assistant','tool'].includes(message.role)||Object.keys(message).some(key=>!['role','content','reasoning_content','tool_calls','tool_call_id'].includes(key)))invalid();
  if(message.role==='tool'){
   if(typeof message.content!=='string'||typeof message.tool_call_id!=='string'||!pending.delete(message.tool_call_id)||message.tool_calls!==undefined||message.reasoning_content!==undefined)invalid();continue;
  }
  if(pending.size||message.tool_call_id!==undefined||message.content!==null&&typeof message.content!=='string'||message.reasoning_content!==undefined&&(message.role!=='assistant'||typeof message.reasoning_content!=='string'))invalid();
  if(message.role==='user'&&(typeof message.content!=='string'||message.tool_calls!==undefined))invalid();
  if(message.tool_calls!==undefined){
   if(message.role!=='assistant'||!Array.isArray(message.tool_calls)||!message.tool_calls.length)invalid();
   for(const call of message.tool_calls!){
    if(!call||typeof call!=='object'||call.type!=='function'||typeof call.id!=='string'||!call.id||pending.has(call.id)||Object.keys(call).some(key=>!['id','type','function'].includes(key))||!call.function||Object.keys(call.function).some(key=>!['name','arguments'].includes(key))||typeof call.function.name!=='string'||!call.function.name||typeof call.function.arguments!=='string')invalid();
    let args:unknown;try{args=JSON.parse(call.function.arguments);}catch{invalid();}if(!args||typeof args!=='object'||Array.isArray(args))invalid();pending.add(call.id);
   }
  }else if(message.content===null)invalid();
 }
 if(pending.size)invalid();return structuredClone(messages);
}
function readProjection(raw:string|null):ConversationProjection|undefined{
 if(!raw)return;try{const parsed=JSON.parse(raw);if(!parsed||typeof parsed.throughRunId!=='string'||!parsed.throughRunId||parsed.throughRunId.length>100||Object.keys(parsed).some(key=>!['throughRunId','messages'].includes(key)))return;return{throughRunId:parsed.throughRunId,messages:projectionMessages(parsed.messages)};}catch{return;}
}
export async function openTaskStore(projectRoot:string,assertAvailable:()=>void=()=>{}) {
 assertAvailable();
 const directory=await assertNoSymlinks(projectRoot,'.workbench',true);await fs.mkdir(directory,{recursive:true,mode:0o700});await assertNoSymlinks(projectRoot,'.workbench');
 const filename=await assertNoSymlinks(projectRoot,'.workbench/agent-state.sqlite',true);assertAvailable();const saver=SqliteSaver.fromConnString(filename),db=saver.db;
 db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL');db.pragma('busy_timeout = 5000');
 db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, runtime TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS agent_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,seq));
 CREATE TABLE IF NOT EXISTS agent_tools (run_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,id));
 CREATE TABLE IF NOT EXISTS agent_model_turns (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS agent_conversations (id TEXT PRIMARY KEY, seed_history TEXT NOT NULL, last_run_id TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS agent_runs_conversation ON agent_runs(json_extract(data,'$.conversationId'));`);
 const hasProjection=()=>db.prepare('PRAGMA table_info(agent_conversations)').all().some((column:{name:string})=>column.name==='context_projection');
 if(!hasProjection())try{db.exec('ALTER TABLE agent_conversations ADD COLUMN context_projection TEXT');}catch(error){if(!hasProjection())throw error;}
 await fs.chmod(filename,0o600);
 const listeners=new Map<string,Set<(event:RunEvent)=>void>>();let closed=false;
 const parse=<T>(row:{data:string}|undefined):T|undefined=>row?JSON.parse(row.data) as T:undefined;
 const get=(id:string):AgentRun|undefined=>parse<AgentRun>(db.prepare('SELECT data FROM agent_runs WHERE id = ?').get(id));
 const conversationRuns=(id:string):AgentRun[]=>db.prepare("SELECT data FROM agent_runs WHERE json_extract(data,'$.conversationId') = ? ORDER BY rowid").all(id).map((row:{data:string})=>JSON.parse(row.data));
 const conversation=(id:string):StoredConversation|undefined=>{const row=db.prepare('SELECT id, seed_history, last_run_id, source, created_at, context_projection FROM agent_conversations WHERE id = ?').get(id)as {id:string;seed_history:string;last_run_id:string|null;source:ConversationSeedSource;created_at:string;context_projection:string|null}|undefined;if(!row)return;const contextProjection=readProjection(row.context_projection);return{id:row.id,seedHistory:JSON.parse(row.seed_history),lastRunId:row.last_run_id,source:row.source,createdAt:row.created_at,...(contextProjection?{contextProjection}:{})};};
 const assertConversationHead=(run:AgentRun)=>{if(!run.conversationId)return;const current=conversation(run.conversationId),head=current?.lastRunId??conversationRuns(run.conversationId).at(-1)?.id??null;if(head!==run.id)throw new HttpError(409,'此会话已有后续请求，不能恢复或提交旧轮；请在当前会话继续。',{lastRunId:head});};
 const save=(run:AgentRun,runtime?:StoredRuntime)=>{if(closed)throw Error('任务存储已关闭。');run.updatedAt=new Date().toISOString();run.version++;if(runtime===undefined)db.prepare('UPDATE agent_runs SET data = ? WHERE id = ?').run(JSON.stringify(run),run.id);else db.prepare('UPDATE agent_runs SET data = ?, runtime = ? WHERE id = ?').run(JSON.stringify(run),JSON.stringify(runtime),run.id);};
 const event=(run:AgentRun,type:string,data:unknown,agentId?:string):RunEvent=>{const value:RunEvent={runId:run.id,seq:run.lastEventSeq+1,type,createdAt:new Date().toISOString(),data,...(agentId?{agentId}:{})};db.transaction(()=>{run.lastEventSeq=value.seq;save(run);db.prepare('INSERT INTO agent_events(run_id,seq,data) VALUES(?,?,?)').run(run.id,value.seq,JSON.stringify(value));})();for(const listener of listeners.get(run.id)||[])try{listener(value);}catch{}return value;};
 const events=(id:string,after=0,limit=2000):RunEvent[]=>db.prepare('SELECT data FROM agent_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(id,after,Math.min(2000,limit)).map((row:{data:string})=>JSON.parse(row.data));
 const tools=(id:string):ToolCall[]=>db.prepare('SELECT data FROM agent_tools WHERE run_id = ? ORDER BY rowid').all(id).map((row:{data:string})=>JSON.parse(row.data));
 const create=(run:AgentRun,runtime:StoredRuntime,reservation?:ConversationReservation):AgentRun=>{
  if(closed)throw Error('任务存储已关闭。');
  try{return db.transaction(()=>{
   const previous=parse<AgentRun>(db.prepare('SELECT data FROM agent_runs WHERE request_id = ?').get(run.requestId));
   if(previous){const saved=db.prepare('SELECT runtime FROM agent_runs WHERE id = ?').get(previous.id)as {runtime:string},oldInput=(JSON.parse(saved.runtime)as StoredRuntime).input,newInput=runtime.input;
    const identity=(value:AgentRun)=>({conversationId:value.conversationId,input:value.input,targetId:value.targetId,modelId:value.modelId});
    if(previous.conversationId!==run.conversationId||!sameStoredInput(oldInput??identity(previous),newInput??identity(run)))throw new HttpError(409,'此请求编号已经用于不同任务。');return previous;
   }
   if(run.conversationId&&!reservation&&conversation(run.conversationId))throw new HttpError(409,'已归属会话的新请求必须携带会话预约。');
   if(reservation){
    if(!run.conversationId||reservation.conversationId!==run.conversationId)throw new HttpError(409,'会话预约与本轮归属不一致。');
    const current=conversation(run.conversationId),runs=conversationRuns(run.conversationId),head=current?.lastRunId??runs.at(-1)?.id??null;
    if(head!==reservation.expectedLastRunId)throw new HttpError(409,'会话已经收到新的请求，请重新读取并比较后发送。',{lastRunId:head});
    if(runs.some(value=>activeConversationStatuses.has(value.status)))throw new HttpError(409,'此会话尚有运行或等待决定的请求，请先完成或停止它。',{lastRunId:head});
    if(current)db.prepare('UPDATE agent_conversations SET last_run_id = ? WHERE id = ?').run(run.id,run.conversationId);
    else db.prepare('INSERT INTO agent_conversations(id,seed_history,last_run_id,source,created_at) VALUES(?,?,?,?,?)').run(run.conversationId,JSON.stringify(reservation.seedHistory),run.id,reservation.source,run.createdAt);
   }
   db.prepare('INSERT INTO agent_runs(id,request_id,data,runtime) VALUES(?,?,?,?)').run(run.id,run.requestId,JSON.stringify(run),JSON.stringify(runtime));return run;
  }).immediate();}catch(error){if(error instanceof HttpError)throw error;if(String((error as Error).message).includes('UNIQUE'))throw new HttpError(409,'任务请求编号已存在。');throw error;}
 };
 const installConversationProjection=(run:AgentRun,messages:ModelMessage[]):boolean=>{
  if(closed)throw Error('任务存储已关闭。');return db.transaction(()=>{
   const saved=get(run.id);if(!saved||saved.status!=='completed'||!saved.conversationId||saved.conversationId!==run.conversationId||conversation(saved.conversationId)?.lastRunId!==saved.id)return false;
   if(!Array.isArray(messages))throw new HttpError(409,'会话投影消息无效，原始历史仍保留。');
   const projected=projectionMessages(messages.filter(message=>message?.role!=='system')),raw=db.prepare('SELECT runtime FROM agent_runs WHERE id = ?').get(saved.id)as {runtime:string},runtime=JSON.parse(raw.runtime)as StoredRuntime;
   if((runtime.input as {conversationId?:string}|undefined)?.conversationId!==saved.conversationId||!Array.isArray(runtime.messages)||!sameStoredInput(projectionMessages(runtime.messages.filter((message:ModelMessage)=>message?.role!=='system')),projected))throw new HttpError(409,'会话投影不是本轮已保存的模型上下文，原始历史仍保留。');
   return db.prepare('UPDATE agent_conversations SET context_projection = ? WHERE id = ? AND last_run_id = ?').run(JSON.stringify({throughRunId:saved.id,messages:projected} satisfies ConversationProjection),saved.conversationId,saved.id).changes===1;
  }).immediate();
 };
 return {filename,saver,get,save,event,events,tools,create,conversation,conversationRuns,assertConversationHead,installConversationProjection,
  list:():AgentRun[]=>db.prepare('SELECT data FROM agent_runs ORDER BY rowid DESC LIMIT 200').all().map((row:{data:string})=>JSON.parse(row.data)),
  byRequest:(id:string):AgentRun|undefined=>parse<AgentRun>(db.prepare('SELECT data FROM agent_runs WHERE request_id = ?').get(id)),
  runtime:(id:string):StoredRuntime=>{const row=db.prepare('SELECT runtime FROM agent_runs WHERE id = ?').get(id) as {runtime:string}|undefined;if(!row)throw new HttpError(404,'任务不存在。');return JSON.parse(row.runtime);},
  tool:(id:string,tool:ToolCall)=>db.prepare('INSERT INTO agent_tools(run_id,id,data) VALUES(?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET data=excluded.data').run(id,tool.id,JSON.stringify(tool)),
  getTool:(runId:string,id:string):ToolCall|undefined=>parse<ToolCall>(db.prepare('SELECT data FROM agent_tools WHERE run_id = ? AND id = ?').get(runId,id)),
  archiveModel:(runId:string,agentId:string,data:unknown)=>db.prepare('INSERT INTO agent_model_turns(run_id,agent_id,data) VALUES(?,?,?)').run(runId,agentId,JSON.stringify(data)),
  detail:(id:string):AgentRunDetail=>{const run=get(id);if(!run)throw new HttpError(404,'任务不存在。');return{run,events:events(id),tools:tools(id)};},
  subscribe:(id:string,listener:(event:RunEvent)=>void)=>{let set=listeners.get(id);if(!set){set=new Set();listeners.set(id,set);}set.add(listener);return()=>{set!.delete(listener);if(!set!.size)listeners.delete(id);};},
  flush:()=>{if(!closed)db.pragma('wal_checkpoint(TRUNCATE)');},
  close:()=>{if(closed)return;listeners.clear();db.pragma('wal_checkpoint(TRUNCATE)');db.close();closed=true;}
 };
}
export type TaskStore=Awaited<ReturnType<typeof openTaskStore>>;
